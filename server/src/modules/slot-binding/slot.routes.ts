import type { AnchorDispatchQueue, PrismaClient, SlotBinding } from "@prisma/client";
import type { FastifyInstance, FastifyReply } from "fastify";

import { prisma } from "../../db/prisma.js";
import { AnchorDispatchQueuePolicyError } from "../anchor-broker/anchor-dispatch-queue-policy.js";
import { CcbdClientService } from "../ccbd-client/ccbd-client.service.js";
import { JobSlotRouter } from "./job-slot-router.js";
import { SlotBindingService, isSlotId, type SlotId } from "./slot-binding.service.js";
import { slotIds as deriveSlotIds } from "../slot-topology/slot-topology.service.js";
import {
  createDefaultSlotContextResetter,
  summarizeSlotContextResetResult,
  type SlotContextResetInput,
  type SlotContextResetResult,
  type SlotContextResetter
} from "./slot-context-reset.service.js";
import { syncSlotTips } from "./slot-tips-projection.service.js";

type SlotReleaseInput = {
  confirm?: boolean;
  force?: boolean;
  reason?: string;
};

type QueueProjection = {
  jobId: string;
  slotId: string | null;
  subjectType: string;
  subjectId: string;
  requirementId: string | null;
  requirementTitle: string | null;
  title: string | null;
  command: string;
  queuedAt: string;
};

type DegradedProjection = {
  degradedReason: string | null;
  severity: string | null;
  emittedAt: string | null;
};

type SlotArchiveInput = {
  confirm?: boolean;
};

type SlotCancelCurrentJobInput = {
  confirm?: boolean;
};

type SlotRuntime = {
  cancelCurrentJob(input: { projectRoot: string; jobId: string }): Promise<Record<string, unknown>>;
};

type SlotContextResetLogger = {
  warn(input: Record<string, unknown>, message: string): void;
  info(input: Record<string, unknown>, message: string): void;
};

export interface SlotRouteDependencies {
  prismaClient?: PrismaClient;
  slotRuntime?: SlotRuntime;
  slotContextResetter?: SlotContextResetter | null;
}

