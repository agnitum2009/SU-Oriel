import type { AttentionSeverity } from "./attention-severity.js";

export type { AttentionSeverity };

export type AttentionSource =
  | "review_intent"
  | "consult_request"
  | "dev_task"
  | "event_journal"
  | "slot_binding"
  | "provider_activity";

export type AttentionKind =
  | "review_intent"
  | "consult_request"
  | "dev_task_approval"
  | "dev_task_user_decision"
  | "codex_receipt_ready"
  | "codex_rejected"
  | "state_write_conflict"
  | "anchor_dispatch_failed"
  | "slot_unhealthy"
  | "slot_recovering"
  | "agent_waiting"
  | "agent_failed"
  | "agent_completed"
  | "agent_attention_suspect";

export type AttentionSubjectType = "project" | "requirement" | "task" | "slot" | "agent";

export interface AttentionCta {
  type: "project" | "requirement" | "task" | "slot";
  label: string;
  projectId: string;
  requirementId?: string | null;
  taskId?: string | null;
  taskKey?: string | null;
  slotId?: string | null;
}

export interface AttentionItem {
  ref: string;
  kind: AttentionKind;
  source: AttentionSource;
  severity: AttentionSeverity;
  subjectType: AttentionSubjectType;
  projectId: string;
  requirementId: string | null;
  taskId: string | null;
  taskKey: string | null;
  slotId: string | null;
  title: string;
  summary: string;
  createdAt: string;
  updatedAt: string | null;
  cta: AttentionCta;
  metadata?: Record<string, unknown>;
}

export interface AttentionListResponse {
  project_id: string;
  items: AttentionItem[];
  count: number;
}

export interface AttentionAckResponse {
  project_id: string;
  ref: string;
  acked_at: string;
}

export interface AttentionSettingsResponse {
  project_id: string;
  dnd_until: string | null;
  updated_at: string | null;
}
