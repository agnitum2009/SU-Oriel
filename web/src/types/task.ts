export interface TaskView {
  id: string;
  projectId: string;
  taskKey: string;
  title: string;
  summary: string | null;
  semanticKind?: string | null;
  kind?: "subtask";
  specSectionId?: string | null;
  implementationOwner?: "claude" | "ccb_codex" | null;
  sprintId?: string | null;
  storyPoints?: number | null;
  // =========================================
  status: string;
  phase: string;
  currentNode: string | null;
  nodeSubstate: string | null;
  runtimeState: string | null;
  lastTransitionId: string | null;
  priority: string;
  progress: number;
  step: number | null;
  blockedReason: string | null;
  requirementId: string | null;
  reviewStatus: string | null;
  updatedAt: string;
}

export interface RequirementAggregationView {
  requirementId: string;
  status: "drafting" | "planning" | "delivering" | "delivered" | "deferred" | "cancelled";
  progress: number;
  epicCount: number;
  directSubtaskCount: number;
  /** @deprecated ADR-0020 Step 5 · retained for one minor version as read-only compatibility. */
  backlogCount: number;
}

export interface TaskTimelineEventView {
  kind: string;
  at: string;
  label: string;
  details?: Record<string, unknown>;
}

export interface TaskTimelineView {
  taskId: string;
  events: TaskTimelineEventView[];
}

export interface AnchorStartResponse {
  anchorId: string;
  anchorPath: string;
  socketPath: string | null;
  status: string;
}

export interface SubtaskBatchCandidateView {
  taskId: string;
  taskKey: string;
  title: string;
  currentNode: string | null;
  status: string;
  hasActiveAnchor: boolean;
  isPendingDispatch: boolean;
  eligible: boolean;
  ineligibleReason: string | null;
}

export interface SubtaskBatchCandidatesResponse {
  candidates: SubtaskBatchCandidateView[];
}

export type SubtaskBatchDispatchItem =
  | {
      taskId: string;
      jobId: string;
      job_id?: string;
      anchorId: string;
      status: "queued";
      queuedAt?: string;
    }
  | {
      taskId: string;
      status: "failed";
      errorMessage: string;
    };

export interface SubtaskBatchDispatchResponse {
  jobId?: string;
  job_id?: string;
  command?: "su-batch";
  slotId?: string | null;
  status?: "queued";
  queuedAt?: string;
  taskIds?: string[];
  items: SubtaskBatchDispatchItem[];
  totalQueued: number;
  totalFailed: number;
}

export interface ReviewIntentView {
  id: string;
  projectId: string;
  taskId: string;
  taskKey: string;
  intentType: "mark_review_pass" | "request_replan" | "request_escalate";
  payload: string | null;
  status: "pending" | "consumed" | "cancelled";
  actor: string | null;
  consumedAt: string | null;
  consumedBy: string | null;
  attemptCount?: number;
  lastError?: string | null;
  lastAttemptAt?: string | null;
  isStale?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TaskDetailView extends TaskView {
  linkedRequirement: {
    id: string;
    title: string;
    verbatimSource: string | null;
  } | null;
  linkedDocuments: Array<{
    id: string;
    path: string;
    kind: string;
    title: string;
    status: string | null;
  }>;
  verificationResult: unknown | null;
  reviewFollowup: string[];
  reviewIntents: ReviewIntentView[];
}

export interface UpdateTaskInput {
  priority?: string;
}

export interface CreateReviewIntentInput {
  intentType: ReviewIntentView["intentType"];
  payload?: string;
}

export type ConsumeReviewIntentInput =
  | {
      consumer: "su-review";
      result: "considered";
    }
  | {
      consumer: "su-review";
      result: "failed";
      failureReason: "parse" | "interpretation" | "consumer_error";
      error: string;
    };

export interface ConsumeReviewIntentResponse {
  success: boolean;
  result: "consumed" | "already_consumed" | "failure_recorded";
  idempotent: boolean;
  intent: ReviewIntentView;
}
