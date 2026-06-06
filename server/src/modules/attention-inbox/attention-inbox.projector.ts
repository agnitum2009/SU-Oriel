import type {
  ConsultRequest,
  Document,
  EventJournal,
  ReviewIntent,
  SlotBinding
} from "@prisma/client";

import { getTaskEventSeverity, type AttentionSeverity } from "./attention-severity.js";
import type { AttentionCta, AttentionItem, AttentionKind } from "./attention-inbox.types.js";

export interface AttentionTaskContext {
  id: string;
  taskKey: string;
  title: string;
  currentNode: string | null;
  requirementId: string | null;
  requirementTitle: string | null;
}

type DevTaskDoc = Pick<Document, "frontmatterJson" | "path" | "taskKey" | "title" | "updatedAt">;
type ReviewIntentRow = Pick<
  ReviewIntent,
  "id" | "projectId" | "taskId" | "taskKey" | "intentType" | "payloadJson" | "status" | "actor" | "createdAt" | "updatedAt"
>;
type ConsultRequestRow = Pick<
  ConsultRequest,
  "id" | "taskId" | "taskKey" | "nodeId" | "message" | "targetAgent" | "status" | "createdAt" | "consumedAt"
>;
type EventJournalRow = Pick<
  EventJournal,
  | "id"
  | "eventId"
  | "eventType"
  | "projectId"
  | "subjectType"
  | "subjectId"
  | "subjectKey"
  | "anchorId"
  | "payloadJson"
  | "emittedAt"
  | "sourceActor"
  | "sourceComponent"
  | "createdAt"
  | "updatedAt"
>;
type SlotBindingRow = Pick<SlotBinding, "slotId" | "projectId" | "requirementId" | "state" | "updatedAt" | "lastActivityAt"> & {
  requirement?: { title: string } | null;
};

const REVIEW_INTENT_LABELS: Record<string, string> = {
  mark_review_pass: "Review pass",
  request_replan: "Request replan",
  request_escalate: "Request escalate"
};

const EVENT_JOURNAL_ATTENTION_KINDS = {
  codex_receipt_ready: "codex_receipt_ready",
  codex_rejected: "codex_rejected",
  state_write_conflict: "state_write_conflict",
  anchor_dispatch_failed: "anchor_dispatch_failed"
} as const satisfies Record<string, AttentionKind>;

const EVENT_TITLE_BY_KIND: Record<keyof typeof EVENT_JOURNAL_ATTENTION_KINDS, string> = {
  codex_receipt_ready: "Codex 实施回执就绪",
  codex_rejected: "Codex 拒绝派工",
  state_write_conflict: "State 写冲突",
  anchor_dispatch_failed: "Anchor 派发失败"
};

