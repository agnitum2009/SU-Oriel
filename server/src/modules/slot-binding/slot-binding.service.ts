import { randomUUID } from "node:crypto";

import type { Prisma, PrismaClient, SlotBinding } from "@prisma/client";

import { prisma } from "../../db/prisma.js";
import { supersedePendingRequirementDispatches } from "../anchor-broker/anchor-dispatch-queue-policy.js";
import { emitEventInTransaction } from "../events/event-journal.service.js";
import {
  createDefaultSlotContextResetter,
  summarizeSlotContextResetResult
} from "./slot-context-reset.service.js";
import { syncSlotTips } from "./slot-tips-projection.service.js";
import {
  MAX_PROJECT_SLOT_COUNT,
  slotIds as deriveSlotIds,
  type SlotId
} from "../slot-topology/slot-topology.service.js";

export type { SlotId };

export type BindRequirementInput = {
  projectId: string;
  requirementId: string;
  reason?: "new_requirement" | "startup_recovery" | "manual_rebind";
};

export type ReleaseSlotInput = {
  projectId: string;
  slotId: SlotId;
  reason: "requirement_archived" | "requirement_cancelled" | "manual_release" | "force_release";
  releasedBy: "system" | "user";
  operatorReason?: string | null;
};

export type SlotReleasedCallbackInput = {
  projectId: string;
  slotId: SlotId;
};

export type SlotBoundCallbackInput = {
  projectId: string;
  slotId: SlotId;
  requirementId: string;
};

export type SlotBindingServiceOptions = {
  onSlotBound?: ((input: SlotBoundCallbackInput) => Promise<void>) | null;
  onSlotReleased?: ((input: SlotReleasedCallbackInput) => Promise<void>) | null;
};

type SlotBindingClient = Pick<
  PrismaClient | Prisma.TransactionClient,
  "slotBinding" | "requirement" | "eventJournal" | "project"
>;

export class SlotBindingService {
  private readonly options: SlotBindingServiceOptions;

  constructor(
    private readonly client: PrismaClient = prisma,
    options: SlotBindingServiceOptions = {}
  ) {
    this.options = {
      ...options,
      onSlotBound: Object.prototype.hasOwnProperty.call(options, "onSlotBound")
        ? options.onSlotBound
        : createDefaultSlotBoundCallback(this.client),
      onSlotReleased: Object.prototype.hasOwnProperty.call(options, "onSlotReleased")
        ? options.onSlotReleased
        : createDefaultSlotReleasedCallback(this.client)
    };
  }

  async bindRequirement(input: BindRequirementInput): Promise<SlotBinding | null> {
    const result = await this.client.$transaction(async (tx) => {
      const existing = await tx.slotBinding.findFirst({
        where: {
          projectId: input.projectId,
          requirementId: input.requirementId,
          state: {
            notIn: ["draining"]
          }
        }
      });
      if (existing) {
        return { binding: existing, newlyBound: false };
      }

      const project = await tx.project.findUnique({
        where: { id: input.projectId },
        select: { slotCount: true }
      });
      if (!project) {
        return null;
      }
      const projectSlotIds = deriveSlotIds(project.slotCount);
      const occupied = await tx.slotBinding.findMany({
        where: {
          projectId: input.projectId,
          state: {
            in: ["bound", "busy", "unhealthy", "recovering", "draining"]
          }
        },
        select: { slotId: true }
      });
      const occupiedIds = new Set(occupied.map((row) => row.slotId));
      const slotId = projectSlotIds.find((candidate) => !occupiedIds.has(candidate));
      if (!slotId) {
        return null;
      }

      const now = new Date();
      const binding = await tx.slotBinding.upsert({
        where: {
          projectId_slotId: {
            projectId: input.projectId,
            slotId
          }
        },
        create: {
          projectId: input.projectId,
          slotId,
          requirementId: input.requirementId,
          state: "bound",
          boundAt: now,
          lastActivityAt: now,
          historyJson: JSON.stringify([
            {
              at: now.toISOString(),
              action: "bind",
              requirementId: input.requirementId,
              reason: input.reason ?? "new_requirement"
            }
          ])
        },
        update: {
          requirementId: input.requirementId,
          state: "bound",
          boundAt: now,
          releasedAt: null,
          busySince: null,
          lastActivityAt: now,
          staleDetectedAt: null,
          staleNotifiedCount: 0,
          historyJson: JSON.stringify([
            {
              at: now.toISOString(),
              action: "bind",
              requirementId: input.requirementId,
              reason: input.reason ?? "new_requirement"
            }
          ])
        }
      });

      await emitEventInTransaction(tx, {
        event_id: randomUUID(),
        event_type: "slot_bound",
        subject_type: "requirement",
        subject_id: input.requirementId,
        anchor_id: slotId,
        emitted_at: now.toISOString(),
        source_actor: "system",
        source_component: "console",
        idempotency_key: `slot-bound:${input.projectId}:${input.requirementId}:${slotId}:${now.getTime()}`,
        payload: {
          slotId,
          requirementId: input.requirementId,
          reason: input.reason ?? "new_requirement"
        }
      });

      return { binding, newlyBound: true };
    });
    if (result?.newlyBound) {
      await this.notifySlotBound({
        projectId: input.projectId,
        slotId: result.binding.slotId as SlotId,
        requirementId: input.requirementId
      });
    }
    return result?.binding ?? null;
  }

