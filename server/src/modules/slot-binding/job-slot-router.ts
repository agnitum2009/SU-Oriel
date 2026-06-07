import { randomBytes, randomUUID } from "node:crypto";

import type { AnchorDispatchQueue, PrismaClient } from "@prisma/client";

import { prisma } from "../../db/prisma.js";
import {
  enforceRequirementDispatchQueuePolicy,
  isCancelDispatchCommand,
  supersedePendingRequirementDispatches
} from "../anchor-broker/anchor-dispatch-queue-policy.js";
import { CcbdClientService } from "../ccbd-client/ccbd-client.service.js";
import { emitEventInTransaction } from "../events/event-journal.service.js";
import { agentNamesForSlot } from "../slot-topology/slot-topology.service.js";
import { SlotBindingService, type SlotId, isSlotId } from "./slot-binding.service.js";

export type SlotQueuedRequest = {
  jobId?: string;
  projectId: string;
  requirementId: string;
  subjectType: "requirement" | "subtask";
  subjectId: string;
  command: string;
  dispatchPayload?: Record<string, unknown>;
  requestedAt?: Date;
  preferredSlotId?: string | null;
  step?: string;
  reason?: "no_idle_slot" | "sticky_slot_unavailable" | "slot_recovering";
};

export type SlotSubmitInput = {
  projectId: string;
  projectRoot: string;
  slotId: SlotId;
  toAgent: string;
  taskId: string;
  body: string;
};

export type JobSlotRouterResult = {
  jobId: string;
  slotId: SlotId | null;
  status: "queued" | "submitted";
  queuedAt: Date;
};

type SubmitToSlot = (input: SlotSubmitInput) => Promise<{ jobId: string; traceRef?: string | null }>;
type QueueRowScope = {
  projectId: string;
  requirementId: string;
  subjectType: "requirement" | "subtask";
  subjectId: string;
};

export class JobSlotRouter {
  private readonly client: PrismaClient;
  private readonly slotBinding: SlotBindingService;
  private readonly submitToSlot: SubmitToSlot;
  private readonly submitImmediately: boolean;

  constructor(options: {
    prismaClient?: PrismaClient;
    slotBinding?: SlotBindingService;
    submitToSlot?: SubmitToSlot;
    submitImmediately?: boolean;
  } = {}) {
    this.client = options.prismaClient ?? prisma;
    this.slotBinding = options.slotBinding ?? new SlotBindingService(this.client);
    this.submitToSlot = options.submitToSlot ?? defaultSubmitToSlot;
    this.submitImmediately = options.submitImmediately ?? false;
  }

