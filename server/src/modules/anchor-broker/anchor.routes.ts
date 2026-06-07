import { basename, dirname, join } from "node:path";

import type { PrismaClient, SlotBinding } from "@prisma/client";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { prisma } from "../../db/prisma.js";
import { assertLocalRequest } from "../ai-cli/ai-cli.guard.js";
import {
  defaultManagedConfigMutationLock,
  type ManagedConfigMutationLock
} from "../project-ccbd/managed-config-mutation-lock.js";
import { JobSlotRouter } from "../slot-binding/job-slot-router.js";
import { SlotBindingService } from "../slot-binding/slot-binding.service.js";
import {
  DEFAULT_SLOT_RESIZE_LOCK_WAIT_TIMEOUT_MS,
  isSlotResizeLockTimeoutError,
  slotResizeLockTimeoutBody,
  waitForSlotResizeLock
} from "../slot-resize/resize-lock.js";
import { AnchorDispatchQueuePolicyError } from "./anchor-dispatch-queue-policy.js";
import { MultiAnchorBrokerService } from "./broker.service.js";
import { NativeAnchorTerminalService } from "../anchor-terminal/native-terminal.service.js";
import type { NativeAnchorTerminalSpawnResult } from "../anchor-terminal/native-terminal.service.js";
import {
  buildRequirementDispatchCommand,
  buildSubtaskDispatchCommand,
  readStructuredDispatchPayload
} from "./structured-dispatch.js";

const ACTIVE_ANCHOR_NODE_IDS = new Set([
  "requirement_analysis",
  "technical_design",
  "task_breakdown",
  "dispatch",
  "implementation",
  "review"
]);
const ANCHOR_WIP_CAPACITY = 10;
const ACTIVE_ANCHOR_STATES = [
  "planned",
  "worktree_creating",
  "configuring",
  "mounting",
  "ready",
  "busy",
  "mount_failed",
  "recovering",
  "orphaned",
  "cleanup_required"
] as const;
const MAX_ANCHOR_DISPATCH_PAYLOAD_BYTES = 64 * 1024;
const MAX_ANCHOR_DISPATCH_PAYLOAD_DEPTH = 8;
const taskLocks = new Map<string, Promise<void>>();

type NativeAnchorTerminalLike = {
  spawn(anchor: {
    anchorId: string;
    projectId: string | null;
    anchorPath: string;
    socketPath: string | null;
  }): Promise<NativeAnchorTerminalSpawnResult>;
};
type JobSlotRouterLike = Pick<JobSlotRouter, "enqueue" | "resolveSlotForSubject">;
type SlotBindingLike = Pick<SlotBindingService, "bindRequirement">;
type AnchorableTask = {
  id: string;
  taskKey: string;
  status: string;
  currentNode: string | null;
  requirementId: string | null;
  project: {
    id: string;
    localPath: string;
  };
};
type AnchorableRequirement = {
  id: string;
  title: string;
  status: string;
  currentPlanningStep: string | null;
  project: {
    id: string;
    localPath: string;
  };
};
type RequirementDispatchPayload = {
  command: string;
  payload: Record<string, unknown>;
};
type BatchSubtask = AnchorableTask & {
  projectId: string;
  requirementId: string | null;
  title: string;
};
type SubtaskBatchCandidate = {
  taskId: string;
  taskKey: string;
  title: string;
  currentNode: string | null;
  status: string;
  hasActiveAnchor: boolean;
  isPendingDispatch: boolean;
  eligible: boolean;
  ineligibleReason: string | null;
};
type SubtaskBatchDispatchItem =
  {
    taskId: string;
    status: "failed";
    errorMessage: string;
  };
type SubtaskDispatchGate = {
  hasActiveAnchor: boolean;
  isPendingDispatch: boolean;
  ineligibleReason: string | null;
};
type SubtaskDispatchGateTask = Pick<AnchorableTask, "id" | "status" | "currentNode"> & {
  project: {
    id: string;
  };
};

export interface AnchorRouteDependencies {
  prismaClient?: PrismaClient;
  broker?: MultiAnchorBrokerService;
  nativeTerminal?: NativeAnchorTerminalLike;
  jobSlotRouter?: JobSlotRouterLike;
  slotBinding?: SlotBindingLike;
  resizeLock?: ManagedConfigMutationLock;
  resizeLockWaitTimeoutMs?: number;
}

