import type { PrismaClient } from "@prisma/client";

import { prisma } from "../../db/prisma.js";
import {
  ATTENTION_EVENT_TYPES,
  type AttentionTaskContext,
  projectConsultRequest,
  projectDevTaskDocument,
  projectEventJournal,
  projectReviewIntent,
  projectSlotBinding
} from "./attention-inbox.projector.js";
import type {
  AttentionAckResponse,
  AttentionItem,
  AttentionListResponse,
  AttentionSettingsResponse
} from "./attention-inbox.types.js";

const DEFAULT_EVENT_LOOKBACK_DAYS = 30;
const SEVERITY_RANK: Record<AttentionItem["severity"], number> = {
  attention: 3,
  warning: 2,
  info: 1
};

export class AttentionProjectNotFoundError extends Error {
  constructor() {
    super("项目不存在");
  }
}

export interface ComputeAttentionOptions {
  now?: Date;
  eventLookbackDays?: number;
}

export interface AttentionInboxServiceLike {
  computeAttention(projectId: string, options?: ComputeAttentionOptions): Promise<AttentionListResponse>;
  ackAttention(projectId: string, ref: string, now?: Date): Promise<AttentionAckResponse>;
  getSettings(projectId: string): Promise<AttentionSettingsResponse>;
  putSettings(projectId: string, dndUntil: Date | null): Promise<AttentionSettingsResponse>;
}

export class AttentionInboxService implements AttentionInboxServiceLike {
  constructor(private readonly db: PrismaClient = prisma) {}

  async computeAttention(
    projectId: string,
    options: ComputeAttentionOptions = {}
  ): Promise<AttentionListResponse> {
    const now = options.now ?? new Date();
    const eventCutoff = new Date(
      now.getTime() - (options.eventLookbackDays ?? DEFAULT_EVENT_LOOKBACK_DAYS) * 24 * 60 * 60 * 1000
    );

    const [
      project,
      tasks,
      requirements,
      reviewIntents,
      consultRequests,
      devTaskDocs,
      eventRows,
      slotRows,
      ackRows,
      settings
    ] = await Promise.all([
      this.db.project.findUnique({ where: { id: projectId }, select: { id: true } }),
      this.db.task.findMany({
        where: { projectId },
        select: {
          id: true,
          taskKey: true,
          title: true,
          currentNode: true,
          requirementId: true,
          requirement: { select: { title: true } }
        }
      }),
      this.db.requirement.findMany({
        where: { projectId },
        select: { id: true, title: true }
      }),
      this.db.reviewIntent.findMany({
        where: { projectId, status: "pending" },
        orderBy: { createdAt: "asc" }
      }),
      this.db.consultRequest.findMany({
        where: { status: "pending", task: { projectId } },
        orderBy: { createdAt: "asc" }
      }),
      this.db.document.findMany({
        where: { projectId, kind: "dev_task" },
        select: { path: true, taskKey: true, title: true, frontmatterJson: true, updatedAt: true },
        orderBy: { path: "asc" }
      }),
      this.db.eventJournal.findMany({
        where: {
          projectId,
          eventType: { in: ATTENTION_EVENT_TYPES },
          emittedAt: { gte: eventCutoff }
        },
        orderBy: { emittedAt: "asc" }
      }),
      this.db.slotBinding.findMany({
        where: {
          projectId,
          requirementId: { not: null },
          state: { in: ["unhealthy", "recovering"] }
        },
        include: { requirement: { select: { title: true } } }
      }),
      this.db.attentionAck.findMany({
        where: { projectId },
        select: { ref: true }
      }),
      this.db.projectAttentionSettings.findUnique({
        where: { projectId }
      })
    ]);

    if (!project) {
      throw new AttentionProjectNotFoundError();
    }

    const taskById = new Map<string, AttentionTaskContext>();
    const taskByKey = new Map<string, AttentionTaskContext>();
    for (const task of tasks) {
      const context: AttentionTaskContext = {
        id: task.id,
        taskKey: task.taskKey,
        title: task.title,
        currentNode: task.currentNode,
        requirementId: task.requirementId,
        requirementTitle: task.requirement?.title ?? null
      };
      taskById.set(task.id, context);
      taskByKey.set(task.taskKey, context);
    }

    const requirementTitleById = new Map(requirements.map((requirement) => [requirement.id, requirement.title]));
    for (const task of taskById.values()) {
      if (task.requirementId && task.requirementTitle) {
        requirementTitleById.set(task.requirementId, task.requirementTitle);
      }
    }

    const devTaskDocByTaskKey = new Map<string, (typeof devTaskDocs)[number]>();
    for (const doc of devTaskDocs) {
      if (!doc.taskKey) continue;
      if (!devTaskDocByTaskKey.has(doc.taskKey)) {
        devTaskDocByTaskKey.set(doc.taskKey, doc);
      }
    }

    const items = [
      ...reviewIntents.map((intent) => projectReviewIntent(intent, taskById.get(intent.taskId) ?? null)),
      ...consultRequests.map((consultRequest) =>
        projectConsultRequest(projectId, consultRequest, taskById.get(consultRequest.taskId) ?? null)
      ),
      ...[...devTaskDocByTaskKey.values()].flatMap((doc) =>
        projectDevTaskDocument(projectId, doc, doc.taskKey ? taskByKey.get(doc.taskKey) ?? null : null)
      ),
      ...eventRows.flatMap((event) => {
        const item = projectEventJournal(event, taskById, requirementTitleById);
        return item ? [item] : [];
      }),
      ...slotRows.map((row) => projectSlotBinding(row))
    ];

    const ackedRefs = new Set(ackRows.map((row) => row.ref));
    const unacked = items.filter((item) => !ackedRefs.has(item.ref));
    const dndActive = settings?.dndUntil ? settings.dndUntil.getTime() > now.getTime() : false;
    const visible = dndActive ? [] : unacked;

    visible.sort(compareAttentionItems);

    return {
      project_id: projectId,
      items: visible,
      count: visible.length
    };
  }