  async enqueue(input: SlotQueuedRequest): Promise<JobSlotRouterResult> {
    const jobId = input.jobId ?? createSlotDispatchJobId();
    const queuedAt = input.requestedAt ?? new Date();
    await enforceRequirementDispatchQueuePolicy(this.client, {
      projectId: input.projectId,
      requirementId: input.requirementId,
      command: input.command,
      ignoreJobId: jobId
    });
    const slot = await this.resolveOrClaimSlot(input);
    if (!slot || slot.state === "unhealthy" || slot.state === "recovering" || slot.state === "draining") {
      await this.recordQueuedRequest({
        ...input,
        jobId,
        queuedAt,
        slotId: slot?.slotId ?? null,
        status: "pending",
        reason: slot ? "sticky_slot_unavailable" : input.reason ?? "no_idle_slot"
      });
      return { jobId, slotId: null, status: "queued", queuedAt };
    }

    const row = await this.recordQueuedRequest({
      ...input,
      jobId,
      queuedAt,
      slotId: slot.slotId,
      status: "pending",
      reason: input.reason ?? "no_idle_slot"
    });
    if (!this.submitImmediately) {
      void row;
      return { jobId, slotId: slot.slotId as SlotId, status: "queued", queuedAt };
    }

    const project = await this.client.project.findUniqueOrThrow({
      where: { id: input.projectId },
      select: { localPath: true }
    });
    const taskId = await this.resolveTaskId(input);
    const submitResult = await this.submitToSlot({
      projectId: input.projectId,
      projectRoot: project.localPath,
      slotId: slot.slotId as SlotId,
      toAgent: claudeAgentForSlot(slot.slotId),
      taskId,
      body: input.command
    });

    await this.client.anchorDispatchQueue.update({
      where: { id: row.id },
      data: {
        status: "submitted",
        submittedAt: new Date(),
        errorMessage: null
      }
    });
    await this.slotBinding.markBusy(input.projectId, slot.slotId as SlotId);

    if (submitResult.traceRef) {
      await this.client.eventJournal.updateMany({
        where: {
          correlationId: jobId,
          eventType: "slot_queued_request"
        },
        data: {
          payloadJson: JSON.stringify({
            jobId,
            slotId: slot.slotId,
            command: input.command,
            ...(input.dispatchPayload ? { dispatchPayload: input.dispatchPayload } : {}),
            ...(input.step ? { step: input.step } : {}),
            reason: input.reason ?? "no_idle_slot",
            traceRef: submitResult.traceRef
          })
        }
      });
    }

    return { jobId, slotId: slot.slotId as SlotId, status: "submitted", queuedAt };
  }

  async tick(projectId: string): Promise<{ submitted: number; queued: number; failed: number }> {
    const rows = await this.client.anchorDispatchQueue.findMany({
      where: {
        status: "pending",
        anchorId: "slot-unassigned"
      },
      orderBy: { queuedAt: "asc" },
      take: 20
    });
    let submitted = 0;
    let queued = 0;
    let failed = 0;
    for (const row of rows) {
      try {
        const scope = await this.resolveQueueRowScope(row);
        if (!scope) {
          failed++;
          await this.client.anchorDispatchQueue.update({
            where: { id: row.id },
            data: { status: "failed", failedAt: new Date(), errorMessage: "requirement scope missing" }
          });
          continue;
        }
        if (scope.projectId !== projectId) {
          continue;
        }
        const slot = await this.resolveOrClaimSlot({
          projectId: scope.projectId,
          requirementId: scope.requirementId,
          subjectType: scope.subjectType,
          subjectId: scope.subjectId,
          command: row.command,
          jobId: row.jobId
        });
        if (!slot || slot.state === "unhealthy" || slot.state === "recovering" || slot.state === "draining") {
          queued++;
          continue;
        }
        await this.client.anchorDispatchQueue.update({
          where: { id: row.id },
          data: {
            anchorId: slot.slotId,
            status: "pending",
            errorMessage: null
          }
        });
        submitted++;
      } catch {
        failed++;
      }
    }
    return { submitted, queued, failed };
  }

  async resolveSlotForSubject(subjectType: string, subjectId: string): Promise<string | null> {
    if (subjectType === "requirement") {
      const requirement = await this.client.requirement.findUnique({
        where: { id: subjectId },
        select: { projectId: true }
      });
      if (!requirement) return null;
      const binding = await this.slotBinding.findBindingForRequirement(requirement.projectId, subjectId);
      return binding?.slotId ?? null;
    }
    if (subjectType === "subtask") {
      const binding = await this.slotBinding.resolveSlotForSubtask(subjectId);
      return binding?.slotId ?? null;
    }
    return null;
  }

  private async resolveOrClaimSlot(input: SlotQueuedRequest) {
    const existing = await this.slotBinding.findBindingForRequirement(input.projectId, input.requirementId);
    if (existing) return existing;
    return await this.slotBinding.bindRequirement({
      projectId: input.projectId,
      requirementId: input.requirementId
    });
  }

