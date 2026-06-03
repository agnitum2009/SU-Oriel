import type { DocumentDetailView, DocumentView } from "../types/document.js";
import type { AnchorNativeTerminalSpawnResult } from "../types/anchor-terminal.js";
import type {
  ProjectIndexHealthView,
  ProjectInitJobStatusView,
  ProjectKnowledgeBaseInitResponse,
  ProjectOnboardingStatusView,
  ProjectScanStatusView,
  ProjectView
} from "../types/project.js";
import type {
  RequirementDetailView,
  RequirementEditInput,
  RequirementFormValue,
  RequirementReindexResponse,
  RequirementReanalyzeJobStatus,
  RequirementReanalyzeStartResponse,
  RequirementView
} from "../types/requirement.js";
import type { BurndownView, CreateSprintInput, SprintDetailView, SprintView } from "../types/sprint.js";
import type { SyncJobView } from "../types/sync-job.js";
import type { ProjectSettingsPayload, ProjectSettingsView } from "../types/settings.js";
import type { SlotTerminalDescriptor, SlotTerminalTarget } from "../types/slot-terminal.js";
import type {
  ConsumeReviewIntentInput,
  ConsumeReviewIntentResponse,
  AnchorStartResponse,
  CreateReviewIntentInput,
  RequirementAggregationView,
  ReviewIntentView,
  SubtaskBatchCandidatesResponse,
  SubtaskBatchDispatchResponse,
  TaskDetailView,
  TaskTimelineView,
  TaskView,
  TaskWorkspaceView,
  UpdateTaskInput
} from "../types/task.js";

interface ApiListResponse<T> {
  items: T[];
}

interface ApiMessageResponse {
  message?: string;
  code?: string;
  retryAfter?: string;
}

export interface SuOrielVersion {
  name: string;
  version: string;
  gitSha: string;
  buildDate: string;
}

export class ConsoleApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
    public readonly retryAfter?: string
  ) {
    super(message);
  }
}

export function resolveApiBaseUrl(explicitBaseUrl = import.meta.env.VITE_API_BASE_URL): string {
  return explicitBaseUrl?.trim().replace(/\/+$/, "") ?? "";
}

export function buildApiUrl(path: string, explicitBaseUrl = resolveApiBaseUrl()): string {
  const normalizedBaseUrl = resolveApiBaseUrl(explicitBaseUrl);
  return normalizedBaseUrl ? `${normalizedBaseUrl}${path}` : path;
}

async function parseApiError(response: Response, fallbackMessage: string): Promise<ConsoleApiError> {
  const contentType = response.headers.get("Content-Type") ?? "";
  let message = fallbackMessage;
  let code: string | undefined;
  let retryAfter = response.headers.get("retry-after") ?? undefined;

  if (contentType.includes("application/json")) {
    try {
      const payload = (await response.json()) as ApiMessageResponse;
      if (payload.message?.trim()) {
        message = payload.message;
      }
      code = payload.code;
      retryAfter = payload.retryAfter ?? retryAfter;
      return new ConsoleApiError(message, response.status, code, retryAfter);
    } catch {
      // 忽略非标准错误响应，继续回退到文本或默认文案。
    }
  }

  try {
    const text = await response.text();
    if (text.trim()) {
      message = text.trim();
    }
  } catch {
    // 文本读取失败时使用默认错误文案。
  }

  return new ConsoleApiError(message, response.status, code, retryAfter);
}

async function requestJson<T>(path: string, fallbackMessage: string, init?: RequestInit): Promise<T> {
  const response = init ? await fetch(buildApiUrl(path), init) : await fetch(buildApiUrl(path));
  if (!response.ok) {
    throw await parseApiError(response, fallbackMessage);
  }

  return (await response.json()) as T;
}

async function requestVoid(path: string, fallbackMessage: string, init?: RequestInit): Promise<void> {
  const response = init ? await fetch(buildApiUrl(path), init) : await fetch(buildApiUrl(path));
  if (!response.ok) {
    throw await parseApiError(response, fallbackMessage);
  }
}

function optionalText(value: string): string | undefined {
  return value.length > 0 ? value : undefined;
}

export async function fetchProjects(): Promise<ProjectView[]> {
  const payload = await requestJson<ApiListResponse<ProjectView>>("/api/projects", "加载项目列表失败");
  return payload.items;
}

export async function fetchVersion(): Promise<SuOrielVersion> {
  return await requestJson<SuOrielVersion>("/api/version", "加载版本信息失败");
}