export async function registerAnchorRoutes(
  app: FastifyInstance,
  dependencies: AnchorRouteDependencies = {}
): Promise<void> {
  const db = dependencies.prismaClient ?? prisma;
  const broker = dependencies.broker ?? new MultiAnchorBrokerService(db);
  const nativeTerminal = dependencies.nativeTerminal ?? new NativeAnchorTerminalService();
  const resizeLock = dependencies.resizeLock ?? defaultManagedConfigMutationLock;
  const resizeLockWaitTimeoutMs = dependencies.resizeLockWaitTimeoutMs ?? DEFAULT_SLOT_RESIZE_LOCK_WAIT_TIMEOUT_MS;
  const slotBinding = dependencies.slotBinding ?? new SlotBindingService(db);
  const jobSlotRouter = dependencies.jobSlotRouter ?? new JobSlotRouter({
    prismaClient: db,
    slotBinding: slotBinding instanceof SlotBindingService ? slotBinding : new SlotBindingService(db),
    resizeLock,
    resizeLockWaitTimeoutMs
  });

  async function listCompatAnchors(): Promise<Record<string, unknown>[]> {
    const bindings = await db.slotBinding.findMany({
      where: {
        requirementId: {
          not: null
        }
      },
      include: {
        requirement: {
          select: {
            id: true,
            title: true
          }
        }
      },
      orderBy: {
        updatedAt: "desc"
      }
    });
    const legacyRows = await db.anchorAllocation.findMany({
      where: {
        state: {
          not: "destroyed"
        }
      },
      orderBy: {
        updatedAt: "desc"
      }
    });
    const legacyAnchors = await Promise.all(
      legacyRows.map(async (anchor) => serializeAnchor(anchor, await jobSlotRouter.resolveSlotForSubject(anchor.subjectType, anchor.subjectId)))
    );
    return [
      ...bindings.map((binding) =>
        serializeSlotBindingAnchor(binding, binding.requirement ? { id: binding.requirement.id, title: binding.requirement.title } : null)
      ),
      ...legacyAnchors
    ];
  }

  app.get("/api/anchors", async () => {
    return {
      anchors: await listCompatAnchors()
    };
  });

  app.get("/api/epics/:epicId/anchor/preview", async (request, reply) => {
    void request;
    reply.status(410);
    return { message: "Epic anchor 入口已退役，请使用需求规划或子任务执行 anchor。" };
  });

  app.get("/api/tasks/:taskId/anchor/preview", async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    return await previewAnchorForTask(taskId, "task 不存在", reply);
  });

  app.post("/api/epics/:epicId/anchor/start", async (request, reply) => {
    void request;
    reply.status(410);
    return { message: "Epic anchor 入口已退役，请使用需求规划或子任务执行 anchor。" };
  });

  app.post("/api/tasks/:taskId/anchor/start", async (request, reply) => {
    void request;
    return deprecatedAnchorWrite(reply);
  });

  app.post("/api/projects/:projectId/requirements/:requirementId/planning-anchor/start", async (request, reply) => {
    const { projectId, requirementId } = request.params as { projectId: string; requirementId: string };
    return await withTaskLock(requirementId, async () =>
      await startPlanningAnchorForRequirement(projectId, requirementId, reply)
    );
  });

  app.post("/api/projects/:projectId/requirements/:requirementId/anchor-dispatch", async (request, reply) => {
    const { projectId, requirementId } = request.params as { projectId: string; requirementId: string };
    return await withTaskLock(requirementId, async () =>
      await dispatchRequirementPlanningCommand(projectId, requirementId, request, reply)
    );
  });

  app.post("/api/tasks/:taskId/anchor-dispatch", async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    return await withTaskLock(taskId, async () => await dispatchSubtaskExecutionCommand(taskId, request, reply));
  });

  app.get("/api/projects/:projectId/requirements/:requirementId/subtasks/batch-candidates", async (request, reply) => {
    const { projectId, requirementId } = request.params as { projectId: string; requirementId: string };
    const requirement = await findRequirementForAnchor(projectId, requirementId);
    if (!requirement) {
      reply.status(404);
      return { message: "需求不存在" };
    }
    return {
      candidates: await buildSubtaskBatchCandidates(projectId, requirementId)
    };
  });

  app.post("/api/projects/:projectId/requirements/:requirementId/subtasks/batch-dispatch", async (request, reply) => {
    const { projectId, requirementId } = request.params as { projectId: string; requirementId: string };
    return await withTaskLock(requirementId, async () =>
      await dispatchSubtaskBatch(projectId, requirementId, request, reply)
    );
  });

  app.post("/api/epics/:epicId/anchor/stop", async (request, reply) => {
    void request;
    reply.status(410);
    return { message: "Epic anchor 入口已退役，请使用需求规划或子任务执行 anchor。" };
  });

  app.post("/api/tasks/:taskId/anchor/stop", async (request, reply) => {
    void request;
    return deprecatedAnchorWrite(reply);
  });

  app.post("/api/epics/:epicId/anchor/reset", async (request, reply) => {
    void request;
    reply.status(410);
    return { message: "Epic anchor 入口已退役，请使用需求规划或子任务执行 anchor。" };
  });

  app.post("/api/tasks/:taskId/anchor/reset", async (request, reply) => {
    void request;
    return deprecatedAnchorWrite(reply);
  });

  app.post("/api/projects/:projectId/requirements/:requirementId/anchor/reset", async (request, reply) => {
    void request;
    return deprecatedAnchorWrite(reply);
  });

  app.post("/api/anchors/:anchorId/reset", async (request, reply) => {
    void request;
    return deprecatedAnchorWrite(reply);
  });

  app.post("/api/anchors/:anchorId/terminal/spawn", async (request, reply) => {
    const { anchorId } = request.params as { anchorId: string };
    try {
      assertLocalRequest(request);
    } catch (error) {
      reply.status((error as { statusCode?: number }).statusCode ?? 403);
      return { message: "仅本机可用" };
    }

    const anchor = await broker.resolveAnchor(anchorId);
    if (!anchor) {
      reply.status(404);
      return { message: "anchor 已销毁" };
    }

    return await nativeTerminal.spawn(anchor);
  });

  app.post("/api/anchors/:anchorId/runtime/stop", async (request, reply) => {
    void request;
    return deprecatedAnchorWrite(reply);
  });

  app.post("/api/anchors/:anchorId/runtime/resume", async (request, reply) => {
    void request;
    return deprecatedAnchorWrite(reply);
  });

  async function previewAnchorForTask(
    taskId: string,
    missingMessage: string,
    reply: FastifyReply
  ): Promise<Record<string, unknown>> {
    const task = await findTaskForAnchor(taskId);
    if (!task) {
      reply.status(404);
      return { message: missingMessage };
    }
    const kindError = anchorKindError(task);
    if (kindError) {
      reply.status(400);
      return { message: kindError };
    }

    const anchors = await db.anchorAllocation.findMany({
      where: {
        state: {
          not: "destroyed"
        }
      },
      orderBy: {
        updatedAt: "desc"
      }
    });
    const activeAnchors = anchors.filter((anchor) =>
      ACTIVE_ANCHOR_STATES.includes(anchor.state as (typeof ACTIVE_ANCHOR_STATES)[number])
    );
    const bound = activeAnchors.find((anchor) => anchor.subjectType === "subtask" && anchor.subjectId === task.id) ?? null;
    const used = activeAnchors.length;
    const free = Math.max(ANCHOR_WIP_CAPACITY - used, 0);
    const full = !bound && free === 0;

    return {
      subjectType: "subtask",
      subjectId: task.id,
      epicId: task.id,
      anchorPath: buildDefaultAnchorPath(task.project.localPath, task.id),
      canStart: Boolean(bound) || !full,
      queuePosition: full ? 1 : null,
      estimatedWait: full ? "等待任一 anchor 归档" : null,
      pool: {
        capacity: ANCHOR_WIP_CAPACITY,
        used,
        free,
        full
      },
      anchors: anchors.map((anchor) => serializeAnchor(anchor))
    };
  }

  async function startPlanningAnchorForRequirement(
    projectId: string,
    requirementId: string,
    reply: FastifyReply
  ): Promise<Record<string, unknown>> {
    const requirement = await findRequirementForAnchor(projectId, requirementId);
    if (!requirement) {
      reply.status(404);
      return { message: "需求不存在" };
    }
    if (!["drafting", "planning"].includes(requirement.status)) {
      reply.status(409);
      return { code: "requirement_status_locked", message: "需求当前状态不允许启动 planning anchor" };
    }

    let binding;
    try {
      await waitForSlotResizeLock(requirement.project.id, {
        lock: resizeLock,
        timeoutMs: resizeLockWaitTimeoutMs
      });
      binding = await slotBinding.bindRequirement({
        projectId: requirement.project.id,
        requirementId: requirement.id
      });
    } catch (error) {
      if (isSlotResizeLockTimeoutError(error)) {
        reply.status(error.statusCode);
        return slotResizeLockTimeoutBody(error);
      }
      throw error;
    }
    if (!binding) {
      reply.status(409);
      return { code: "slot_pool_unavailable", message: "slot 已满，无法绑定 planning slot" };
    }

    await markRequirementPlanningRuntime(requirement, binding.slotId, "running");
    reply.status(200);
    return serializeSlotBindingAnchor(binding, {
      id: requirement.id,
      title: requirement.title
    });
  }

  async function dispatchRequirementPlanningCommand(
    projectId: string,
    requirementId: string,
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<Record<string, unknown>> {
    const requirement = await findRequirementForAnchor(projectId, requirementId);
    if (!requirement) {
      reply.status(404);
      return { message: "需求不存在" };
    }

    const parsed = parseRequirementDispatchPayload(request.body);
    if (!parsed.ok) {
      reply.status(400);
      return { code: "bad_dispatch_payload", message: parsed.message };
    }

    const command = buildRequirementDispatchCommand({
      projectId,
      requirementId: requirement.id,
      command: parsed.payload.command,
      payload: parsed.payload.payload
    });
    const dispatchPayload = readStructuredDispatchPayload(command);
    const queuedResult = await enqueueOrReplyPolicyError(
      reply,
      jobSlotRouter.enqueue({
        projectId,
        requirementId: requirement.id,
        subjectType: "requirement",
        subjectId: requirement.id,
        command,
        dispatchPayload,
        step: normalizeDispatchStep(dispatchPayload.step)
      })
    );
    if (!queuedResult.ok) return queuedResult.body;
    const queued = queuedResult.value;
    await markRequirementPlanningRuntime(requirement, queued.slotId ?? "slot-unassigned", "running");
    reply.status(202);
    return {
      jobId: queued.jobId,
      job_id: queued.jobId,
      anchorId: queued.slotId,
      slotId: queued.slotId,
      subjectId: requirement.id,
      requirementId: requirement.id,
      status: "queued",
      queuedAt: queued.queuedAt.toISOString()
    };
  }

  async function dispatchSubtaskExecutionCommand(
    taskId: string,
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<Record<string, unknown>> {
    const task = await findTaskForAnchor(taskId);
    if (!task) {
      reply.status(404);
      return { message: "task 不存在" };
    }
    const parsed = parseRequirementDispatchPayload(request.body);
    if (!parsed.ok) {
      reply.status(400);
      return { code: "bad_dispatch_payload", message: parsed.message };
    }

    if (!task.requirementId) {
      reply.status(409);
      return { code: "requirement_scope_missing", message: "子任务未绑定需求，无法解析 slot" };
    }
    const gate = await buildSubtaskDispatchGate(task, parsed.payload.command);
    if (gate.ineligibleReason) {
      reply.status(409);
      return {
        code: "subtask_dispatch_ineligible",
        message: gate.ineligibleReason,
        eligible: false,
        hasActiveAnchor: gate.hasActiveAnchor,
        isPendingDispatch: gate.isPendingDispatch
      };
    }

    const command = buildSubtaskDispatchCommand({
      taskId: task.id,
      taskKey: task.taskKey,
      command: parsed.payload.command,
      payload: parsed.payload.payload
    });
    const dispatchPayload = readStructuredDispatchPayload(command);
    const queuedResult = await enqueueOrReplyPolicyError(
      reply,
      jobSlotRouter.enqueue({
        projectId: task.project.id,
        requirementId: task.requirementId,
        subjectType: "subtask",
        subjectId: task.id,
        command,
        dispatchPayload,
        step: normalizeDispatchStep(dispatchPayload.step)
      })
    );
    if (!queuedResult.ok) return queuedResult.body;
    const queued = queuedResult.value;
    reply.status(202);
    return {
      jobId: queued.jobId,
      job_id: queued.jobId,
      anchorId: queued.slotId,
      slotId: queued.slotId,
      subjectId: task.id,
      taskId: task.id,
      status: "queued",
      queuedAt: queued.queuedAt.toISOString()
    };
  }

  async function dispatchSubtaskBatch(
    projectId: string,
    requirementId: string,
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<Record<string, unknown>> {
    const requirement = await findRequirementForAnchor(projectId, requirementId);
    if (!requirement) {
      reply.status(404);
      return { message: "需求不存在" };
    }

    const parsed = parseSubtaskBatchDispatchPayload(request.body);
    if (!parsed.ok) {
      reply.status(400);
      return { code: "bad_batch_dispatch_payload", message: parsed.message };
    }

    const tasks = await findSubtasksForBatch(projectId, requirementId, parsed.taskIds);
    if (tasks.length !== parsed.taskIds.length) {
      reply.status(400);
      return { code: "invalid_batch_task_scope", message: "部分子任务不属于该需求" };
    }
    const taskById = new Map(tasks.map((task) => [task.id, task]));
    const failedItems: SubtaskBatchDispatchItem[] = [];

    for (const taskId of parsed.taskIds) {
      const task = taskById.get(taskId);
      if (!task) {
        failedItems.push({ taskId, status: "failed", errorMessage: "子任务不属于该需求" });
        continue;
      }
      const candidate = await buildSingleSubtaskBatchCandidate(task);
      if (!candidate.eligible) {
        failedItems.push({
          taskId: task.id,
          status: "failed",
          errorMessage: candidate.ineligibleReason ?? "子任务当前不可派工"
        });
      }
    }

    if (failedItems.length > 0) {
      reply.status(409);
      return {
        code: "batch_contains_ineligible_subtasks",
        message: "批量推进包含不可派工子任务，未派出 su-batch",
        items: failedItems,
        totalQueued: 0,
        totalFailed: failedItems.length
      };
    }

    const orderedTasks = parsed.taskIds.map((taskId) => taskById.get(taskId)!);
    const command = buildRequirementDispatchCommand({
      projectId,
      requirementId: requirement.id,
      command: "su-batch",
      payload: {
        policy_profile: "autonomous-batch",
        scope: "subtasks",
        stop_policy: {
          on_subtask_failure: "stop_and_report"
        },
        task_ids: orderedTasks.map((task) => task.id),
        task_keys: orderedTasks.map((task) => task.taskKey)
      }
    });
    const dispatchPayload = readStructuredDispatchPayload(command);
    const queuedResult = await enqueueOrReplyPolicyError(
      reply,
      jobSlotRouter.enqueue({
        projectId,
        requirementId,
        subjectType: "requirement",
        subjectId: requirement.id,
        command,
        dispatchPayload,
        step: "batch_execution"
      })
    );
    if (!queuedResult.ok) return queuedResult.body;
    const queued = queuedResult.value;

    reply.status(202);
    return {
      jobId: queued.jobId,
      job_id: queued.jobId,
      anchorId: queued.slotId ?? "slot-unassigned",
      slotId: queued.slotId,
      subjectId: requirement.id,
      requirementId: requirement.id,
      command: "su-batch",
      status: "queued",
      queuedAt: queued.queuedAt.toISOString(),
      taskIds: orderedTasks.map((task) => task.id),
      totalQueued: 1,
      totalFailed: 0,
      items: []
    };
  }

  async function buildSubtaskBatchCandidates(
    projectId: string,
    requirementId: string
  ): Promise<SubtaskBatchCandidate[]> {
    const tasks = await db.task.findMany({
      where: {
        projectId,
        requirementId
      },
      select: {
        id: true,
        projectId: true,
        requirementId: true,
        taskKey: true,
        title: true,
        status: true,
        currentNode: true,
        project: {
          select: {
            id: true,
            localPath: true
          }
        }
      },
      orderBy: [
        {
          taskKey: "asc"
        },
        {
          updatedAt: "asc"
        }
      ]
    });
    return await Promise.all(tasks.map((task) => buildSingleSubtaskBatchCandidate(task)));
  }

  async function buildSingleSubtaskBatchCandidate(task: BatchSubtask): Promise<SubtaskBatchCandidate> {
    const gate = await buildSubtaskDispatchGate(task, "su-dispatch", { requiresDispatchReadiness: true });
    return {
      taskId: task.id,
      taskKey: task.taskKey,
      title: task.title,
      currentNode: task.currentNode,
      status: task.status,
      hasActiveAnchor: gate.hasActiveAnchor,
      isPendingDispatch: gate.isPendingDispatch,
      eligible: gate.ineligibleReason === null,
      ineligibleReason: gate.ineligibleReason
    };
  }

  async function buildSubtaskDispatchGate(
    task: SubtaskDispatchGateTask,
    command: string | null | undefined,
    options: { requiresDispatchReadiness?: boolean } = {}
  ): Promise<SubtaskDispatchGate> {
    const [pendingDispatch, activeAnchor] = await Promise.all([
      db.anchorDispatchQueue.findFirst({
        where: {
          projectId: task.project.id,
          subjectType: "subtask",
          subjectId: task.id,
          status: "pending"
        },
        select: {
          jobId: true
        }
      }),
      db.anchorAllocation.findFirst({
        where: {
          subjectType: "subtask",
          subjectId: task.id,
          state: {
            in: [...ACTIVE_ANCHOR_STATES]
          }
        },
        select: {
          anchorId: true
        }
      })
    ]);
    const hasActiveAnchor = Boolean(activeAnchor);
    const isPendingDispatch = Boolean(pendingDispatch);
    const ineligibleReason = getSubtaskDispatchIneligibleReason({
      status: task.status,
      currentNode: task.currentNode,
      hasActiveAnchor,
      isPendingDispatch,
      requiresDispatchReadiness: options.requiresDispatchReadiness ?? command === "su-dispatch"
    });
    return {
      hasActiveAnchor,
      isPendingDispatch,
      ineligibleReason
    };
  }

  async function findSubtasksForBatch(
    projectId: string,
    requirementId: string,
    taskIds: string[]
  ): Promise<BatchSubtask[]> {
    return await db.task.findMany({
      where: {
        id: {
          in: taskIds
        },
        projectId,
        requirementId
      },
      select: {
        id: true,
        projectId: true,
        requirementId: true,
        taskKey: true,
        title: true,
        status: true,
        currentNode: true,
        project: {
          select: {
            id: true,
            localPath: true
          }
        }
      }
    });
  }

  async function findTaskForAnchor(taskId: string): Promise<AnchorableTask | null> {
    return await db.task.findUnique({
      where: {
        id: taskId
      },
      select: {
        id: true,
        taskKey: true,
        status: true,
        currentNode: true,
        requirementId: true,
        project: {
          select: {
            id: true,
            localPath: true
          }
        }
      }
    });
  }

  async function findRequirementForAnchor(
    projectId: string,
    requirementId: string
  ): Promise<AnchorableRequirement | null> {
    return await db.requirement.findFirst({
      where: {
        id: requirementId,
        projectId
      },
      select: {
        id: true,
        title: true,
        status: true,
        currentPlanningStep: true,
        project: {
          select: {
            id: true,
            localPath: true
          }
        }
      }
    });
  }

  async function markRequirementPlanningRuntime(
    requirement: AnchorableRequirement,
    anchorId: string,
    planningRuntimeState: string
  ): Promise<void> {
    await db.requirement.update({
      where: {
        id: requirement.id
      },
      data: {
        planningAnchorId: anchorId,
        planningRuntimeState
      }
    });
  }
}

async function enqueueOrReplyPolicyError<T>(
  reply: FastifyReply,
  enqueue: Promise<T>
): Promise<{ ok: true; value: T } | { ok: false; body: Record<string, unknown> }> {
  try {
    return { ok: true, value: await enqueue };
  } catch (error) {
    if (error instanceof AnchorDispatchQueuePolicyError) {
      reply.status(error.statusCode);
      return { ok: false, body: anchorDispatchPolicyErrorBody(error) };
    }
    if (isSlotResizeLockTimeoutError(error)) {
      reply.status(error.statusCode);
      return { ok: false, body: slotResizeLockTimeoutBody(error) };
    }
    throw error;
  }
}

function anchorDispatchPolicyErrorBody(error: AnchorDispatchQueuePolicyError): Record<string, unknown> {
  return {
    code: error.code,
    message: error.message
  };
}

function anchorKindError(task: AnchorableTask): string | null {
  void task;
  return null;
}

export function getSubtaskDispatchIneligibleReason(input: {
  status: string;
  currentNode: string | null;
  hasActiveAnchor: boolean;
  isPendingDispatch: boolean;
  requiresDispatchReadiness: boolean;
}): string | null {
  const status = input.status.trim().toLowerCase();
  const currentNode = input.currentNode?.trim().toLowerCase() ?? null;
  if (status === "done" || status === "cancelled") return "子任务已结束";
  if (input.requiresDispatchReadiness) {
    if (currentNode !== "dispatch") return "子任务不在 dispatch 节点";
    if (status !== "reviewing") return "子任务不是 reviewing 状态";
  }
  if (input.hasActiveAnchor) return "已有 active execution anchor";
  if (input.isPendingDispatch) return "已有 pending dispatch";
  return null;
}

export function buildDefaultAnchorPath(projectRoot: string, epicTaskId: string): string {
  const repoName = basename(projectRoot);
  return join(dirname(projectRoot), `${repoName}-task-${epicTaskId}`);
}

export function buildDefaultRequirementAnchorPath(projectRoot: string, requirementId: string): string {
  const repoName = basename(projectRoot);
  return join(dirname(projectRoot), `${repoName}-requirement-${requirementId}`);
}

function parseRequirementDispatchPayload(body: unknown):
  | { ok: true; payload: RequirementDispatchPayload }
  | { ok: false; message: string } {
  if (typeof body !== "object" || body === null) {
    return { ok: false, message: "dispatch payload 必须是 object" };
  }
  const raw = body as Record<string, unknown>;
  const command = normalizeCommandToken(raw.command);
  if (!command) {
    return { ok: false, message: "command 必须是 su-flow 这类指令名" };
  }
  const payload = normalizeStructuredPayload(raw.payload);
  if (!payload.ok) {
    return { ok: false, message: payload.message };
  }
  return {
    ok: true,
    payload: {
      command,
      payload: payload.value
    }
  };
}

function parseSubtaskBatchDispatchPayload(body: unknown):
  | { ok: true; taskIds: string[]; step: "execution" }
  | { ok: false; message: string } {
  if (typeof body !== "object" || body === null) {
    return { ok: false, message: "batch dispatch payload 必须是 object" };
  }
  const raw = body as Record<string, unknown>;
  if (!Array.isArray(raw.taskIds)) {
    return { ok: false, message: "taskIds 必须是数组" };
  }
  const taskIds = raw.taskIds
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter((value) => value.length > 0);
  if (taskIds.length === 0 || taskIds.length !== raw.taskIds.length) {
    return { ok: false, message: "taskIds 不能为空且每项必须是字符串" };
  }
  if (new Set(taskIds).size !== taskIds.length) {
    return { ok: false, message: "taskIds 不能重复" };
  }
  const step = raw.step === undefined ? "execution" : normalizeValueToken(raw.step);
  if (step !== "execution") {
    return { ok: false, message: "step 仅支持 execution" };
  }
  return { ok: true, taskIds, step };
}

function normalizeCommandToken(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const token = value.trim().replace(/^\/ccb:/, "");
  return /^[a-z][a-z0-9-]*$/.test(token) ? token : null;
}

function normalizeValueToken(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const token = value.trim();
  return /^[A-Za-z0-9_.:/=-]+$/.test(token) ? token : null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function payloadDepth(value: unknown): number {
  if (!value || typeof value !== "object") return 0;
  const children = Array.isArray(value) ? value : Object.values(value);
  if (children.length === 0) return 1;
  return 1 + Math.max(...children.map((child) => payloadDepth(child)));
}

function hasBase64BusinessField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some((item) => hasBase64BusinessField(item));
  if (!isPlainObject(value)) return false;
  return Object.entries(value).some(([key, nested]) => key.endsWith("_b64") || hasBase64BusinessField(nested));
}

function normalizeStructuredPayload(value: unknown):
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; message: string } {
  if (!isPlainObject(value)) {
    return { ok: false, message: "payload 必须是 JSON object" };
  }
  if (hasBase64BusinessField(value)) {
    return { ok: false, message: "payload 不再支持 *_b64 业务字段，请使用 JSON native 字段" };
  }
  const payloadText = JSON.stringify(value);
  if (Buffer.byteLength(payloadText, "utf8") > MAX_ANCHOR_DISPATCH_PAYLOAD_BYTES) {
    return { ok: false, message: `payload 不能超过 ${MAX_ANCHOR_DISPATCH_PAYLOAD_BYTES} bytes` };
  }
  if (payloadDepth(value) > MAX_ANCHOR_DISPATCH_PAYLOAD_DEPTH) {
    return { ok: false, message: `payload 嵌套深度不能超过 ${MAX_ANCHOR_DISPATCH_PAYLOAD_DEPTH}` };
  }
  return { ok: true, value };
}

function normalizeDispatchStep(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

async function withTaskLock<T>(taskId: string, work: () => Promise<T>): Promise<T> {
  const previous = taskLocks.get(taskId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const next = previous.catch(() => undefined).then(() => current);
  taskLocks.set(taskId, next);

  await previous.catch(() => undefined);
  try {
    return await work();
  } finally {
    release();
    if (taskLocks.get(taskId) === next) {
      taskLocks.delete(taskId);
    }
  }
}

function deprecatedAnchorWrite(reply: FastifyReply): Record<string, unknown> {
  reply.status(410);
  return {
    code: "legacy_anchor_write_deprecated",
    message: "legacy per-anchor runtime write routes 已退役，请使用 slot dispatch / slot release API"
  };
}

function serializeSlotBindingAnchor(
  binding: SlotBinding,
  requirement: { id: string; title: string } | null
): Record<string, unknown> {
  return {
    anchorId: binding.slotId,
    slotId: binding.slotId,
    anchorPath: null,
    projectId: binding.projectId,
    socketPath: null,
    runtimePaused: false,
    subjectType: "requirement",
    subjectId: requirement?.id ?? binding.requirementId,
    subjectKey: requirement?.title ?? null,
    mode: "planning",
    status: binding.state,
    state: binding.state,
    dirtyState: null,
    startedAt: binding.boundAt?.toISOString() ?? null,
    heartbeatAt: binding.lastActivityAt?.toISOString() ?? null,
    createdAt: binding.createdAt.toISOString(),
    updatedAt: binding.updatedAt.toISOString()
  };
}

function serializeAnchor(anchor: {
  anchorId: string;
  anchorPath: string;
  projectId: string | null;
  socketPath: string | null;
  runtimePaused: boolean;
  subjectType: string;
  subjectId: string;
  subjectKey: string | null;
  mode: string;
  state: string;
  dirtyState: string | null;
  startedAt: Date | null;
  heartbeatAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}, slotId: string | null = null): Record<string, unknown> {
  return {
    anchorId: anchor.anchorId,
    slotId,
    anchorPath: anchor.anchorPath,
    projectId: anchor.projectId,
    socketPath: anchor.socketPath,
    runtimePaused: anchor.runtimePaused,
    subjectType: anchor.subjectType,
    subjectId: anchor.subjectId,
    subjectKey: anchor.subjectKey,
    mode: anchor.mode,
    state: anchor.state,
    dirtyState: anchor.dirtyState,
    startedAt: anchor.startedAt?.toISOString() ?? null,
    heartbeatAt: anchor.heartbeatAt?.toISOString() ?? null,
    createdAt: anchor.createdAt.toISOString(),
    updatedAt: anchor.updatedAt.toISOString()
  };
}