  private async recordQueuedRequest(input: SlotQueuedRequest & {
    jobId: string;
    queuedAt: Date;
    slotId: string | null;
    status: "pending";
    reason: "no_idle_slot" | "sticky_slot_unavailable" | "slot_recovering";
  }) {
    return await this.client.$transaction(async (tx) => {
      await enforceRequirementDispatchQueuePolicy(tx, {
        projectId: input.projectId,
        requirementId: input.requirementId,
        command: input.command,
        ignoreJobId: input.jobId
      });
      if (isCancelDispatchCommand(input.command)) {
        await supersedePendingRequirementDispatches(tx, {
          projectId: input.projectId,
          requirementId: input.requirementId,
          ignoreJobId: input.jobId
        });
      }
      const row = await tx.anchorDispatchQueue.upsert({
        where: { jobId: input.jobId },
        create: {
          jobId: input.jobId,
          anchorId: input.slotId ?? "slot-unassigned",
          subjectType: input.subjectType,
          subjectId: input.subjectId,
          command: input.command,
          status: input.status,
          queuedAt: input.queuedAt
        },
        update: {
          anchorId: input.slotId ?? "slot-unassigned",
          subjectType: input.subjectType,
          subjectId: input.subjectId,
          command: input.command,
          status: input.status,
          errorMessage: null
        }
      });
      await emitEventInTransaction(tx, {
        event_id: randomUUID(),
        event_type: "slot_queued_request",
        subject_type: input.subjectType,
        subject_id: input.subjectId,
        anchor_id: input.slotId ?? null,
        emitted_at: input.queuedAt.toISOString(),
        source_actor: "system",
        source_component: "console",
        correlation_id: input.jobId,
        idempotency_key: `slot-queued-request:${input.jobId}`,
        payload: {
          jobId: input.jobId,
          slotId: input.slotId,
          command: input.command,
          ...(input.dispatchPayload ? { dispatchPayload: input.dispatchPayload } : {}),
          ...(input.step ? { step: input.step } : {}),
          reason: input.reason
        }
      });
      return row;
    });
  }

  private async resolveTaskId(input: SlotQueuedRequest): Promise<string> {
    if (input.subjectType === "requirement") {
      return input.requirementId;
    }
    const task = await this.client.task.findUniqueOrThrow({
      where: { id: input.subjectId },
      select: { taskKey: true }
    });
    return task.taskKey;
  }

  private async resolveQueueRowScope(row: AnchorDispatchQueue): Promise<QueueRowScope | null> {
    if (row.subjectType === "requirement") {
      const requirement = await this.client.requirement.findUnique({
        where: { id: row.subjectId },
        select: { id: true, projectId: true }
      });
      return requirement
        ? {
            projectId: requirement.projectId,
            requirementId: requirement.id,
            subjectType: "requirement",
            subjectId: requirement.id
          }
        : null;
    }
    if (row.subjectType !== "subtask") {
      return null;
    }
    const task = await this.client.task.findUnique({
      where: { id: row.subjectId },
      select: { projectId: true, requirementId: true }
    });
    if (!task?.requirementId) return null;
    return {
      projectId: task.projectId,
      requirementId: task.requirementId,
      subjectType: "subtask",
      subjectId: row.subjectId
    };
  }
}

export function claudeAgentForSlot(slotId: string): string {
  if (!isSlotId(slotId)) {
    throw new Error(`invalid slot id: ${slotId}`);
  }
  return agentNamesForSlot(slotId)[0];
}

export function createSlotDispatchJobId(): string {
  return `job_${randomBytes(6).toString("hex")}`;
}

async function defaultSubmitToSlot(input: SlotSubmitInput): Promise<{ jobId: string; traceRef?: string | null }> {
  const client = new CcbdClientService({
    projectRoot: input.projectRoot
  });
  const result = await client.submit({
    toAgent: input.toAgent,
    taskId: input.taskId,
    body: input.body,
    fromActor: "system",
    messageType: "ask"
  });
  return {
    jobId: result.jobId,
    traceRef: result.traceRef
  };
}