export async function createProject(input: {
  name: string;
  localPath: string;
  summary: string;
}): Promise<ProjectView> {
  return await requestJson<ProjectView>("/api/projects", "创建项目失败", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(input)
  });
}

export async function scanProject(projectId: string): Promise<void> {
  await requestVoid(`/api/projects/${projectId}/scan`, "项目扫描失败", {
    method: "POST"
  });
}

export async function fetchProjectIndexHealth(projectId: string): Promise<ProjectIndexHealthView> {
  return await requestJson<ProjectIndexHealthView>(
    `/api/projects/${projectId}/index-health`,
    "加载索引健康状态失败"
  );
}

export async function fetchProjectScanStatus(projectId: string): Promise<ProjectScanStatusView> {
  return await requestJson<ProjectScanStatusView>(
    `/api/projects/${projectId}/scan-status`,
    "加载项目扫描进度失败"
  );
}

export async function fetchProjectOnboardingStatus(projectId: string): Promise<ProjectOnboardingStatusView> {
  return await requestJson<ProjectOnboardingStatusView>(
    `/api/projects/${projectId}/onboarding-status`,
    "加载项目接入状态失败"
  );
}

export async function initProjectKnowledgeBase(projectId: string): Promise<ProjectKnowledgeBaseInitResponse> {
  return await requestJson<ProjectKnowledgeBaseInitResponse>(
    `/api/projects/${projectId}/init-knowledge-base`,
    "初始化项目知识库失败",
    {
      method: "POST"
    }
  );
}

export async function fetchProjectInitJobStatus(
  projectId: string,
  jobId: string
): Promise<ProjectInitJobStatusView> {
  return await requestJson<ProjectInitJobStatusView>(
    `/api/projects/${projectId}/init-job-status?jobId=${encodeURIComponent(jobId)}`,
    "加载项目知识库初始化状态失败"
  );
}

export async function spawnMainTerminal(projectId: string): Promise<AnchorNativeTerminalSpawnResult> {
  return await requestJson<AnchorNativeTerminalSpawnResult>(
    `/api/projects/${projectId}/main-terminal/spawn`,
    "打开实体终端失败",
    {
      method: "POST"
    }
  );
}

export async function fetchTerminalDescriptor(target: SlotTerminalTarget): Promise<SlotTerminalDescriptor> {
  const response = await fetch(buildApiUrl(buildTerminalDescriptorPath(target)));
  if (!response.ok) {
    throw new Error(response.status === 404 ? "slot terminal unavailable" : `slot terminal resolver failed: ${response.status}`);
  }
  return (await response.json()) as SlotTerminalDescriptor;
}

export function buildTerminalDescriptorPath(target: SlotTerminalTarget): string {
  if (target.kind === "requirement") {
    return `/api/projects/${encodeURIComponent(target.projectId)}/requirements/${encodeURIComponent(target.requirementId)}/slot-terminal`;
  }
  return `/api/projects/${encodeURIComponent(target.projectId)}/agent-terminal/${encodeURIComponent(target.group)}`;
}

export async function refreshProjectRequirementStatus(
  projectId: string
): Promise<{ updated: number; checked: number }> {
  return await requestJson<{ updated: number; checked: number }>(
    `/api/projects/${projectId}/refresh-requirement-status`,
    "刷新需求状态失败",
    { method: "POST" }
  );
}

export async function refreshRequirementStatus(
  requirementId: string
): Promise<{ updated: boolean; oldStatus: string | null; newStatus: string | null }> {
  return await requestJson<{ updated: boolean; oldStatus: string | null; newStatus: string | null }>(
    `/api/requirements/${requirementId}/refresh-status`,
    "刷新需求状态失败",
    { method: "POST" }
  );
}

export async function fetchProjectSettings(projectId: string): Promise<ProjectSettingsView> {
  return await requestJson<ProjectSettingsView>(`/api/projects/${projectId}/settings`, "加载项目设置失败");
}

export async function updateProjectSettings(
  projectId: string,
  input: ProjectSettingsPayload
): Promise<ProjectSettingsView> {
  return await requestJson<ProjectSettingsView>(`/api/projects/${projectId}/settings`, "保存项目设置失败", {
    method: "PUT",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(input)
  });
}

export async function fetchDocuments(projectId: string): Promise<DocumentView[]> {
  const payload = await requestJson<ApiListResponse<DocumentView>>(
    `/api/projects/${projectId}/documents`,
    "加载文档列表失败"
  );
  return payload.items;
}