  private async notifySlotBound(input: SlotBoundCallbackInput): Promise<void> {
    try {
      await this.options.onSlotBound?.(input);
    } catch {
      // Binding is authoritative once committed; callback delivery is best-effort.
    }
  }

  async findBindingForRequirement(projectId: string, requirementId: string): Promise<SlotBinding | null> {
    return await this.client.slotBinding.findFirst({
      where: {
        projectId,
        requirementId,
        state: {
          notIn: ["draining"]
        }
      },
      orderBy: {
        updatedAt: "desc"
      }
    });
  }

  async resolveSlotForSubtask(taskId: string): Promise<SlotBinding | null> {
    const task = await this.client.task.findUnique({
      where: { id: taskId },
      select: { projectId: true, requirementId: true }
    });
    if (!task?.requirementId) return null;
    return await this.findBindingForRequirement(task.projectId, task.requirementId);
  }

  async markBusy(projectId: string, slotId: SlotId): Promise<SlotBinding> {
    return await this.client.slotBinding.update({
      where: {
        projectId_slotId: {
          projectId,
          slotId
        }
      },
      data: {
        state: "busy",
        busySince: new Date()
      }
    });
  }

  async markBound(projectId: string, slotId: SlotId): Promise<SlotBinding> {
    return await this.client.slotBinding.update({
      where: {
        projectId_slotId: {
          projectId,
          slotId
        }
      },
      data: {
        state: "bound",
        busySince: null,
        lastActivityAt: new Date()
      }
    });
  }

  async releaseSlot(input: ReleaseSlotInput): Promise<SlotBinding> {
    const released = await this.client.$transaction(async (tx) => {
      const existing = await tx.slotBinding.findUniqueOrThrow({
        where: {
          projectId_slotId: {
            projectId: input.projectId,
            slotId: input.slotId
          }
        }
      });
      const now = new Date();
      const operatorReason = input.operatorReason?.trim() || null;
      const released = await tx.slotBinding.update({
        where: {
          id: existing.id
        },
        data: {
          requirementId: null,
          state: "idle",
          releasedAt: now,
          busySince: null,
          staleDetectedAt: null,
          staleNotifiedCount: 0,
          historyJson: appendHistory(existing.historyJson, {
            at: now.toISOString(),
            action: "release",
            requirementId: existing.requirementId,
            reason: input.reason,
            releasedBy: input.releasedBy,
            operatorReason
          })
        }
      });

      if (existing.requirementId) {
        await emitEventInTransaction(tx, {
          event_id: randomUUID(),
          event_type: "slot_released",
          subject_type: "requirement",
          subject_id: existing.requirementId,
          anchor_id: input.slotId,
          emitted_at: now.toISOString(),
          source_actor: input.releasedBy === "user" ? "user" : "system",
          source_component: "console",
          idempotency_key: `slot-released:${input.projectId}:${input.slotId}:${now.getTime()}`,
          payload: {
            slotId: input.slotId,
            requirementId: existing.requirementId,
            reason: input.reason,
            releasedBy: input.releasedBy,
            operatorReason
          }
        });
      }
      return released;
    });
    await this.notifySlotReleased({
      projectId: input.projectId,
      slotId: input.slotId
    });
    return released;
  }

