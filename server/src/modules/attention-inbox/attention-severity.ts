import type { TaskEventKind, TaskEventView } from "../task-event-view/task-event-view.types.js";

export type AttentionSeverity = TaskEventView["severity"];

export const TASK_EVENT_SEVERITY_BY_KIND = {
  codex_picked_up: "info",
  codex_receipt_ready: "info",
  codex_rejected: "warning",
  user_arbitration_submitted: "info",
  user_arbitration_required: "attention",
  session_resumed: "info",
  verification_finished: "info",
  batch_cancelled: "warning",
  state_write_conflict: "warning",
  tool_call_denied: "warning",
  requirement_materialized: "info",
  subtask_planning_inherited: "info",
  review_intent_created: "attention",
  review_intent_consumed: "info",
  review_intent_cancelled: "warning",
  transition_proposed: "info",
  transition_applied: "info",
  transition_ineligible: "warning",
  anchor_mounted: "info",
  anchor_destroyed: "info",
  anchor_recovering: "warning"
} satisfies Record<TaskEventKind, AttentionSeverity>;

export function getTaskEventSeverity(kind: TaskEventKind): AttentionSeverity {
  return TASK_EVENT_SEVERITY_BY_KIND[kind];
}