export async function fetchDocumentDetail(documentId: string): Promise<DocumentDetailView> {
  return await requestJson<DocumentDetailView>(`/api/documents/${documentId}`, "加载文档详情失败");
}

export async function fetchTasks(projectId: string): Promise<TaskView[]> {
  const payload = await requestJson<ApiListResponse<TaskView>>(`/api/projects/${projectId}/tasks`, "加载任务列表失败");
  return payload.items;
}

export async function fetchTaskDetail(taskId: string): Promise<TaskDetailView> {
  return await requestJson<TaskDetailView>(`/api/tasks/${taskId}`, "加载任务详情失败");
}

export async function fetchTaskTimeline(taskId: string): Promise<TaskTimelineView> {
  return await requestJson<TaskTimelineView>(`/api/tasks/${taskId}/timeline`, "加载任务运行时间线失败");
}

export type SlotBindingState = "idle" | "bound" | "busy" | "unhealthy" | "recovering" | "draining";

export interface SlotRequirementView {
  id: string;
  title: string;
}

export interface SlotQueueItemView {
  jobId: string;
  slotId: string | null;
  subjectType: string;
  subjectId: string;
  requirementId: string | null;
  requirementTitle: string | null;
  title: string | null;
  command: string;
  queuedAt: string;
}

export interface SlotLaneView {
  slotId: string;
  state: SlotBindingState;
  requirement: SlotRequirementView | null;
  boundAt: string | null;
  busySince: string | null;
  lastActivityAt: string | null;
  stale: {
    detectedAt: string;
    notifiedCount: number;
  } | null;
  unhealthy: {
    degradedReason: string | null;
    severity: string | null;
    emittedAt: string | null;
  } | null;
  queued: SlotQueueItemView[];
}

export interface SlotProjectionView {
  project: {
    id: string;
    name: string;
  };
  main: {
    slotId: "main";
    lane: "coordination";
    state: string;
    canBindBusiness: false;
  };
  slots: SlotLaneView[];
  queue: SlotQueueItemView[];
  generatedAt?: string;
}

export interface SlotReleaseInput {
  confirm: boolean;
  force?: boolean;
  reason?: string;
}

export interface SlotReleaseResponse extends SlotProjectionView {
  slot: SlotLaneView;
}

export interface SlotBindResponse extends SlotProjectionView {
  slot: SlotLaneView;
}

export interface ProjectCcbdStatusView {
  projectId: string;
  projectRoot: string;
  socketPath: string;
  tmuxSocketPath: string;
  startupBlocked: boolean;
  config: {
    path: string;
    exists: boolean;
    coreSignature: string;
    drift: {
      kind: "missing" | "core_drift" | "invalid_windows_topology";
      diff: string;
      requiresUserConfirmation: boolean;
    } | null;
  };
}

export interface ProjectCcbdConfirmRestoreResponse {
  runtime: {
    status: string;
    projectId?: string;
    projectRoot?: string;
    socketPath?: string;
    tmuxSocketPath?: string;
    topologySignature?: string;
  };
  status: ProjectCcbdStatusView;
}

export interface SlotArchiveResponse {
  jobId: string;
  slotId: string;
  requirementId: string;
  status: "queued" | "submitted";
  queuedAt: string;
}

export interface SlotCancelCurrentJobResponse extends SlotProjectionView {
  slot: SlotLaneView;
  cancelledJobId: string;
  cancelResult?: Record<string, unknown>;
}

export async function fetchSlots(projectId: string): Promise<SlotProjectionView> {
  return await requestJson<SlotProjectionView>(
    `/api/projects/${encodeURIComponent(projectId)}/slots`,
    "加载 Slot 拓扑失败"
  );
}

export async function bindSlot(projectId: string, requirementId: string): Promise<SlotBindResponse> {
  return await requestJson<SlotBindResponse>(
    `/api/projects/${encodeURIComponent(projectId)}/requirements/${encodeURIComponent(requirementId)}/bind-slot`,
    "绑定 Slot 失败",
    { method: "POST" }
  );
}

export async function fetchProjectCcbdStatus(projectId: string): Promise<ProjectCcbdStatusView> {
  return await requestJson<ProjectCcbdStatusView>(
    `/api/projects/${encodeURIComponent(projectId)}/project-ccbd/status`,
    "加载 project ccbd 状态失败"
  );
}

