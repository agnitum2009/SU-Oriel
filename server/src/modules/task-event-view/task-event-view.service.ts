import type { AnchorAllocation, EventJournal, ReviewIntent, PrismaClient } from "@prisma/client";

import type {
  TaskEventKind,
  TaskEventView,
  TaskTimelineResult
} from "./task-event-view.types.js";
import { getTaskEventSeverity } from "../attention-inbox/attention-severity.js";

const TITLE_BY_KIND: Record<TaskEventKind, string> = {
  codex_picked_up: "Codex 接受派工",
  codex_receipt_ready: "Codex 实施回执就绪",
  codex_rejected: "Codex 拒绝派工",
  user_arbitration_submitted: "用户仲裁已提交",
  user_arbitration_required: "等待用户决策",
  session_resumed: "Session 恢复",
  verification_finished: "Verification 完成",
  batch_cancelled: "Batch 已取消",
  state_write_conflict: "State 写冲突",
  tool_call_denied: "工具调用被拒",
  requirement_materialized: "Requirement materialize 完成",
  subtask_planning_inherited: "子任务继承需求规划",
  review_intent_created: "Review intent 已创建",
  review_intent_consumed: "Review intent 已消费",
  review_intent_cancelled: "Review intent 已取消",
  transition_proposed: "Transition 已提议",
  transition_applied: "Transition 已生效",
  transition_ineligible: "Transition 未被采纳",
  anchor_mounted: "Anchor 启动就绪",
  anchor_destroyed: "Anchor 已销毁",
  anchor_recovering: "Anchor 正在恢复"
};

function safeParseJson(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return { _parse_error: true, raw: value };
  }
}

function mapEventJournalRow(row: EventJournal): TaskEventView | null {
  const kind = row.eventType as TaskEventKind;
  if (!TITLE_BY_KIND[kind]) return null;
  return {
    id: `ej:${row.id}`,
    kind,
    source: "event_journal",
    at: row.emittedAt.toISOString(),
    title: TITLE_BY_KIND[kind],
    severity: getTaskEventSeverity(kind),
    anchorId: row.anchorId ?? null,
    payload: {
      ...safeParseJson(row.payloadJson),
      eventId: row.eventId,
      sourceActor: row.sourceActor,
      sourceComponent: row.sourceComponent,
      correlationId: row.correlationId,
      stateRevisionSeen: row.stateRevisionSeen,
      anchorId: row.anchorId,
      subjectType: row.subjectType,
      subjectId: row.subjectId,
      subjectKey: row.subjectKey
    }
  };
}

function mapReviewIntentRow(row: ReviewIntent): TaskEventView[] {
  const events: TaskEventView[] = [];

  events.push({
    id: `ri:${row.id}:created`,
    kind: "review_intent_created",
    source: "review_intent",
    at: row.createdAt.toISOString(),
    title: TITLE_BY_KIND.review_intent_created,
    severity: "attention",
    payload: {
      intentId: row.id,
      intentType: row.intentType,
      status: row.status,
      actor: row.actor
    }
  });

  if (row.consumedAt) {
    events.push({
      id: `ri:${row.id}:consumed`,
      kind: "review_intent_consumed",
      source: "review_intent",
      at: row.consumedAt.toISOString(),
      title: TITLE_BY_KIND.review_intent_consumed,
      severity: "info",
      payload: {
        intentId: row.id,
        intentType: row.intentType,
        consumedBy: row.consumedBy
      }
    });
  }

  if (row.status === "cancelled") {
    events.push({
      id: `ri:${row.id}:cancelled`,
      kind: "review_intent_cancelled",
      source: "review_intent",
      at: row.updatedAt.toISOString(),
      title: TITLE_BY_KIND.review_intent_cancelled,
      severity: "warning",
      payload: { intentId: row.id, lastError: row.lastError }
    });
  }

  return events;
}

const ANCHOR_MOUNTED_STATES = new Set(["ready", "busy", "archiving"]);

function mapAnchorAllocationRow(row: AnchorAllocation): TaskEventView[] {
  const events: TaskEventView[] = [];

  const basePayload = {
    anchorId: row.anchorId,
    anchorPath: row.anchorPath,
    socketPath: row.socketPath,
    subjectType: row.subjectType,
    subjectId: row.subjectId,
    subjectKey: row.subjectKey,
    mode: row.mode,
    state: row.state
  };

  if (row.startedAt && ANCHOR_MOUNTED_STATES.has(row.state)) {
    events.push({
      id: `anchor:${row.anchorId}:mounted:${row.startedAt.toISOString()}`,
      kind: "anchor_mounted",
      source: "slot_allocation",
      at: row.startedAt.toISOString(),
      title: TITLE_BY_KIND.anchor_mounted,
      severity: "info",
      anchorId: row.anchorId,
      payload: basePayload
    });
  }

  if (row.state === "recovering") {
    events.push({
      id: `anchor:${row.anchorId}:recovering:${row.updatedAt.toISOString()}`,
      kind: "anchor_recovering",
      source: "slot_allocation",
      at: row.updatedAt.toISOString(),
      title: TITLE_BY_KIND.anchor_recovering,
      severity: "warning",
      anchorId: row.anchorId,
      payload: basePayload
    });
  }

  if (row.state === "destroyed") {
    events.push({
      id: `anchor:${row.anchorId}:destroyed:${row.updatedAt.toISOString()}`,
      kind: "anchor_destroyed",
      source: "slot_allocation",
      at: row.updatedAt.toISOString(),
      title: TITLE_BY_KIND.anchor_destroyed,
      severity: "info",
      anchorId: row.anchorId,
      payload: basePayload
    });
  }

  return events;
}

export interface TaskEventViewServiceLike {
  buildTimeline(taskId: string): Promise<TaskTimelineResult>;
}

export class TaskEventViewService implements TaskEventViewServiceLike {
  constructor(private readonly prisma: PrismaClient) {}

  async buildTimeline(taskId: string): Promise<TaskTimelineResult> {
    const [journalRows, intentRows, anchorRows] = await Promise.all([
      this.prisma.eventJournal.findMany({
        where: { subjectType: "subtask", subjectId: taskId },
        orderBy: { emittedAt: "asc" }
      }),
      this.prisma.reviewIntent.findMany({
        where: { taskId },
        orderBy: { createdAt: "asc" }
      }),
      this.prisma.anchorAllocation.findMany({
        where: {
          subjectType: "subtask",
          subjectId: taskId
        }
      })
    ]);

    const events: TaskEventView[] = [];

    for (const row of journalRows) {
      const mapped = mapEventJournalRow(row);
      if (mapped) events.push(mapped);
    }

    for (const row of intentRows) {
      events.push(...mapReviewIntentRow(row));
    }

    for (const anchor of anchorRows) {
      events.push(...mapAnchorAllocationRow(anchor));
    }

    events.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

    return { taskId, events, hasMore: false };
  }
}
