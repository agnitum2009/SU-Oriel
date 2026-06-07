import type { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";

import { prisma } from "../../db/prisma.js";
import { CcbdClientService } from "../ccbd-client/ccbd-client.service.js";
import type { CcbdSubmitResponse } from "../ccbd-client/ccbd-client.types.js";
import { primitiveExecutor } from "../primitive/primitive-wrapper.js";
import { claudeAgentForSlot } from "../slot-binding/job-slot-router.js";
import { SlotBindingService, isSlotId, type SlotId } from "../slot-binding/slot-binding.service.js";
import {
  NoPendingIntentError,
  UserIntentValidationError
} from "./user-intent.errors.js";
import {
  USER_INTENT_TYPES,
  type StopAndAppendInput,
  type UserIntentType
} from "./user-intent.types.js";

export interface UserIntentRouteDependencies {
  prismaClient?: PrismaClient;
  slotRuntime?: UserIntentSlotRuntime;
}

interface StopAndAppendValidated extends StopAndAppendInput {
  ccbJobId: string | null;
}

type UserIntentSlotRuntime = {
  cancel(input: { projectRoot: string; jobId: string }): Promise<Record<string, unknown>>;
  submit(input: {
    projectRoot: string;
    slotId: SlotId;
    toAgent: string;
    taskId: string;
    body: string;
  }): Promise<Pick<CcbdSubmitResponse, "jobId" | "traceRef">>;
};

type SlotTaskContext = {
  projectId: string;
  projectRoot: string;
  taskKey: string;
  requirementId: string | null;
  slotId: SlotId | null;
  slotState: string | null;
};

function validateInput(body: unknown): StopAndAppendValidated {
  if (!body || typeof body !== "object") {
    throw new UserIntentValidationError("请求体必须是 JSON 对象");
  }
  const obj = body as Record<string, unknown>;
  const intentType = obj.intentType;
  const text = obj.body;
  if (typeof intentType !== "string" || !USER_INTENT_TYPES.includes(intentType as UserIntentType)) {
    throw new UserIntentValidationError(
      `intentType 必须是 ${USER_INTENT_TYPES.join(" / ")} 之一`
    );
  }
  if (typeof text !== "string" || text.trim().length === 0) {
    throw new UserIntentValidationError("body 不能为空");
  }
  if (text.length > 5000) {
    throw new UserIntentValidationError("body 不能超过 5000 字");
  }
  const ccbJobIdRaw = obj.ccbJobId;
  const ccbJobId =
    typeof ccbJobIdRaw === "string" && ccbJobIdRaw.trim().length > 0
      ? ccbJobIdRaw.trim()
      : null;
  return {
    intentType: intentType as UserIntentType,
    body: text.trim(),
    ccbJobId
  };
}

async function resolveSlotTaskContext(
  db: PrismaClient,
  taskId: string
): Promise<SlotTaskContext | null> {
  const task = await db.task.findUnique({
    where: { id: taskId },
    include: { project: { select: { localPath: true, slotCount: true } } }
  });
  if (!task) {
    return null;
  }
  const binding = await new SlotBindingService(db).resolveSlotForSubtask(taskId);
  const slotId = binding?.slotId && isSlotId(binding.slotId, task.project.slotCount) ? binding.slotId : null;
  return {
    projectId: task.projectId,
    projectRoot: task.project.localPath,
    taskKey: task.taskKey,
    requirementId: task.requirementId,
    slotId,
    slotState: binding?.state ?? null
  };
}

function defaultSlotRuntime(): UserIntentSlotRuntime {
  return {
    cancel: async ({ projectRoot, jobId }) => {
      return await new CcbdClientService({ projectRoot }).cancel(jobId);
    },
    submit: async ({ projectRoot, toAgent, taskId, body }) => {
      const result = await new CcbdClientService({ projectRoot }).submit({
        toAgent,
        taskId,
        body,
        fromActor: "system",
        messageType: "ask"
      });
      return {
        jobId: result.jobId,
        traceRef: result.traceRef
      };
    }
  };
}

export async function registerUserIntentRoutes(
  app: FastifyInstance,
  dependencies: UserIntentRouteDependencies = {}
): Promise<void> {
  const db = dependencies.prismaClient ?? prisma;
  const slotRuntime = dependencies.slotRuntime ?? defaultSlotRuntime();

  app.post("/api/tasks/:taskId/stop-and-append", async (request, reply) => {
    const { taskId } = request.params as { taskId: string };

    let input: StopAndAppendValidated;
    try {
      input = validateInput(request.body);
    } catch (e) {
      reply.status(400);
      return { message: e instanceof Error ? e.message : "参数不合法" };
    }

    const slotContext = await resolveSlotTaskContext(db, taskId);
    if (!slotContext) {
      reply.status(404);
      return { message: "任务不存在" };
    }

    // 1) Best-effort cancel：仅当客户端传了 ccbJobId 且 sticky slot 已绑定时
    let cancelledJobId: string | null = null;
    if (slotContext.slotId && input.ccbJobId) {
      try {
        await slotRuntime.cancel({
          projectRoot: slotContext.projectRoot,
          jobId: input.ccbJobId
        });
        cancelledJobId = input.ccbJobId;
      } catch (error) {
        request.log.warn(
          { event: "user-intent.cancel-failed", slotId: slotContext.slotId, jobId: input.ccbJobId, err: error },
          "slot ccbd cancel failed; UserIntent will still be recorded"
        );
      }
    }

    // 2) Insert UserIntent + sticky slot busy -> bound；SlotBinding 不表达 dirty 状态。
    const result = await db.$transaction(async (tx) => {
      const intent = await primitiveExecutor.run({
        primitive: "record_user_intent",
        mutationType: "prisma.userIntent.create",
        idempotencyKey: `${taskId}:user_intent:${input.intentType}:${input.ccbJobId ?? "manual"}`,
        run: async () =>
          await tx.userIntent.create({
            data: {
              taskId,
              ccbJobId: input.ccbJobId,
              intentType: input.intentType,
              body: input.body
            }
          })
      });

      let slotState: string | null = slotContext.slotState;
      if (slotContext.slotId) {
        const slotId = slotContext.slotId;
        const updated = await primitiveExecutor.run({
          primitive: "mark_slot_bound_for_user_intent",
          mutationType: "prisma.slotBinding.update",
          idempotencyKey: `${taskId}:${slotId}:stop-and-append-slot-bound:${intent.id}`,
          run: async () =>
            await tx.slotBinding.update({
              where: {
                projectId_slotId: {
                  projectId: slotContext.projectId,
                  slotId
                }
              },
              data: {
                state: "bound",
                busySince: null,
                lastActivityAt: new Date()
              }
            })
        });
        slotState = updated.state;
      }

      return { intent, slotState };
    });

    return {
      intentId: result.intent.id,
      cancelledJobId,
      slotId: slotContext.slotId,
      slotState: result.slotState
    };
  });

  app.post("/api/tasks/:taskId/resume", async (request, reply) => {
    const { taskId } = request.params as { taskId: string };

    const slotContext = await resolveSlotTaskContext(db, taskId);
    if (!slotContext) {
      reply.status(404);
      return { message: "任务不存在" };
    }

    const pendingIntent = await db.userIntent.findFirst({
      where: { taskId, consumedAt: null },
      orderBy: { createdAt: "asc" }
    });

    if (!pendingIntent) {
      reply.status(409);
      return { message: new NoPendingIntentError(taskId).message };
    }

    // 复用 sticky slot；不自动抢新 slot。抢 slot 在 JobSlotRouter 主调度路径。
    if (!slotContext.slotId) {
      reply.status(409);
      return {
        message:
          "尚未绑定 slot，无法 resume。请先通过需求调度绑定一个业务 slot。"
      };
    }

    // project ccbd submit：让 sticky slot window 内 claude agent 跑 /ccb:su-resume；
    // skill 自身负责读 user_intent 表并在处理完后标 consumedAt
    let submitJobId: string | null = null;
    try {
      const submitResponse = await slotRuntime.submit({
        projectRoot: slotContext.projectRoot,
        slotId: slotContext.slotId,
        toAgent: claudeAgentForSlot(slotContext.slotId),
        taskId: slotContext.taskKey,
        body: `/ccb:su-resume task_id=${taskId} intent_id=${pendingIntent.id}`
      });
      submitJobId = submitResponse.jobId ?? null;
    } catch (error) {
      request.log.error(
        { event: "user-intent.resume-ask-failed", slotId: slotContext.slotId, err: error },
        "slot ccbd submit failed during resume"
      );
      reply.status(502);
      return {
        message:
          error instanceof Error
            ? `恢复失败：${error.message}`
            : "slot ask 失败，请检查 slot runtime 状态"
      };
    }

    const updated = await new SlotBindingService(db).markBusy(slotContext.projectId, slotContext.slotId);

    return {
      slotId: updated.slotId,
      slotState: updated.state,
      jobId: submitJobId,
      intentId: pendingIntent.id,
      intentType: pendingIntent.intentType,
      body: pendingIntent.body
    };
  });

  // 给 UI 用：查询当前任务是否有 pending intent（决定 [恢复] 按钮是否显示）
  app.get("/api/tasks/:taskId/pending-intent", async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    void reply;
    const intent = await db.userIntent.findFirst({
      where: { taskId, consumedAt: null },
      orderBy: { createdAt: "asc" }
    });
    if (!intent) {
      return { pendingIntent: null };
    }
    return {
      pendingIntent: {
        id: intent.id,
        intentType: intent.intentType,
        body: intent.body,
        createdAt: intent.createdAt.toISOString(),
        ccbJobId: intent.ccbJobId
      }
    };
  });
}