export async function confirmProjectCcbdRestore(projectId: string): Promise<ProjectCcbdConfirmRestoreResponse> {
  return await requestJson<ProjectCcbdConfirmRestoreResponse>(
    `/api/projects/${encodeURIComponent(projectId)}/project-ccbd/confirm-restore`,
    "恢复 project ccbd managed config 失败",
    { method: "POST" }
  );
}

export async function releaseSlot(
  projectId: string,
  slotId: string,
  input: SlotReleaseInput
): Promise<SlotReleaseResponse> {
  return await requestJson<SlotReleaseResponse>(
    `/api/projects/${encodeURIComponent(projectId)}/slots/${encodeURIComponent(slotId)}/release`,
    "释放 Slot 失败",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(input)
    }
  );
}

export async function renewSlot(projectId: string, slotId: string): Promise<SlotReleaseResponse> {
  return await requestJson<SlotReleaseResponse>(
    `/api/projects/${encodeURIComponent(projectId)}/slots/${encodeURIComponent(slotId)}/renew`,
    "续期 Slot 失败",
    { method: "POST" }
  );
}

export async function archiveSlot(
  projectId: string,
  slotId: string,
  input: { confirm: boolean }
): Promise<SlotArchiveResponse> {
  return await requestJson<SlotArchiveResponse>(
    `/api/projects/${encodeURIComponent(projectId)}/slots/${encodeURIComponent(slotId)}/archive`,
    "归档 Slot 绑定 requirement 失败",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(input)
    }
  );
}

export async function cancelSlotCurrentJob(
  projectId: string,
  slotId: string,
  input: { confirm: boolean }
): Promise<SlotCancelCurrentJobResponse> {
  return await requestJson<SlotCancelCurrentJobResponse>(
    `/api/projects/${encodeURIComponent(projectId)}/slots/${encodeURIComponent(slotId)}/cancel-current-job`,
    "取消 Slot 当前 job 失败",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(input)
    }
  );
}

export async function startRequirementPlanningAnchor(
  projectId: string,
  requirementId: string
): Promise<AnchorStartResponse> {
  return await requestJson<AnchorStartResponse>(
    `/api/projects/${projectId}/requirements/${requirementId}/planning-anchor/start`,
    "启动 planning anchor 失败",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({})
    }
  );
}

export interface AnchorDispatchResponse {
  jobId: string;
  job_id?: string;
  traceRef?: string | null;
  anchorId: string;
  subjectId?: string;
  requirementId?: string;
  taskId?: string;
  queuedAt?: string;
  status: string;
}

export interface EventJournalEventView {
  eventId: string;
  eventType: string;
  subjectType: string;
  subjectId: string;
  payload: Record<string, unknown>;
  emittedAt: string;
}

export interface EventJournalListResponse {
  items: EventJournalEventView[];
  pageInfo: {
    limit: number;
    offset: number;
    count: number;
  };
}

export async function fetchEventJournalEvents(input: {
  subjectType?: "requirement" | "subtask";
  subjectId?: string;
  taskId?: string;
  limit?: number;
}): Promise<EventJournalListResponse> {
  const params = new URLSearchParams();
  if (input.subjectType) params.set("subject_type", input.subjectType);
  if (input.subjectId) params.set("subject_id", input.subjectId);
  if (input.taskId) params.set("task_id", input.taskId);
  if (input.limit) params.set("limit", String(input.limit));
  const query = params.toString();
  return await requestJson<EventJournalListResponse>(
    `/api/event-journal/events${query ? `?${query}` : ""}`,
    "加载事件日志失败"
  );
}

export async function dispatchRequirementAnchorCommand(
  projectId: string,
  requirementId: string,
  input: {
    command: string;
    payload: Record<string, unknown>;
  }
): Promise<AnchorDispatchResponse> {
  return await requestJson<AnchorDispatchResponse>(
    `/api/projects/${projectId}/requirements/${requirementId}/anchor-dispatch`,
    "发送 Requirement anchor 指令失败",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(input)
    }
  );
}

export async function dispatchTaskAnchorCommand(
  taskId: string,
  input: {
    command: string;
    payload: Record<string, unknown>;
  }
): Promise<AnchorDispatchResponse> {
  return await requestJson<AnchorDispatchResponse>(
    `/api/tasks/${taskId}/anchor-dispatch`,
    "发送子任务 Anchor 指令失败",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(input)
    }
  );
}

export async function fetchSubtaskBatchCandidates(
  projectId: string,
  requirementId: string
): Promise<SubtaskBatchCandidatesResponse> {
  return await requestJson<SubtaskBatchCandidatesResponse>(
    `/api/projects/${projectId}/requirements/${requirementId}/subtasks/batch-candidates`,
    "加载可批量派工子任务失败"
  );
}