export async function registerSlotRoutes(
  app: FastifyInstance,
  dependencies: SlotRouteDependencies = {}
): Promise<void> {
  const db = dependencies.prismaClient ?? prisma;
  const slotRuntime = dependencies.slotRuntime ?? createDefaultSlotRuntime();
  const slotContextResetter =
    dependencies.slotContextResetter === undefined
      ? process.env.NODE_ENV === "test"
        ? null
        : createDefaultSlotContextResetter()
      : dependencies.slotContextResetter;
  let router!: JobSlotRouter;
  const slotBinding = new SlotBindingService(db, {
    onSlotBound: async ({ projectId, slotId, requirementId }) => {
      if (slotContextResetter) {
        const result = await resetSlotContextBestEffort(
          slotContextResetter,
          {
            projectId,
            slotId,
            requirementId,
            trigger: "bind"
          },
          app.log
        );
        if (result?.status === "ok") {
          app.log.info(
            { event: "slot_context_reset.bind.sent", result: summarizeSlotContextResetResult(result) },
            "slot context reset sent after bind"
          );
        }
      }
      await syncSlotTips(projectId, { client: db, logger: app.log });
    },
    onSlotReleased: async ({ projectId }) => {
      await tickRouterBestEffort(router, projectId, app.log);
      await syncSlotTips(projectId, { client: db, logger: app.log });
    }
  });
  router = new JobSlotRouter({ prismaClient: db, slotBinding });

  app.get("/api/projects/:projectId/slots", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    return await buildSlotProjection(db, projectId, reply);
  });

  app.get("/api/slots", async (request, reply) => {
    const query = request.query as { projectId?: string; project_id?: string };
    const projectId = query.projectId ?? query.project_id;
    if (!projectId) {
      reply.status(400);
      return { message: "projectId is required for SlotBinding projection" };
    }
    return await buildSlotProjection(db, projectId, reply);
  });

  app.post("/api/projects/:projectId/requirements/:requirementId/bind-slot", async (request, reply) => {
    const { projectId, requirementId } = request.params as { projectId: string; requirementId: string };
    const requirement = await db.requirement.findFirst({
      where: {
        id: requirementId,
        projectId
      },
      select: { id: true }
    });
    if (!requirement) {
      reply.status(404);
      return { message: "requirement 不存在" };
    }

    const binding = await slotBinding.bindRequirement({
      projectId,
      requirementId,
      reason: "manual_rebind"
    });
    if (!binding) {
      reply.status(409);
      return {
        code: "SLOT_FULL",
        message: "slot 已满，去 SlotsPage 看排队"
      };
    }

    const projection = await buildSlotProjection(db, projectId, reply, { statusIfMissing: false });
    if ("slots" in projection) {
      return {
        ...projection,
        slot: projection.slots.find((slot) => slot.slotId === binding.slotId) ?? projectSlot(binding, null, [], null)
      };
    }
    return projection;
  });

  app.post("/api/projects/:projectId/slots/:slotId/release", async (request, reply) => {
    const { projectId, slotId: requestedSlotId } = request.params as { projectId: string; slotId: string };
    const validatedSlot = await validateBusinessSlot(db, projectId, requestedSlotId, "main lane cannot bind or release business work", reply);
    if ("error" in validatedSlot) {
      return validatedSlot.error;
    }
    const slotId = validatedSlot.slotId;

    const input = (request.body ?? {}) as SlotReleaseInput;
    if (!input.confirm) {
      reply.status(400);
      return { message: "release requires confirmation" };
    }

    const binding = await db.slotBinding.findUnique({
      where: {
        projectId_slotId: {
          projectId,
          slotId
        }
      },
      include: {
        requirement: {
          select: {
            id: true,
            title: true
          }
        }
      }
    });
    if (!binding) {
      reply.status(404);
      return { message: "slot binding 不存在" };
    }

    const forceReason = input.reason?.trim() ?? "";
    if (binding.state === "busy" && (!input.force || forceReason.length === 0)) {
      reply.status(409);
      return { message: "busy slot force release requires reason and confirmation" };
    }

    const reason = binding.state === "busy" || input.force ? "force_release" : "manual_release";
    await resetSlotContextBestEffort(
      slotContextResetter,
      {
        projectId,
        slotId,
        requirementId: binding.requirementId,
        trigger: "release"
      },
      request.log
    );
    const released = await slotBinding.releaseSlot({
      projectId,
      slotId,
      reason,
      releasedBy: "user",
      operatorReason: reason === "force_release" ? forceReason : null
    });
    const projection = await buildSlotProjection(db, projectId, reply, { statusIfMissing: false });
    return {
      ...projection,
      slot: projectSlot(released, null, [], null)
    };
  });

  app.post("/api/projects/:projectId/slots/:slotId/renew", async (request, reply) => {
    const { projectId, slotId: requestedSlotId } = request.params as { projectId: string; slotId: string };
    const validatedSlot = await validateBusinessSlot(db, projectId, requestedSlotId, "main lane cannot bind business work", reply);
    if ("error" in validatedSlot) {
      return validatedSlot.error;
    }
    const slotId = validatedSlot.slotId;

    const binding = await db.slotBinding.findUnique({
      where: {
        projectId_slotId: {
          projectId,
          slotId
        }
      },
      include: {
        requirement: {
          select: {
            id: true,
            title: true
          }
        }
      }
    });
    if (!binding) {
      reply.status(404);
      return { message: "slot binding 不存在" };
    }

    const renewed = await db.slotBinding.update({
      where: { id: binding.id },
      data: {
        staleDetectedAt: null,
        staleNotifiedCount: 0,
        lastActivityAt: new Date()
      },
      include: {
        requirement: {
          select: {
            id: true,
            title: true
          }
        }
      }
    });
    const projection = await buildSlotProjection(db, projectId, reply, { statusIfMissing: false });
    return {
      ...projection,
      slot: projectSlot(renewed, renewed.requirement, [], null)
    };
  });

  app.post("/api/projects/:projectId/slots/:slotId/archive", async (request, reply) => {
    const { projectId, slotId: requestedSlotId } = request.params as { projectId: string; slotId: string };
    const validatedSlot = await validateBusinessSlot(db, projectId, requestedSlotId, "main lane cannot archive business work", reply);
    if ("error" in validatedSlot) {
      return validatedSlot.error;
    }
    const slotId = validatedSlot.slotId;

    const input = (request.body ?? {}) as SlotArchiveInput;
    if (!input.confirm) {
      reply.status(400);
      return { message: "archive requires confirmation" };
    }

    const binding = await db.slotBinding.findUnique({
      where: {
        projectId_slotId: {
          projectId,
          slotId
        }
      }
    });
    if (!binding?.requirementId) {
      reply.status(404);
      return { message: "slot 未绑定 requirement" };
    }

    const payload = {
      project_id: projectId,
      requirement_id: binding.requirementId,
      source: "console_slot_archive",
      subject: "requirement",
      slot_id: slotId
    };
    let result;
    try {
      result = await router.enqueue({
        projectId,
        requirementId: binding.requirementId,
        subjectType: "requirement",
        subjectId: binding.requirementId,
        command: `/ccb:su-archive --payload ${JSON.stringify(payload)}`,
        dispatchPayload: payload,
        preferredSlotId: slotId,
        reason: "sticky_slot_unavailable"
      });
    } catch (error) {
      if (error instanceof AnchorDispatchQueuePolicyError) {
        reply.status(error.statusCode);
        return {
          code: error.code,
          message: error.message
        };
      }
      throw error;
    }
    reply.status(202);
    return {
      jobId: result.jobId,
      slotId,
      requirementId: binding.requirementId,
      status: result.status === "submitted" ? "submitted" : "queued",
      queuedAt: result.queuedAt.toISOString()
    };
  });

  app.post("/api/projects/:projectId/slots/:slotId/cancel-current-job", async (request, reply) => {
    const { projectId, slotId: requestedSlotId } = request.params as { projectId: string; slotId: string };
    const validatedSlot = await validateBusinessSlot(db, projectId, requestedSlotId, "main lane cannot cancel business work", reply);
    if ("error" in validatedSlot) {
      return validatedSlot.error;
    }
    const slotId = validatedSlot.slotId;

    const input = (request.body ?? {}) as SlotCancelCurrentJobInput;
    if (!input.confirm) {
      reply.status(400);
      return { message: "cancel current job requires confirmation" };
    }

    const [project, binding] = await Promise.all([
      db.project.findUnique({
        where: { id: projectId },
        select: { localPath: true }
      }),
      db.slotBinding.findUnique({
        where: {
          projectId_slotId: {
            projectId,
            slotId
          }
        }
      })
    ]);
    if (!project) {
      reply.status(404);
      return { message: "项目不存在" };
    }
    if (!binding) {
      reply.status(404);
      return { message: "slot binding 不存在" };
    }

    const currentJob = await findLatestSubmittedQueueRow(db, projectId, slotId);
    if (!currentJob) {
      reply.status(404);
      return { message: "slot 当前没有 submitted job" };
    }

    const cancelResult = await slotRuntime.cancelCurrentJob({
      projectRoot: project.localPath,
      jobId: currentJob.jobId
    });
    await db.anchorDispatchQueue.update({
      where: { id: currentJob.id },
      data: {
        status: "cancelled",
        failedAt: new Date(),
        errorMessage: null
      }
    });
    const slot = await slotBinding.markBound(projectId, slotId);
    const projection = await buildSlotProjection(db, projectId, reply, { statusIfMissing: false });
    return {
      ...projection,
      slot: projectSlot(slot, null, [], null),
      cancelledJobId: currentJob.jobId,
      cancelResult
    };
  });
}