  async ackAttention(projectId: string, ref: string, now: Date = new Date()): Promise<AttentionAckResponse> {
    await this.ensureProject(projectId);
    const ack = await this.db.attentionAck.upsert({
      where: {
        projectId_ref: {
          projectId,
          ref
        }
      },
      create: {
        projectId,
        ref,
        ackedAt: now
      },
      update: {
        ackedAt: now
      }
    });
    return {
      project_id: projectId,
      ref: ack.ref,
      acked_at: ack.ackedAt.toISOString()
    };
  }

  async getSettings(projectId: string): Promise<AttentionSettingsResponse> {
    await this.ensureProject(projectId);
    const settings = await this.db.projectAttentionSettings.findUnique({
      where: { projectId }
    });
    return serializeSettings(projectId, settings);
  }

  async putSettings(projectId: string, dndUntil: Date | null): Promise<AttentionSettingsResponse> {
    await this.ensureProject(projectId);
    const settings = await this.db.projectAttentionSettings.upsert({
      where: { projectId },
      create: { projectId, dndUntil },
      update: { dndUntil }
    });
    return serializeSettings(projectId, settings);
  }

  private async ensureProject(projectId: string): Promise<void> {
    const project = await this.db.project.findUnique({
      where: { id: projectId },
      select: { id: true }
    });
    if (!project) {
      throw new AttentionProjectNotFoundError();
    }
  }
}

function compareAttentionItems(left: AttentionItem, right: AttentionItem): number {
  const severity = SEVERITY_RANK[right.severity] - SEVERITY_RANK[left.severity];
  if (severity !== 0) return severity;
  const leftTime = new Date(left.createdAt).getTime();
  const rightTime = new Date(right.createdAt).getTime();
  if (leftTime !== rightTime) return rightTime - leftTime;
  return left.ref.localeCompare(right.ref);
}

function serializeSettings(
  projectId: string,
  settings: { dndUntil: Date | null; updatedAt: Date } | null
): AttentionSettingsResponse {
  return {
    project_id: projectId,
    dnd_until: settings?.dndUntil?.toISOString() ?? null,
    updated_at: settings?.updatedAt.toISOString() ?? null
  };
}