export async function batchDispatchSubtasks(
  projectId: string,
  requirementId: string,
  input: {
    taskIds: string[];
    step: "execution";
  }
): Promise<SubtaskBatchDispatchResponse> {
  return await requestJson<SubtaskBatchDispatchResponse>(
    `/api/projects/${projectId}/requirements/${requirementId}/subtasks/batch-dispatch`,
    "批量派工子任务失败",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(input)
    }
  );
}

export async function updateTask(taskId: string, input: UpdateTaskInput): Promise<TaskView> {
  return await requestJson<TaskView>(`/api/tasks/${taskId}`, "更新任务失败", {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(input)
  });
}

export async function fetchRequirements(projectId: string): Promise<RequirementView[]> {
  const payload = await requestJson<ApiListResponse<RequirementView>>(
    `/api/projects/${projectId}/requirements`,
    "加载需求列表失败"
  );
  return payload.items;
}

export async function fetchSyncJobs(projectId: string): Promise<SyncJobView[]> {
  const payload = await requestJson<ApiListResponse<SyncJobView>>(
    `/api/projects/${projectId}/sync-jobs`,
    "加载运行记录失败"
  );
  return payload.items;
}

export async function fetchRequirementDetail(
  projectId: string,
  requirementId: string
): Promise<RequirementDetailView> {
  return await requestJson<RequirementDetailView>(
    `/api/projects/${projectId}/requirements/${requirementId}`,
    "加载需求详情失败"
  );
}

export async function reindexRequirement(
  projectId: string,
  requirementId: string
): Promise<RequirementReindexResponse> {
  return await requestJson<RequirementReindexResponse>(
    `/api/projects/${projectId}/requirements/${requirementId}/reindex`,
    "刷新需求投影失败",
    {
      method: "POST"
    }
  );
}

export async function patchRequirement(
  projectId: string,
  requirementId: string,
  input: RequirementEditInput
): Promise<RequirementView> {
  const body: Record<string, unknown> = {
    expectedMdHash: input.expectedMdHash
  };
  if (input.title !== undefined) body.title = input.title;
  if (input.description !== undefined) body.description = input.description;
  if (input.changeReason !== undefined) body.changeReason = input.changeReason;

  return await requestJson<RequirementView>(
    `/api/projects/${projectId}/requirements/${requirementId}`,
    "保存需求失败",
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    }
  );
}

export async function reanalyzeRequirement(
  projectId: string,
  requirementId: string
): Promise<RequirementReanalyzeStartResponse> {
  return await requestJson<RequirementReanalyzeStartResponse>(
    `/api/projects/${projectId}/requirements/${requirementId}/reanalyze`,
    "重新解析需求失败",
    {
      method: "POST"
    }
  );
}

export async function getReanalyzeJobStatus(
  projectId: string,
  requirementId: string,
  jobId: string
): Promise<RequirementReanalyzeJobStatus> {
  return await requestJson<RequirementReanalyzeJobStatus>(
    `/api/projects/${projectId}/requirements/${requirementId}/reanalyze-jobs/${jobId}`,
    "查询重新解析状态失败"
  );
}

export async function createRequirement(
  projectId: string,
  input: RequirementFormValue
): Promise<RequirementView> {
  return await requestJson<RequirementView>(`/api/projects/${projectId}/requirements`, "创建需求失败", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      title: input.title,
      description: input.description,
      outputMode: input.outputMode,
      splitMode: input.splitMode ?? "direct_pr",
      source_task_id: null,
      asset_tmp_uuid: input.assetTmpUuid,
      verbatim_source: optionalText(input.verbatimSource),
      claude_interpretation: optionalText(input.claudeInterpretation),
      ambiguities: optionalText(input.ambiguities),
      fidelity_diff: optionalText(input.fidelityDiff)
    })
  });
}

export interface RequirementAssetUploadResult {
  path: string;
  filename: string;
  mimeType: string;
  size: number;
}

export async function uploadRequirementAsset(
  projectId: string,
  assetOwner: string,
  file: File
): Promise<RequirementAssetUploadResult> {
  const form = new FormData();
  form.append("file", file, file.name || "image");
  return await requestJson<RequirementAssetUploadResult>(
    `/api/projects/${projectId}/requirements/${assetOwner}/assets`,
    "上传图片失败",
    {
      method: "POST",
      body: form
    }
  );
}