async function buildSlotProjection(
  db: PrismaClient,
  projectId: string,
  reply: FastifyReply,
  options: { statusIfMissing?: boolean } = {}
) {
  const project = await db.project.findUnique({
    where: { id: projectId },
    select: { id: true, name: true, slotCount: true }
  });
  if (!project) {
    reply.status(404);
    return { message: "项目不存在" };
  }
  const businessSlotIds = deriveSlotIds(project.slotCount);

  const [bindings, queueRows, degradedRows] = await Promise.all([
    db.slotBinding.findMany({
      where: { projectId },
      include: {
        requirement: {
          select: {
            id: true,
            title: true
          }
        }
      }
    }),
    db.anchorDispatchQueue.findMany({
      where: {
        status: "pending",
        anchorId: {
          in: ["slot-unassigned", ...businessSlotIds]
        }
      },
      orderBy: { queuedAt: "asc" }
    }),
    db.eventJournal.findMany({
      where: {
        projectId,
        eventType: "slot_runtime_degraded",
        anchorId: {
          in: [...businessSlotIds]
        }
      },
      orderBy: { emittedAt: "desc" }
    })
  ]);
  const queue = await projectQueueRows(db, projectId, queueRows);
  const queueBySlot = new Map<string, QueueProjection[]>();
  for (const item of queue) {
    if (!item.slotId) continue;
    queueBySlot.set(item.slotId, [...(queueBySlot.get(item.slotId) ?? []), item]);
  }
  const degradedBySlot = latestDegradedBySlot(degradedRows);
  const bindingsBySlot = new Map(bindings.map((binding) => [binding.slotId, binding]));

  return {
    project: {
      id: project.id,
      name: project.name
    },
    main: {
      slotId: "main",
      lane: "coordination",
      state: "available",
      canBindBusiness: false
    },
    slots: businessSlotIds.map((slotId) => {
      const binding = bindingsBySlot.get(slotId);
      return binding
        ? projectSlot(binding, binding.requirement, queueBySlot.get(slotId) ?? [], degradedBySlot.get(slotId) ?? null)
        : idleSlot(slotId, queueBySlot.get(slotId) ?? []);
    }),
    queue: queue.filter((item) => item.slotId === null),
    ...(options.statusIfMissing === false ? {} : { generatedAt: new Date().toISOString() })
  };
}