  private async notifySlotReleased(input: SlotReleasedCallbackInput): Promise<void> {
    try {
      await this.options.onSlotReleased?.(input);
    } catch {
      // Release is authoritative once committed; callback delivery is best-effort.
    }
  }

  async updateActivityForRequirement(input: {
    projectId: string;
    requirementId: string;
    at: Date;
  }): Promise<number> {
    const result = await this.client.slotBinding.updateMany({
      where: {
        projectId: input.projectId,
        requirementId: input.requirementId,
        state: {
          in: ["bound", "busy", "unhealthy", "recovering"]
        }
      },
      data: {
        lastActivityAt: input.at,
        staleDetectedAt: null,
        state: "bound",
        busySince: null
      }
    });
    return result.count;
  }

  async backfillFromAnchorAllocations(projectId: string): Promise<{ bound: number; skipped: number }> {
    const project = await this.client.project.findUnique({
      where: { id: projectId },
      select: { slotCount: true }
    });
    if (!project) {
      return { bound: 0, skipped: 0 };
    }
    const projectSlotIds = deriveSlotIds(project.slotCount);
    const anchors = await this.client.anchorAllocation.findMany({
      where: {
        projectId,
        subjectType: "requirement",
        mode: "planning",
        state: {
          in: ["ready", "busy", "recovering"]
        }
      },
      orderBy: { updatedAt: "asc" },
      take: projectSlotIds.length
    });
    let bound = 0;
    for (const anchor of anchors) {
      const result = await this.bindRequirement({
        projectId,
        requirementId: anchor.subjectId,
        reason: "startup_recovery"
      });
      if (result) bound++;
    }
    return { bound, skipped: Math.max(0, anchors.length - bound) };
  }
}

export function isSlotId(value: string, slotCount: number = MAX_PROJECT_SLOT_COUNT): value is SlotId {
  return (deriveSlotIds(slotCount) as readonly string[]).includes(value);
}

async function findRequirementIdForSubject(
  client: SlotBindingClient,
  subjectType: string,
  subjectId: string
): Promise<{ projectId: string; requirementId: string } | null> {
  if (subjectType === "requirement") {
    const requirement = await client.requirement.findUnique({
      where: { id: subjectId },
      select: { id: true, projectId: true }
    });
    return requirement ? { projectId: requirement.projectId, requirementId: requirement.id } : null;
  }
  return null;
}

export async function updateSlotActivityForCapabilityOutcome(
  client: PrismaClient,
  input: {
    projectId: string;
    subjectType: string;
    subjectId: string;
    emittedAt: Date;
    capabilityId?: string | null;
    outcomeType?: string | null;
  }
): Promise<number> {
  const resolved = await findRequirementIdForSubject(client, input.subjectType, input.subjectId);
  const service = new SlotBindingService(client);
  let activityScope: { projectId: string; requirementId: string } | null = null;
  if (!resolved || resolved.projectId !== input.projectId) {
    if (input.subjectType === "subtask") {
      const task = await client.task.findUnique({
        where: { id: input.subjectId },
        select: { projectId: true, requirementId: true }
      });
      if (!task?.requirementId || task.projectId !== input.projectId) return 0;
      activityScope = { projectId: input.projectId, requirementId: task.requirementId };
    } else {
      return 0;
    }
  } else {
    activityScope = { projectId: resolved.projectId, requirementId: resolved.requirementId };
  }

  const updated = await service.updateActivityForRequirement({
    projectId: activityScope.projectId,
    requirementId: activityScope.requirementId,
    at: input.emittedAt
  });
  if (input.capabilityId === "requirement.cancel" && input.outcomeType === "cancelled") {
    await reconcileCancelledRequirementProjection(client, activityScope);
  }
  return updated;
}