export async function createTaskWorkspace(taskId: string): Promise<TaskWorkspaceView> {
  return await requestJson<TaskWorkspaceView>(`/api/tasks/${taskId}/workspaces`, "创建任务工作空间失败", {
    method: "POST"
  });
}

export type DeriveFollowupType = "subtask" | "requirement";

export interface DeriveFollowupInput {
  type: DeriveFollowupType;
  title: string;
  description?: string;
}

export interface DeriveFollowupResponse {
  kind: "dispatch";
  dispatch: {
    jobId: string;
    job_id: string;
    anchorId: string | null;
    slotId: string | null;
    subjectId: string;
    requirementId: string;
    sourceTaskId: string;
    sourceTaskKey: string;
    followupType: DeriveFollowupType;
    command: string;
    status: string;
    queuedAt: string;
    dispatchPayload: Record<string, unknown>;
  };
}

export async function deriveFollowup(
  taskId: string,
  input: DeriveFollowupInput
): Promise<DeriveFollowupResponse> {
  return await requestJson<DeriveFollowupResponse>(
    `/api/tasks/${taskId}/derive`,
    "创建衍生 followup 失败",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: input.type,
        title: input.title.trim(),
        description: input.description ? optionalText(input.description) : undefined
      })
    }
  );
}

export async function cleanupTaskWorkspace(workspaceId: string): Promise<TaskWorkspaceView> {
  return await requestJson<TaskWorkspaceView>(`/api/task-workspaces/${workspaceId}`, "清理任务工作空间失败", {
    method: "DELETE"
  });
}

export async function createReviewIntent(
  taskId: string,
  input: CreateReviewIntentInput
): Promise<ReviewIntentView> {
  return await requestJson<ReviewIntentView>(`/api/tasks/${taskId}/review-intents`, "记录 review intent 失败", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(input)
  });
}

export async function cancelReviewIntent(intentId: string): Promise<ReviewIntentView> {
  return await requestJson<ReviewIntentView>(`/api/review-intents/${intentId}`, "取消 review intent 失败", {
    method: "DELETE"
  });
}

export async function fetchRequirementAggregation(requirementId: string): Promise<RequirementAggregationView> {
  return await requestJson<RequirementAggregationView>(`/api/requirements/${requirementId}/aggregation`, "加载需求聚合失败");
}

export async function cancelRequirement(requirementId: string): Promise<AnchorDispatchResponse> {
  return await requestJson<AnchorDispatchResponse>(`/api/requirements/${requirementId}/cancel`, "取消需求失败", { method: "POST" });
}

// ===== Sprint endpoints (Phase C) =====

export async function fetchSprints(projectId: string): Promise<SprintView[]> {
  const response = await requestJson<{ items: SprintView[] }>(`/api/projects/${projectId}/sprints`, "加载迭代列表失败");
  return response.items;
}

export async function fetchSprintDetail(sprintId: string): Promise<SprintDetailView> {
  return await requestJson<SprintDetailView>(`/api/sprints/${sprintId}`, "加载迭代详情失败");
}

export async function createSprint(projectId: string, input: CreateSprintInput): Promise<SprintView> {
  return await requestJson<SprintView>(`/api/projects/${projectId}/sprints`, "创建迭代失败", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });
}

export async function updateSprint(sprintId: string, input: Partial<SprintView>): Promise<SprintView> {
  return await requestJson<SprintView>(`/api/sprints/${sprintId}`, "更新迭代失败", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });
}

export async function addTaskToSprint(sprintId: string, taskId: string): Promise<void> {
  await requestJson(`/api/sprints/${sprintId}/tasks/${taskId}`, "任务加入迭代失败", { method: "POST" });
}

export async function removeTaskFromSprint(sprintId: string, taskId: string): Promise<void> {
  await requestJson(`/api/sprints/${sprintId}/tasks/${taskId}`, "任务移出迭代失败", { method: "DELETE" });
}

export async function fetchSprintBurndown(sprintId: string): Promise<BurndownView> {
  return await requestJson<BurndownView>(`/api/sprints/${sprintId}/burndown`, "加载燃尽数据失败");
}

export async function consumeReviewIntent(
  intentId: string,
  input: ConsumeReviewIntentInput
): Promise<ConsumeReviewIntentResponse> {
  return await requestJson<ConsumeReviewIntentResponse>(
    `/api/review-intents/${intentId}/consume`,
    "标记 review intent considered 失败",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(input)
    }
  );
}