async function validateBusinessSlot(
  db: PrismaClient,
  projectId: string,
  value: string,
  mainMessage: string,
  reply: FastifyReply
): Promise<{ slotId: SlotId } | { error: { message: string } }> {
  if (value === "main") {
    reply.status(400);
    return { error: { message: mainMessage } };
  }
  const project = await db.project.findUnique({
    where: { id: projectId },
    select: { slotCount: true }
  });
  if (!project) {
    reply.status(404);
    return { error: { message: "项目不存在" } };
  }
  if (!isSlotId(value, project.slotCount)) {
    reply.status(404);
    return { error: { message: "slot 不存在" } };
  }
  return { slotId: value };
}

function idleSlot(slotId: SlotId, queued: QueueProjection[]) {
  return {
    slotId,
    state: "idle",
    requirement: null,
    boundAt: null,
    busySince: null,
    lastActivityAt: null,
    stale: null,
    unhealthy: null,
    queued
  };
}

function projectSlot(
  binding: SlotBinding,
  requirement: { id: string; title: string } | null,
  queued: QueueProjection[],
  degraded: DegradedProjection | null
) {
  return {
    slotId: binding.slotId,
    state: binding.state,
    requirement: requirement ? { id: requirement.id, title: requirement.title } : null,
    boundAt: binding.boundAt?.toISOString() ?? null,
    busySince: binding.busySince?.toISOString() ?? null,
    lastActivityAt: binding.lastActivityAt?.toISOString() ?? null,
    stale: binding.staleDetectedAt
      ? {
          detectedAt: binding.staleDetectedAt.toISOString(),
          notifiedCount: binding.staleNotifiedCount
        }
      : null,
    unhealthy: binding.state === "unhealthy" ? degraded ?? { degradedReason: null, severity: null, emittedAt: null } : null,
    queued
  };
}