export const ATTENTION_EVENT_TYPES = Object.keys(EVENT_JOURNAL_ATTENTION_KINDS);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function record(value: unknown): Record<string, unknown> {
  const parsed = parseJson(value);
  return isRecord(parsed) ? parsed : {};
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function brief(value: string | undefined, fallback: string, maxLength = 140): string {
  return (value ?? fallback).replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function dateIso(value: unknown, fallback: Date): string {
  const raw = text(value);
  const date = raw ? new Date(raw) : fallback;
  return Number.isNaN(date.getTime()) ? fallback.toISOString() : date.toISOString();
}

function taskCta(projectId: string, task: AttentionTaskContext | null): AttentionCta {
  if (task) {
    return {
      type: "task",
      label: "打开任务",
      projectId,
      requirementId: task.requirementId,
      taskId: task.id,
      taskKey: task.taskKey
    };
  }
  return { type: "project", label: "打开项目", projectId };
}

function requirementCta(projectId: string, requirementId: string | null, task: AttentionTaskContext | null): AttentionCta {
  if (requirementId) {
    return {
      type: "requirement",
      label: "打开需求",
      projectId,
      requirementId,
      taskId: task?.id ?? null,
      taskKey: task?.taskKey ?? null
    };
  }
  return taskCta(projectId, task);
}

function slotCta(projectId: string, slotId: string, requirementId: string | null): AttentionCta {
  return {
    type: "slot",
    label: "定位 slot",
    projectId,
    requirementId,
    slotId
  };
}

function reviewPayload(intent: ReviewIntentRow): Record<string, unknown> {
  const parsed = parseJson(intent.payloadJson);
  return typeof parsed === "string" ? { summary: parsed } : record(parsed);
}

export function projectReviewIntent(
  intent: ReviewIntentRow,
  task: AttentionTaskContext | null
): AttentionItem {
  const payload = reviewPayload(intent);
  return {
    ref: `review_intent:${intent.id}`,
    kind: "review_intent",
    source: "review_intent",
    severity: "attention",
    subjectType: "task",
    projectId: intent.projectId,
    requirementId: task?.requirementId ?? null,
    taskId: intent.taskId,
    taskKey: intent.taskKey,
    slotId: null,
    title: "等待用户 Review 决策",
    summary: brief(text(payload.summary ?? payload.comment ?? payload.intent), `Review intent: ${intent.intentType}`),
    createdAt: intent.createdAt.toISOString(),
    updatedAt: intent.updatedAt.toISOString(),
    cta: taskCta(intent.projectId, task),
    metadata: {
      intentId: intent.id,
      intentType: intent.intentType,
      ctaLabel: REVIEW_INTENT_LABELS[intent.intentType] ?? "Review",
      nodeId: text(payload.node_id ?? payload.nodeId) ?? task?.currentNode ?? null,
      actor: intent.actor
    }
  };
}

export function projectConsultRequest(
  projectId: string,
  consultRequest: ConsultRequestRow,
  task: AttentionTaskContext | null
): AttentionItem {
  return {
    ref: `consult_request:${consultRequest.id}`,
    kind: "consult_request",
    source: "consult_request",
    severity: "attention",
    subjectType: "task",
    projectId,
    requirementId: task?.requirementId ?? null,
    taskId: consultRequest.taskId,
    taskKey: consultRequest.taskKey,
    slotId: null,
    title: `等待 consult ${consultRequest.targetAgent}`,
    summary: brief(consultRequest.message, "Consult request"),
    createdAt: consultRequest.createdAt.toISOString(),
    updatedAt: consultRequest.consumedAt?.toISOString() ?? null,
    cta: taskCta(projectId, task),
    metadata: {
      consultRequestId: consultRequest.id,
      targetAgent: consultRequest.targetAgent,
      nodeId: consultRequest.nodeId || task?.currentNode || null
    }
  };
}

function devTaskFrontmatter(doc: DevTaskDoc): Record<string, unknown> {
  return record(doc.frontmatterJson ?? "{}");
}

export function projectDevTaskDocument(
  projectId: string,
  doc: DevTaskDoc,
  task: AttentionTaskContext | null
): AttentionItem[] {
  const frontmatter = devTaskFrontmatter(doc);
  return [
    ...projectApprovalRecords(projectId, frontmatter, doc, task),
    ...projectPendingUserDecision(projectId, frontmatter, doc, task)
  ];
}

function projectApprovalRecords(
  projectId: string,
  frontmatter: Record<string, unknown>,
  doc: DevTaskDoc,
  task: AttentionTaskContext | null
): AttentionItem[] {
  const parsed = parseJson(frontmatter.approval_records ?? frontmatter.approvalRecords);
  const rows = Array.isArray(parsed) ? parsed.map(record) : [];
  return rows.flatMap((approval, index) => {
    if (approval.decided !== false) return [];
    const id = text(approval.id) ?? String(index);
    const rawRef = `approval_records[${index}]`;
    return [
      {
        ref: `dev_task_approval:${doc.taskKey ?? task?.taskKey ?? "unknown"}/${rawRef}`,
        kind: "dev_task_approval",
        source: "dev_task",
        severity: "attention",
        subjectType: "task",
        projectId,
        requirementId: task?.requirementId ?? null,
        taskId: task?.id ?? null,
        taskKey: doc.taskKey ?? task?.taskKey ?? null,
        slotId: null,
        title: "等待开发任务审批",
        summary: brief(text(approval.summary ?? approval.question ?? approval.gate), "Approval pending"),
        createdAt: dateIso(approval.created_at ?? approval.createdAt ?? approval.timestamp, doc.updatedAt),
        updatedAt: doc.updatedAt.toISOString(),
        cta: taskCta(projectId, task),
        metadata: {
          approvalId: id,
          nodeId: text(approval.node_id ?? approval.nodeId) ?? task?.currentNode ?? null,
          rawRef,
          path: doc.path
        }
      } satisfies AttentionItem
    ];
  });
}

function projectPendingUserDecision(
  projectId: string,
  frontmatter: Record<string, unknown>,
  doc: DevTaskDoc,
  task: AttentionTaskContext | null
): AttentionItem[] {
  const decision = record(frontmatter.pending_user_decision ?? frontmatter.pendingUserDecision);
  if (Object.keys(decision).length === 0) return [];
  const id = text(decision.id) ?? "current";
  const rawRef = "pending_user_decision";
  return [
    {
      ref: `dev_task_approval:${doc.taskKey ?? task?.taskKey ?? "unknown"}/${rawRef}`,
      kind: "dev_task_user_decision",
      source: "dev_task",
      severity: "attention",
      subjectType: "task",
      projectId,
      requirementId: task?.requirementId ?? null,
      taskId: task?.id ?? null,
      taskKey: doc.taskKey ?? task?.taskKey ?? null,
      slotId: null,
      title: "等待用户决策",
      summary: brief(text(decision.summary ?? decision.question ?? decision.prompt), "Pending user decision"),
      createdAt: dateIso(decision.created_at ?? decision.createdAt ?? decision.timestamp, doc.updatedAt),
      updatedAt: doc.updatedAt.toISOString(),
      cta: taskCta(projectId, task),
      metadata: {
        decisionId: id,
        nodeId: text(decision.node_id ?? decision.nodeId) ?? task?.currentNode ?? null,
        rawRef,
        path: doc.path
      }
    }
  ];
}

function eventSeverity(eventType: string): AttentionSeverity {
  if (eventType === "codex_receipt_ready") return getTaskEventSeverity("codex_receipt_ready");
  if (eventType === "codex_rejected") return getTaskEventSeverity("codex_rejected");
  if (eventType === "state_write_conflict") return getTaskEventSeverity("state_write_conflict");
  return "warning";
}

export function projectEventJournal(
  event: EventJournalRow,
  taskById: Map<string, AttentionTaskContext>,
  requirementTitleById: Map<string, string>
): AttentionItem | null {
  if (!Object.prototype.hasOwnProperty.call(EVENT_JOURNAL_ATTENTION_KINDS, event.eventType)) return null;
  const kind = EVENT_JOURNAL_ATTENTION_KINDS[event.eventType as keyof typeof EVENT_JOURNAL_ATTENTION_KINDS];
  const payload = record(event.payloadJson);
  const task = event.subjectType === "subtask" ? taskById.get(event.subjectId) ?? null : null;
  const requirementId = event.subjectType === "requirement" ? event.subjectId : task?.requirementId ?? null;
  const requirementTitle = requirementId ? requirementTitleById.get(requirementId) ?? task?.requirementTitle ?? null : null;
  return {
    ref: `event_journal:${event.eventId}`,
    kind,
    source: "event_journal",
    severity: eventSeverity(event.eventType),
    subjectType: event.subjectType === "requirement" ? "requirement" : "task",
    projectId: event.projectId,
    requirementId,
    taskId: task?.id ?? (event.subjectType === "subtask" ? event.subjectId : null),
    taskKey: task?.taskKey ?? event.subjectKey,
    slotId: event.anchorId,
    title: EVENT_TITLE_BY_KIND[event.eventType as keyof typeof EVENT_TITLE_BY_KIND],
    summary: eventSummary(event.eventType, payload, requirementTitle ?? task?.title ?? event.subjectKey ?? undefined),
    createdAt: event.emittedAt.toISOString(),
    updatedAt: event.updatedAt.toISOString(),
    cta: requirementCta(event.projectId, requirementId, task),
    metadata: {
      eventId: event.eventId,
      eventType: event.eventType,
      sourceActor: event.sourceActor,
      sourceComponent: event.sourceComponent,
      payload
    }
  };
}

function eventSummary(eventType: string, payload: Record<string, unknown>, fallbackSubject?: string): string {
  if (eventType === "codex_receipt_ready") {
    return brief(text(payload.receipt_summary ?? payload.receipt_ref), fallbackSubject ?? "Codex receipt ready");
  }
  if (eventType === "codex_rejected") {
    return brief(text(payload.reason ?? payload.spec_path), fallbackSubject ?? "Codex rejected dispatch");
  }
  if (eventType === "state_write_conflict") {
    return brief(text(payload.primitive ?? payload.resource_type), fallbackSubject ?? "State write conflict");
  }
  if (eventType === "anchor_dispatch_failed") {
    return brief(text(payload.errorMessage ?? payload.errorCode ?? payload.jobId), fallbackSubject ?? "Anchor dispatch failed");
  }
  return fallbackSubject ?? eventType;
}

export function projectSlotBinding(row: SlotBindingRow): AttentionItem {
  const kind: AttentionKind = row.state === "recovering" ? "slot_recovering" : "slot_unhealthy";
  const title = row.state === "recovering" ? "Slot 正在恢复" : "Slot 状态异常";
  return {
    ref: `slot_binding:${row.slotId}/${row.state}`,
    kind,
    source: "slot_binding",
    severity: "warning",
    subjectType: "slot",
    projectId: row.projectId,
    requirementId: row.requirementId,
    taskId: null,
    taskKey: null,
    slotId: row.slotId,
    title,
    summary: `${row.slotId}: ${row.requirement?.title ?? row.state}`,
    createdAt: (row.lastActivityAt ?? row.updatedAt).toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    cta: slotCta(row.projectId, row.slotId, row.requirementId),
    metadata: {
      state: row.state
    }
  };
}