export type CancelledRequirementProjectionReconcileResult = {
  requirementCancelled: boolean;
  superseded: number;
  releasedSlotIds: string[];
  busySlotIds: string[];
};

export async function reconcileCancelledRequirementProjection(
  client: PrismaClient,
  input: {
    projectId: string;
    requirementId: string;
  }
): Promise<CancelledRequirementProjectionReconcileResult> {
  const requirement = await client.requirement.findFirst({
    where: {
      id: input.requirementId,
      projectId: input.projectId
    },
    select: {
      status: true
    }
  });
  if (requirement?.status !== "cancelled") {
    return {
      requirementCancelled: false,
      superseded: 0,
      releasedSlotIds: [],
      busySlotIds: []
    };
  }

  const superseded = await supersedePendingRequirementDispatches(client, input);
  const bindings = await client.slotBinding.findMany({
    where: {
      projectId: input.projectId,
      requirementId: input.requirementId
    },
    orderBy: {
      updatedAt: "desc"
    }
  });
  const releasedSlotIds: string[] = [];
  const busySlotIds: string[] = [];
  const service = new SlotBindingService(client);
  const project = await client.project.findUnique({
    where: { id: input.projectId },
    select: { slotCount: true }
  });
  if (!project) {
    return {
      requirementCancelled: true,
      superseded,
      releasedSlotIds,
      busySlotIds
    };
  }

  for (const binding of bindings) {
    if (!isSlotId(binding.slotId, project.slotCount)) {
      continue;
    }
    if (binding.state === "busy") {
      busySlotIds.push(binding.slotId);
      continue;
    }
    const released = await service.releaseSlot({
      projectId: input.projectId,
      slotId: binding.slotId,
      reason: "requirement_cancelled",
      releasedBy: "system"
    });
    releasedSlotIds.push(released.slotId);
  }

  return {
    requirementCancelled: true,
    superseded,
    releasedSlotIds,
    busySlotIds
  };
}

export async function reconcileCancelledRequirementProjectionsForProject(
  client: PrismaClient,
  projectId: string
): Promise<CancelledRequirementProjectionReconcileResult[]> {
  const requirements = await client.requirement.findMany({
    where: {
      projectId,
      status: "cancelled"
    },
    select: {
      id: true
    }
  });
  const results: CancelledRequirementProjectionReconcileResult[] = [];
  for (const requirement of requirements) {
    results.push(
      await reconcileCancelledRequirementProjection(client, {
        projectId,
        requirementId: requirement.id
      })
    );
  }
  return results;
}

function appendHistory(historyJson: string, entry: Record<string, unknown>): string {
  let history: unknown[] = [];
  try {
    const parsed = JSON.parse(historyJson) as unknown;
    history = Array.isArray(parsed) ? parsed : [];
  } catch {
    history = [];
  }
  return JSON.stringify([...history, entry]);
}

function createDefaultSlotBoundCallback(client: PrismaClient): SlotBindingServiceOptions["onSlotBound"] {
  return async (input) => {
    if (process.env.NODE_ENV !== "test") {
      try {
        const result = await createDefaultSlotContextResetter().resetSlotContext({
          projectId: input.projectId,
          slotId: input.slotId,
          requirementId: input.requirementId,
          trigger: "bind"
        });
        if (result.status !== "ok") {
          console.warn("[slot-context-reset] /new delivery after bind was not fully successful", summarizeSlotContextResetResult(result));
        }
      } catch (error) {
        console.warn("[slot-context-reset] /new delivery after bind failed", error);
      }
    }
    await syncSlotTips(input.projectId, { client, logger: consoleSlotTipsLogger });
  };
}

function createDefaultSlotReleasedCallback(client: PrismaClient): SlotBindingServiceOptions["onSlotReleased"] {
  return async (input) => {
    await syncSlotTips(input.projectId, { client, logger: consoleSlotTipsLogger });
  };
}

const consoleSlotTipsLogger = {
  warn(input: Record<string, unknown>, message: string): void {
    console.warn(message, input);
  }
};