async function projectQueueRows(
  db: PrismaClient,
  projectId: string,
  rows: AnchorDispatchQueue[]
): Promise<QueueProjection[]> {
  const requirementIds = rows
    .filter((row) => row.subjectType === "requirement")
    .map((row) => row.subjectId);
  const taskIds = rows
    .filter((row) => row.subjectType === "subtask")
    .map((row) => row.subjectId);
  const [requirements, tasks] = await Promise.all([
    requirementIds.length > 0
      ? db.requirement.findMany({
          where: { projectId, id: { in: requirementIds } },
          select: { id: true, title: true }
        })
      : Promise.resolve([]),
    taskIds.length > 0
      ? db.task.findMany({
          where: { projectId, id: { in: taskIds } },
          select: {
            id: true,
            title: true,
            requirementId: true,
            requirement: {
              select: {
                id: true,
                title: true
              }
            }
          }
        })
      : Promise.resolve([])
  ]);
  const requirementById = new Map(requirements.map((requirement) => [requirement.id, requirement]));
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  return rows.flatMap((row) => {
    const requirement = row.subjectType === "requirement"
      ? requirementById.get(row.subjectId) ?? null
      : taskById.get(row.subjectId)?.requirement ?? null;
    const task = row.subjectType === "subtask" ? taskById.get(row.subjectId) ?? null : null;
    if (!requirement && !task) {
      return [];
    }
    return [{
      jobId: row.jobId,
      slotId: row.anchorId === "slot-unassigned" ? null : row.anchorId,
      subjectType: row.subjectType,
      subjectId: row.subjectId,
      requirementId: requirement?.id ?? null,
      requirementTitle: requirement?.title ?? null,
      title: task?.title ?? requirement?.title ?? null,
      command: row.command,
      queuedAt: row.queuedAt.toISOString()
    }];
  });
}

async function findLatestSubmittedQueueRow(
  db: PrismaClient,
  projectId: string,
  slotId: SlotId
): Promise<AnchorDispatchQueue | null> {
  const rows = await db.anchorDispatchQueue.findMany({
    where: {
      anchorId: slotId,
      status: "submitted"
    },
    orderBy: [
      { submittedAt: "desc" },
      { queuedAt: "desc" }
    ],
    take: 20
  });
  for (const row of rows) {
    if (row.subjectType === "requirement") {
      const requirement = await db.requirement.findUnique({
        where: { id: row.subjectId },
        select: { projectId: true }
      });
      if (requirement?.projectId === projectId) {
        return row;
      }
      continue;
    }
    if (row.subjectType === "subtask") {
      const task = await db.task.findUnique({
        where: { id: row.subjectId },
        select: { projectId: true }
      });
      if (task?.projectId === projectId) {
        return row;
      }
    }
  }
  return null;
}

function latestDegradedBySlot(rows: Array<{ anchorId: string | null; payloadJson: string; emittedAt: Date }>): Map<string, DegradedProjection> {
  const out = new Map<string, DegradedProjection>();
  for (const row of rows) {
    if (!row.anchorId || out.has(row.anchorId)) continue;
    const payload = parsePayload(row.payloadJson);
    out.set(row.anchorId, {
      degradedReason: typeof payload.reason === "string" ? payload.reason : null,
      severity: typeof payload.severity === "string" ? payload.severity : null,
      emittedAt: row.emittedAt.toISOString()
    });
  }
  return out;
}

function parsePayload(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

async function resetSlotContextBestEffort(
  resetter: SlotContextResetter | null | undefined,
  input: SlotContextResetInput,
  logger: SlotContextResetLogger
): Promise<SlotContextResetResult | null> {
  if (!resetter) {
    return null;
  }
  try {
    const result = await resetter.resetSlotContext(input);
    if (result.status !== "ok") {
      logger.warn(
        { event: "slot_context_reset.incomplete", result: summarizeSlotContextResetResult(result) },
        "slot context reset did not reach every agent"
      );
    }
    return result;
  } catch (error) {
    logger.warn(
      {
        event: "slot_context_reset.failed",
        err: error,
        input: {
          projectId: input.projectId,
          slotId: input.slotId,
          requirementId: input.requirementId ?? null,
          trigger: input.trigger
        }
      },
      "slot context reset failed; continuing main slot flow"
    );
    return null;
  }
}

async function tickRouterBestEffort(
  router: JobSlotRouter,
  projectId: string,
  logger: SlotContextResetLogger
): Promise<void> {
  try {
    await router.tick(projectId);
  } catch (error) {
    logger.warn(
      {
        event: "slot_router.tick.failed",
        projectId,
        err: error
      },
      "slot router tick failed after release; continuing main slot flow"
    );
  }
}

function createDefaultSlotRuntime(): SlotRuntime {
  return {
    async cancelCurrentJob(input) {
      return await new CcbdClientService({ projectRoot: input.projectRoot }).cancel(input.jobId);
    }
  };
}
