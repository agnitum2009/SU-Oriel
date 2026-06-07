import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate, useParams } from "react-router";

import styles from "./RequirementDetailPage.module.css";
import { RequirementMarkdownEditor } from "../../components/requirements/RequirementMarkdownEditor.js";
import { MarkdownViewer } from "../../components/shared/MarkdownViewer.js";
import { SlotPanelActions, SlotTerminalPanel } from "../../components/slot-terminal/SlotTerminalPanel.js";
import { Badge } from "../../components/ui/Badge.js";
import { Button } from "../../components/ui/Button.js";
import { EmptyState } from "../../components/ui/EmptyState.js";
import { Input } from "../../components/ui/Input.js";
import { Modal } from "../../components/ui/Modal.js";
import { SkeletonCard } from "../../components/ui/Skeleton.js";
import {
  ConsoleApiError,
  batchDispatchSubtasks,
  bindSlot,
  dispatchRequirementAnchorCommand,
  fetchDocumentDetail,
  fetchEventJournalEvents,
  fetchRequirementDetail,
  fetchRequirementMarkdown,
  fetchSlots,
  fetchSubtaskBatchCandidates,
  fetchTaskMarkdown,
  fetchTasks,
  patchRequirement,
  reindexRequirement,
  releaseSlot,
  startRequirementPlanningAnchor,
  type SlotLaneView,
  uploadRequirementAsset
} from "../../lib/console-api.js";
import { stripFrontmatter } from "../../lib/markdown.js";
import { useProjectPathBuilder } from "../../lib/project-paths.js";
import { rewriteRequirementAssetUrls } from "../../lib/requirement-asset-url.js";
import { getRequirementStatusBadge } from "../../lib/ui-mapping.js";
import { useProjectStore } from "../../stores/project-store.js";
import { useUIStore } from "../../stores/ui-store.js";
import type { DocumentView } from "../../types/document.js";
import type { RequirementDetailView } from "../../types/requirement.js";
import { isRequirementEditable } from "../../types/requirement.js";
import type { SubtaskBatchCandidateView, TaskView } from "../../types/task.js";

const TERMINAL_STATUSES = new Set(["delivered", "cancelled"]);

type ArtifactModal = "ai" | "design" | null;
type DocumentModalMode = "read" | "edit" | null;
type MarkdownReaderStatus = "idle" | "loading" | "ready" | "empty" | "not-found" | "error";

interface MarkdownReaderState {
  status: MarkdownReaderStatus;
  content?: string;
  message?: string;
}
type DesignDocumentStatus = "idle" | "loading" | "ready" | "not-indexed" | "stale" | "not-found" | "error" | "empty";

interface DesignDocumentState {
  status: DesignDocumentStatus;
  path?: string;
  documentId?: string;
  content?: string;
  message?: string;
}

interface DesignDocumentRequest {
  requestId: number;
  path: string;
  documentId: string;
}

interface SlotReleaseDraft {
  slotId: string;
  state: string;
  reason: string;
  error: string | null;
}

interface PendingAnchorDispatch {
  jobId: string;
  command: string;
  step?: string;
  subjectType: "requirement" | "subtask";
  subjectId: string;
  title?: string;
}

// su-cancel 派出后的终态反馈跟踪：queued（已排队）→ executing（slot 已接管）→
// 投影 status=cancelled 收敛（清空）或 capability_outcome_rejected 转 failed。
interface CancelTrackingState {
  jobId: string;
  phase: "queued" | "executing" | "failed";
  message?: string;
  startedAt: string;
}

const ARTIFACT_TOTAL = 4;
const DEFERABLE_REQUIREMENT_STATUSES = new Set(["drafting", "planning", "delivering"]);
const REACTIVATABLE_REQUIREMENT_STATUSES = new Set(["cancelled", "deferred"]);
// Requirement detail intentionally treats unhealthy/recovering as normal unbinds;
// only busy forces release because that is the state known to interrupt active agent work.
const DETAIL_RELEASABLE_SLOT_STATES = new Set(["bound", "busy", "unhealthy", "recovering"]);
const LIFECYCLE_ACTIONS = [
  { command: "su-resume", label: "恢复运行时", icon: "▶️", dangerous: false },
  { command: "su-defer", label: "暂缓", icon: "⏸️", dangerous: false },
  { command: "su-reactivate", label: "复活", icon: "🔄", dangerous: false },
  { command: "su-archive", label: "归档", icon: "📦", dangerous: true },
  { command: "su-cancel", label: "取消", icon: "❌", dangerous: true }
] as const;

function specSectionOrder(specSectionId: string | null | undefined): number | null {
  const matched = specSectionId?.match(/^pr(\d+)-/);
  return matched ? Number.parseInt(matched[1], 10) : null;
}

function compareSubtasks(left: TaskView, right: TaskView): number {
  const leftOrder = left.step ?? specSectionOrder(left.specSectionId);
  const rightOrder = right.step ?? specSectionOrder(right.specSectionId);
  if (leftOrder !== null && rightOrder !== null && leftOrder !== rightOrder) return leftOrder - rightOrder;
  if (leftOrder !== null && rightOrder === null) return -1;
  if (leftOrder === null && rightOrder !== null) return 1;

  const sectionDelta = (left.specSectionId ?? "").localeCompare(right.specSectionId ?? "");
  if (sectionDelta !== 0) return sectionDelta;
  const titleDelta = left.title.localeCompare(right.title);
  return titleDelta === 0 ? left.id.localeCompare(right.id) : titleDelta;
}

type LifecycleAction = (typeof LIFECYCLE_ACTIONS)[number];
type LifecycleCommand = LifecycleAction["command"];

function terminalLabel(status: string): string {
  if (status === "delivered") return "已交付";
  if (status === "cancelled") return "已取消";
  if (status === "deferred") return "已暂缓";
  return status;
}

function hasAiAnalysis(requirement: RequirementDetailView): boolean {
  return Boolean(
    requirement.claudeInterpretation?.trim() ||
    requirement.ambiguities?.trim() ||
    requirement.fidelityDiff?.trim()
  );
}

function createExcerpt(markdown: string, maxLength = 220): string {
  const trimmed = markdown.trim();
  if (trimmed.length <= maxLength) return trimmed || "暂无描述。";
  return `${trimmed.slice(0, maxLength).trimEnd()}...`;
}

function normalizeDocumentPath(path: string): string {
  let normalized = path.trim().replace(/\\/g, "/");
  while (normalized.startsWith("./")) {
    normalized = normalized.slice(2);
  }
  return normalized;
}

function findDocumentByPath(documents: DocumentView[], path: string): DocumentView | null {
  const normalizedPath = normalizeDocumentPath(path);
  return documents.find((document) => normalizeDocumentPath(document.path) === normalizedPath) ?? null;
}

function DesignDocumentFallback(props: { title: string; description?: string }) {
  return (
    <div className={styles.drawerFallback} role="status">
      <p className={styles.drawerFallbackTitle}>{props.title}</p>
      {props.description ? <p className={styles.drawerFallbackText}>{props.description}</p> : null}
    </div>
  );
}

function renderDesignDocumentContent(state: DesignDocumentState): ReactNode {
  switch (state.status) {
    case "loading":
      return <DesignDocumentFallback title="正在加载技术设计正文..." description={state.path} />;
    case "ready":
      return (
        <div className={styles.markdownSurface}>
          <MarkdownViewer content={state.content ?? ""} />
        </div>
      );
    case "not-indexed":
      return (
        <DesignDocumentFallback
          title="技术设计文档尚未进入文档索引"
          description={state.path ? `路径：${state.path}` : undefined}
        />
      );
    case "stale":
      return (
        <DesignDocumentFallback
          title="文档索引已过期"
          description={state.path ? `请重新扫描项目文档后再阅读：${state.path}` : "请重新扫描项目文档后再阅读。"}
        />
      );
    case "not-found":
      return (
        <DesignDocumentFallback
          title="技术设计文档不存在或已被删除"
          description={state.path ? `路径：${state.path}` : undefined}
        />
      );
    case "error":
      return <DesignDocumentFallback title={state.message ?? "读取技术设计文档失败"} description={state.path} />;
    case "empty":
      return <DesignDocumentFallback title="技术设计文档正文为空" description={state.path} />;
    case "idle":
      return <DesignDocumentFallback title="技术设计尚未生成。" />;
  }
}

function renderRequirementMarkdownContent(state: MarkdownReaderState, projectId: string | null): ReactNode {
  switch (state.status) {
    case "loading":
      return <DesignDocumentFallback title="正在加载需求文档..." />;
    case "ready":
      return (
        <div className={styles.markdownSurface}>
          <MarkdownViewer content={rewriteRequirementAssetUrls(state.content ?? "", projectId ?? "")} />
        </div>
      );
    case "empty":
      return <DesignDocumentFallback title="需求文档正文为空" />;
    case "not-found":
      return <DesignDocumentFallback title="需求文档不存在或已被删除" />;
    case "error":
      return <DesignDocumentFallback title={state.message ?? "读取需求文档失败"} />;
    case "idle":
      return null;
  }
}

function renderTaskMarkdownContent(state: MarkdownReaderState): ReactNode {
  switch (state.status) {
    case "loading":
      return <DesignDocumentFallback title="正在加载任务文档..." />;
    case "ready":
      return (
        <div className={styles.markdownSurface}>
          <MarkdownViewer content={state.content ?? ""} />
        </div>
      );
    case "empty":
      return <DesignDocumentFallback title="任务文档正文为空" />;
    case "not-found":
      return <DesignDocumentFallback title="任务文档不存在或尚未进入索引" />;
    case "error":
      return <DesignDocumentFallback title={state.message ?? "读取任务文档失败"} />;
    case "idle":
      return null;
  }
}

function lifecycleDisabledReason(action: LifecycleAction, requirement: RequirementDetailView): string | null {
  switch (action.command) {
    case "su-archive":
      return requirement.status === "delivered" ? null : "仅 delivered 状态可归档";
    case "su-defer":
      return DEFERABLE_REQUIREMENT_STATUSES.has(requirement.status)
        ? null
        : "仅 drafting / planning / delivering 状态可暂缓";
    case "su-cancel":
      if (requirement.status === "cancelled") return "已取消需求不可再次取消";
      if (requirement.status === "delivered") return "已交付需求不可取消";
      return null;
    case "su-reactivate":
      return REACTIVATABLE_REQUIREMENT_STATUSES.has(requirement.status)
        ? null
        : "仅 cancelled / deferred 状态可复活";
    case "su-resume":
      return requirement.planningRuntimeState === "paused" ? null : "仅 planning runtime paused 时可恢复运行时";
  }
}

function confirmActionText(action: LifecycleAction): { title: string; button: string; verb: string } {
  if (action.command === "su-archive") {
    return { title: "确认归档需求", button: "确认归档", verb: "归档" };
  }
  return { title: "确认取消需求", button: "确认取消", verb: "取消" };
}

function subtaskDispatchBadge(task: TaskView, candidate: SubtaskBatchCandidateView | undefined, pending: boolean): {
  label: string;
  tone: "pending" | "running" | "terminal";
} {
  if (pending || candidate?.isPendingDispatch || candidate?.hasActiveAnchor) {
    return { label: "派工中", tone: "running" };
  }
  if (candidate?.eligible) {
    return { label: "待派工", tone: "pending" };
  }
  if (["done", "cancelled"].includes(task.status) || task.currentNode === "archive" || task.progress >= 100) {
    return { label: "已结束", tone: "terminal" };
  }
  return { label: task.currentNode ?? "未派工", tone: "terminal" };
}

function findRequirementSlot(slots: SlotLaneView[], requirementId: string): SlotLaneView | null {
  return slots.find((slot) => slot.requirement?.id === requirementId) ?? null;
}

function canUnbindRequirementSlot(slot: SlotLaneView): boolean {
  return DETAIL_RELEASABLE_SLOT_STATES.has(slot.state);
}

interface ArtifactCardProps {
  testId: string;
  icon: string;
  title: string;
  statusLabel: string;
  statusTone: "ready" | "pending" | "expired";
  description: string;
  action?: ReactNode;
  children?: ReactNode;
}

function ArtifactCard({ testId, icon, title, statusLabel, statusTone, description, action, children }: ArtifactCardProps) {
  return (
    <article className={styles.artifactCard} data-testid={testId}>
      <div className={styles.artifactTopline}>
        <span className={styles.artifactIcon} aria-hidden="true">{icon}</span>
        <div className={styles.artifactTitleBlock}>
          <h3 className={styles.artifactTitle}>{title}</h3>
          <p className={styles.artifactDescription}>{description}</p>
        </div>
        <span className={styles.artifactStatus} data-tone={statusTone}>{statusLabel}</span>
      </div>
      {action ? <div className={styles.artifactActions}>{action}</div> : null}
      {children}
    </article>
  );
}

export function RequirementDetailPage() {
  const { requirementId } = useParams<{ requirementId: string }>();
  const navigate = useNavigate();
  const toProjectPath = useProjectPathBuilder();
  const selectedProjectId = useProjectStore((state) => state.selectedProjectId);
  const documents = useProjectStore((state) => state.documents);
  const addToast = useUIStore((state) => state.addToast);
  const loadProjectData = useProjectStore((state) => state.loadProjectData);

  const [requirement, setRequirement] = useState<RequirementDetailView | null>(null);
  const [subtasks, setSubtasks] = useState<TaskView[]>([]);
  const [loading, setLoading] = useState(true);
  const [documentModal, setDocumentModal] = useState<DocumentModalMode>(null);
  const [artifactModal, setArtifactModal] = useState<ArtifactModal>(null);
  const [subtasksExpanded, setSubtasksExpanded] = useState(false);
  const [subtaskReader, setSubtaskReader] = useState<TaskView | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [editSubmitting, setEditSubmitting] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [planningSubmittingStep, setPlanningSubmittingStep] = useState<string | null>(null);
  const [pendingDispatches, setPendingDispatches] = useState<PendingAnchorDispatch[]>([]);
  const [subtaskBatchCandidates, setSubtaskBatchCandidates] = useState<SubtaskBatchCandidateView[]>([]);
  const [subtaskBatchModalOpen, setSubtaskBatchModalOpen] = useState(false);
  const [selectedBatchTaskIds, setSelectedBatchTaskIds] = useState<string[]>([]);
  const [subtaskBatchSubmitting, setSubtaskBatchSubmitting] = useState(false);
  const [lifecycleMenuOpen, setLifecycleMenuOpen] = useState(false);
  const [confirmLifecycleAction, setConfirmLifecycleAction] = useState<LifecycleAction | null>(null);
  const [cancelReason, setCancelReason] = useState("");
  const [cancelTracking, setCancelTracking] = useState<CancelTrackingState | null>(null);
  const [requirementSlot, setRequirementSlot] = useState<SlotLaneView | null>(null);
  const [slotReleaseDraft, setSlotReleaseDraft] = useState<SlotReleaseDraft | null>(null);
  const [designDocumentState, setDesignDocumentState] = useState<DesignDocumentState>({ status: "idle" });
  const [aiMarkdownState, setAiMarkdownState] = useState<MarkdownReaderState>({ status: "idle" });
  const [subtaskMarkdownState, setSubtaskMarkdownState] = useState<MarkdownReaderState>({ status: "idle" });
  const [slotLoading, setSlotLoading] = useState(false);
  const [slotAction, setSlotAction] = useState<"bind" | "release" | null>(null);
  const isFetchingRef = useRef(false);
  const reindexRefreshInFlightRef = useRef(false);
  const pendingDispatchesRef = useRef<PendingAnchorDispatch[]>([]);
  const cancelTrackingRef = useRef<CancelTrackingState | null>(null);
  const designDocumentRequestRef = useRef<DesignDocumentRequest | null>(null);
  const designDocumentRequestSeqRef = useRef(0);
  const aiMarkdownRequestSeqRef = useRef(0);
  const subtaskMarkdownRequestSeqRef = useRef(0);

  useEffect(() => {
    pendingDispatchesRef.current = pendingDispatches;
  }, [pendingDispatches]);

  useEffect(() => {
    cancelTrackingRef.current = cancelTracking;
  }, [cancelTracking]);

  const refreshRequirementSlot = useCallback(async () => {
    if (!requirementId || !selectedProjectId) return;
    setSlotLoading(true);
    try {
      const projection = await fetchSlots(selectedProjectId);
      setRequirementSlot(findRequirementSlot(projection.slots, requirementId));
    } catch (error) {
      addToast("error", error instanceof Error ? error.message : "加载 slot 绑定失败");
      setRequirementSlot(null);
    } finally {
      setSlotLoading(false);
    }
  }, [addToast, requirementId, selectedProjectId]);

  const loadDetail = useCallback(async () => {
    if (!requirementId || !selectedProjectId) return;
    if (isFetchingRef.current) return;
    isFetchingRef.current = true;
    setLoading(true);
    setSlotLoading(true);
    try {
      const [detail, children, batchCandidates, slotProjection] = await Promise.all([
        fetchRequirementDetail(selectedProjectId, requirementId),
        fetchTasks(selectedProjectId).catch(() => [] as TaskView[]),
        fetchSubtaskBatchCandidates(selectedProjectId, requirementId).catch(() => ({ candidates: [] })),
        fetchSlots(selectedProjectId).catch(() => null)
      ]);
      setRequirement(detail);
      setSubtasks(children.filter((task) => task.requirementId === requirementId).sort(compareSubtasks));
      setSubtaskBatchCandidates(batchCandidates.candidates);
      setRequirementSlot(slotProjection ? findRequirementSlot(slotProjection.slots, requirementId) : null);
    } catch (error) {
      addToast("error", error instanceof Error ? error.message : "加载需求详情失败");
      setRequirement(null);
      setRequirementSlot(null);
      setSubtaskBatchCandidates([]);
    } finally {
      isFetchingRef.current = false;
      setLoading(false);
      setSlotLoading(false);
    }
  }, [requirementId, selectedProjectId, addToast]);

  const reconcilePendingDispatches = useCallback(async () => {
    const pending = pendingDispatchesRef.current;
    if (!requirementId || pending.length === 0) return;
    try {
      const subjects = Array.from(
        new Map(pending.map((item) => [`${item.subjectType}:${item.subjectId}`, item] as const)).values()
      );
      const results = await Promise.all(
        subjects.map(async (subject) => ({
          subject,
          result: await fetchEventJournalEvents({
            subjectType: subject.subjectType,
            subjectId: subject.subjectId,
            limit: 20
          })
        }))
      );
      const pendingByJobId = new Map(pending.map((item) => [item.jobId, item]));
      const resolved = [];
      for (const { result } of results) {
        for (const event of result.items) {
          if (event.eventType !== "anchor_dispatch_submitted" && event.eventType !== "anchor_dispatch_failed") {
            continue;
          }
          const jobId = typeof event.payload.jobId === "string" ? event.payload.jobId : null;
          if (!jobId || !pendingByJobId.has(jobId)) continue;
          resolved.push({ event, dispatch: pendingByJobId.get(jobId)! });
          pendingByJobId.delete(jobId);
        }
      }
      if (resolved.length === 0) return;

      const resolvedJobIds = new Set(resolved.map((item) => item.dispatch.jobId));
      setPendingDispatches((items) => items.filter((item) => !resolvedJobIds.has(item.jobId)));
      if (resolved.some((item) => item.dispatch.subjectType === "requirement")) {
        setPlanningSubmittingStep(null);
      }
      for (const item of resolved) {
        if (item.event.eventType === "anchor_dispatch_submitted") {
          if (item.dispatch.subjectType === "subtask") {
            addToast("success", `已派出子任务：${item.dispatch.title ?? item.dispatch.jobId}`);
          } else {
            addToast("success", `已派出 /ccb:${item.dispatch.command}：${item.dispatch.jobId}`);
          }
          if (item.dispatch.command === "su-cancel") {
            setCancelTracking((current) =>
              current && current.jobId === item.dispatch.jobId && current.phase === "queued"
                ? { ...current, phase: "executing" }
                : current
            );
          }
        } else {
          const message =
            typeof item.event.payload.errorMessage === "string"
              ? item.event.payload.errorMessage
              : "Anchor dispatch 失败";
          addToast(
            "error",
            item.dispatch.subjectType === "subtask"
              ? `子任务派出失败：${message}。请到 Slots 页确认 slot 状态后手动重试`
              : `派出失败：${message}。请到 Slots 页确认 slot 状态后手动重试`
          );
          if (item.dispatch.command === "su-cancel") {
            setCancelTracking((current) =>
              current && current.jobId === item.dispatch.jobId ? { ...current, phase: "failed", message } : current
            );
          }
        }
      }
      if (selectedProjectId) {
        await loadProjectData(selectedProjectId);
      }
    } catch {
      // EventJournal 轮询失败不阻断详情刷新；下一轮轮询会继续尝试。
    }
  }, [addToast, loadProjectData, requirementId, selectedProjectId]);

  const reconcileCancelTracking = useCallback(async () => {
    const tracking = cancelTrackingRef.current;
    if (!requirementId || !tracking || tracking.phase === "failed") return;
    try {
      const result = await fetchEventJournalEvents({
        subjectType: "requirement",
        subjectId: requirementId,
        limit: 20
      });
      const rejected = result.items.find(
        (event) =>
          event.eventType === "capability_outcome_rejected" &&
          String(event.payload.capability_id ?? "") === "requirement.cancel" &&
          event.emittedAt >= tracking.startedAt
      );
      if (!rejected) return;
      const issues = Array.isArray(rejected.payload.issues)
        ? rejected.payload.issues.filter((issue): issue is string => typeof issue === "string")
        : [];
      const code = typeof rejected.payload.code === "string" ? rejected.payload.code : null;
      const message = issues[0] ?? code ?? "取消被拒绝";
      setCancelTracking((current) =>
        current && current.jobId === tracking.jobId ? { ...current, phase: "failed", message } : current
      );
      addToast("error", `取消未完成：${message}`);
    } catch {
      // EventJournal 轮询失败不阻断详情刷新；下一轮轮询会继续尝试。
    }
  }, [addToast, requirementId]);

  const reindexAndRefresh = useCallback(async () => {
    if (!requirementId || !selectedProjectId || document.visibilityState === "hidden") return;
    if (reindexRefreshInFlightRef.current) return;
    reindexRefreshInFlightRef.current = true;
    try {
      try {
        await reindexRequirement(selectedProjectId, requirementId);
      } catch {
        // 投影刷新失败不应让详情页进入硬错误；下一轮轮询会继续尝试。
      }
      await loadDetail();
      await reconcilePendingDispatches();
      await reconcileCancelTracking();
    } finally {
      reindexRefreshInFlightRef.current = false;
    }
  }, [loadDetail, reconcilePendingDispatches, reconcileCancelTracking, requirementId, selectedProjectId]);

  useEffect(() => {
    if (artifactModal !== "design") {
      designDocumentRequestRef.current = null;
      setDesignDocumentState({ status: "idle" });
      return undefined;
    }

    const planDocPath = requirement?.planDocPath;
    if (!planDocPath) {
      designDocumentRequestRef.current = null;
      setDesignDocumentState({ status: "not-indexed" });
      return undefined;
    }

    const normalizedPlanDocPath = normalizeDocumentPath(planDocPath);
    const indexedDocument = findDocumentByPath(documents, planDocPath);
    if (!indexedDocument) {
      designDocumentRequestRef.current = null;
      setDesignDocumentState({ status: "not-indexed", path: planDocPath });
      return undefined;
    }

    const request: DesignDocumentRequest = {
      requestId: designDocumentRequestSeqRef.current + 1,
      path: normalizedPlanDocPath,
      documentId: indexedDocument.id
    };
    designDocumentRequestSeqRef.current = request.requestId;
    designDocumentRequestRef.current = request;
    setDesignDocumentState({ status: "loading", path: planDocPath, documentId: indexedDocument.id });

    void fetchDocumentDetail(indexedDocument.id)
      .then((detail) => {
        const currentRequest = designDocumentRequestRef.current;
        if (
          !currentRequest ||
          currentRequest.requestId !== request.requestId ||
          currentRequest.path !== request.path ||
          currentRequest.documentId !== request.documentId
        ) {
          return;
        }

        if (normalizeDocumentPath(detail.path) !== request.path || detail.projectId !== selectedProjectId) {
          setDesignDocumentState({ status: "stale", path: planDocPath, documentId: indexedDocument.id });
          return;
        }

        const body = stripFrontmatter(detail.content);
        if (body.trim().length === 0) {
          setDesignDocumentState({ status: "empty", path: planDocPath, documentId: indexedDocument.id });
          return;
        }

        setDesignDocumentState({
          status: "ready",
          path: planDocPath,
          documentId: indexedDocument.id,
          content: body
        });
      })
      .catch((error) => {
        const currentRequest = designDocumentRequestRef.current;
        if (
          !currentRequest ||
          currentRequest.requestId !== request.requestId ||
          currentRequest.path !== request.path ||
          currentRequest.documentId !== request.documentId
        ) {
          return;
        }

        if (error instanceof ConsoleApiError && error.status === 404) {
          setDesignDocumentState({ status: "not-found", path: planDocPath, documentId: indexedDocument.id });
          return;
        }

        setDesignDocumentState({
          status: "error",
          path: planDocPath,
          documentId: indexedDocument.id,
          message: `读取技术设计文档失败：${error instanceof Error ? error.message : "未知错误"}`
        });
      });

    return () => {
      if (designDocumentRequestRef.current?.requestId === request.requestId) {
        designDocumentRequestRef.current = null;
      }
    };
  }, [documents, artifactModal, requirement?.planDocPath, selectedProjectId]);

  useEffect(() => {
    if (artifactModal !== "ai") {
      aiMarkdownRequestSeqRef.current += 1;
      setAiMarkdownState({ status: "idle" });
      return;
    }
    if (!selectedProjectId || !requirementId) {
      setAiMarkdownState({ status: "error", message: "请先选择项目" });
      return;
    }
    const requestId = aiMarkdownRequestSeqRef.current + 1;
    aiMarkdownRequestSeqRef.current = requestId;
    setAiMarkdownState({ status: "loading" });
    void fetchRequirementMarkdown(selectedProjectId, requirementId)
      .then((result) => {
        if (aiMarkdownRequestSeqRef.current !== requestId) return;
        const body = (result.content ?? "").trim();
        if (body.length === 0) {
          setAiMarkdownState({ status: "empty" });
          return;
        }
        setAiMarkdownState({ status: "ready", content: result.content });
      })
      .catch((error) => {
        if (aiMarkdownRequestSeqRef.current !== requestId) return;
        if (error instanceof ConsoleApiError && error.status === 404) {
          setAiMarkdownState({ status: "not-found" });
          return;
        }
        setAiMarkdownState({
          status: "error",
          message: `读取需求文档失败：${error instanceof Error ? error.message : "未知错误"}`
        });
      });
  }, [artifactModal, selectedProjectId, requirementId, requirement?.mdHash]);

  useEffect(() => {
    if (!subtaskReader) {
      subtaskMarkdownRequestSeqRef.current += 1;
      setSubtaskMarkdownState({ status: "idle" });
      return;
    }
    if (!selectedProjectId) {
      setSubtaskMarkdownState({ status: "error", message: "请先选择项目" });
      return;
    }

    const requestId = subtaskMarkdownRequestSeqRef.current + 1;
    subtaskMarkdownRequestSeqRef.current = requestId;
    setSubtaskMarkdownState({ status: "loading" });
    void fetchTaskMarkdown(selectedProjectId, subtaskReader.id)
      .then((result) => {
        if (subtaskMarkdownRequestSeqRef.current !== requestId) return;
        const body = (result.content ?? "").trim();
        if (body.length === 0) {
          setSubtaskMarkdownState({ status: "empty" });
          return;
        }
        setSubtaskMarkdownState({ status: "ready", content: result.content });
      })
      .catch((error) => {
        if (subtaskMarkdownRequestSeqRef.current !== requestId) return;
        if (error instanceof ConsoleApiError && error.status === 404) {
          setSubtaskMarkdownState({ status: "not-found" });
          return;
        }
        setSubtaskMarkdownState({
          status: "error",
          message: `读取任务文档失败：${error instanceof Error ? error.message : "未知错误"}`
        });
      });
  }, [selectedProjectId, subtaskReader]);

  // 取消成功收敛：10s reindex 轮询见投影 status=cancelled 时给出成功反馈并收起执行中 banner。
  useEffect(() => {
    if (!cancelTracking || cancelTracking.phase === "failed") return;
    if (requirement?.status === "cancelled") {
      addToast("success", "需求已取消，级联清理已落地");
      setCancelTracking(null);
    }
  }, [addToast, cancelTracking, requirement?.status]);

  useEffect(() => {
    void reindexAndRefresh();
    const intervalId = window.setInterval(() => {
      void reindexAndRefresh();
    }, 10_000);
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void reindexAndRefresh();
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("focus", reindexAndRefresh);

    return () => {
      window.clearInterval(intervalId);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("focus", reindexAndRefresh);
    };
  }, [reindexAndRefresh]);

  const handleOpenEdit = () => {
    if (!requirement) return;
    setEditDraft(requirement.description ?? "");
    setEditError(null);
    setDocumentModal("edit");
  };

  const handleSaveEdit = async () => {
    if (!selectedProjectId || !requirementId || !requirement?.mdHash || editSubmitting) return;
    setEditSubmitting(true);
    setEditError(null);
    try {
      await patchRequirement(selectedProjectId, requirementId, {
        description: editDraft,
        expectedMdHash: requirement.mdHash
      });
      addToast("success", "需求已更新");
      setDocumentModal(null);
      await loadDetail();
      await loadProjectData(selectedProjectId);
    } catch (error) {
      setEditError(error instanceof Error ? error.message : "保存失败");
    } finally {
      setEditSubmitting(false);
    }
  };

  const handleUploadImage = async (file: File): Promise<string> => {
    if (!selectedProjectId || !requirementId) {
      throw new Error("请先选择项目");
    }
    const uploaded = await uploadRequirementAsset(selectedProjectId, requirementId, file);
    return uploaded.path;
  };

  const handleDispatchPlanningCommand = async (input: { command: string; step?: string }) => {
    if (!selectedProjectId || !requirementId || planningSubmittingStep) return;
    const busyKey = input.step ?? input.command;
    setPlanningSubmittingStep(busyKey);
    try {
      await startRequirementPlanningAnchor(selectedProjectId, requirementId);
      const result = await dispatchRequirementAnchorCommand(selectedProjectId, requirementId, {
        command: input.command,
        payload: input.step ? { step: input.step } : {}
      });
      const stepLabel = input.step ? ` (${input.step})` : "";
      setPendingDispatches((items) => [
        ...items,
        {
          jobId: result.jobId,
          command: input.command,
          step: input.step,
          subjectType: "requirement",
          subjectId: requirementId
        }
      ]);
      addToast("success", `已排队 /ccb:${input.command}${stepLabel}：${result.jobId}`);
      await loadDetail();
      await loadProjectData(selectedProjectId);
    } catch (error) {
      addToast("error", error instanceof Error ? error.message : "发送 slot 指令失败");
      setPlanningSubmittingStep(null);
    }
  };

  const handleDispatchLifecycleCommand = async (command: LifecycleCommand) => {
    if (!selectedProjectId || !requirementId || planningSubmittingStep) return;
    setPlanningSubmittingStep(command);
    const trimmedCancelReason = command === "su-cancel" ? cancelReason.trim() : "";
    try {
      const result = await dispatchRequirementAnchorCommand(selectedProjectId, requirementId, {
        command,
        // su-cancel 携带取消原因（trim 后非空才带 key），写入 dispatch payload 与 EventJournal 审计。
        payload: command === "su-cancel" && trimmedCancelReason ? { reason: trimmedCancelReason } : {}
      });
      setPendingDispatches((items) => [
        ...items,
        {
          jobId: result.jobId,
          command,
          subjectType: "requirement",
          subjectId: requirementId
        }
      ]);
      if (command === "su-cancel") {
        setCancelTracking({ jobId: result.jobId, phase: "queued", startedAt: new Date().toISOString() });
      }
      addToast("success", `已排队 /ccb:${command}：${result.jobId}`);
      await loadDetail();
      await loadProjectData(selectedProjectId);
    } catch (error) {
      // 409 等 dispatch 失败：toast 透出 server message（ConsoleApiError 已携带），不进入取消跟踪。
      addToast("error", error instanceof Error ? error.message : "发送 slot 指令失败");
      setPlanningSubmittingStep(null);
    }
  };

  const handleLifecycleAction = (action: LifecycleAction) => {
    if (!requirement || planningSubmittingStep || lifecycleDisabledReason(action, requirement)) return;
    if (action.dangerous) {
      if (action.command === "su-cancel") setCancelReason("");
      setConfirmLifecycleAction(action);
      return;
    }
    void handleDispatchLifecycleCommand(action.command);
  };

  const handleBindSlot = async () => {
    if (!selectedProjectId || !requirementId || slotAction) return;
    setSlotAction("bind");
    try {
      const result = await bindSlot(selectedProjectId, requirementId);
      addToast("success", `已绑定 ${result.slot.slotId}`);
      await refreshRequirementSlot();
    } catch (error) {
      addToast("error", error instanceof Error ? error.message : "绑定 slot 失败");
    } finally {
      setSlotAction(null);
    }
  };

  const handleOpenReleaseSlot = () => {
    if (!requirementSlot || slotAction || !canUnbindRequirementSlot(requirementSlot)) return;
    setSlotReleaseDraft({
      slotId: requirementSlot.slotId,
      state: requirementSlot.state,
      reason: "",
      error: null
    });
  };

  const handleConfirmReleaseSlot = async () => {
    if (!selectedProjectId || !slotReleaseDraft || slotAction) return;
    const force = slotReleaseDraft.state === "busy";
    const reason = slotReleaseDraft.reason.trim();
    if (force && !reason) {
      setSlotReleaseDraft({ ...slotReleaseDraft, error: "请填写解绑原因" });
      return;
    }

    setSlotAction("release");
    try {
      await releaseSlot(
        selectedProjectId,
        slotReleaseDraft.slotId,
        force ? { confirm: true, force: true, reason } : { confirm: true }
      );
      addToast("success", force ? `已强制解绑 ${slotReleaseDraft.slotId}` : `已解绑 ${slotReleaseDraft.slotId}`);
      setSlotReleaseDraft(null);
      await refreshRequirementSlot();
    } catch (error) {
      const message = error instanceof Error ? error.message : force ? "强制解绑 slot 失败" : "解绑 slot 失败";
      setSlotReleaseDraft({ ...slotReleaseDraft, error: message });
      addToast("error", message);
    } finally {
      setSlotAction(null);
    }
  };

  const refreshSubtaskBatchCandidates = async (): Promise<SubtaskBatchCandidateView[]> => {
    if (!selectedProjectId || !requirementId) return [];
    const result = await fetchSubtaskBatchCandidates(selectedProjectId, requirementId);
    setSubtaskBatchCandidates(result.candidates);
    return result.candidates;
  };

  const handleOpenSubtaskBatchModal = async () => {
    if (!selectedProjectId || !requirementId) return;
    try {
      const candidates = await refreshSubtaskBatchCandidates();
      setSelectedBatchTaskIds(candidates.filter((candidate) => candidate.eligible).map((candidate) => candidate.taskId));
      setSubtaskBatchModalOpen(true);
    } catch (error) {
      addToast("error", error instanceof Error ? error.message : "加载可派工子任务失败");
    }
  };

  const handleToggleBatchTask = (taskId: string, checked: boolean) => {
    setSelectedBatchTaskIds((ids) => {
      if (checked) {
        return ids.includes(taskId) ? ids : [...ids, taskId];
      }
      return ids.filter((id) => id !== taskId);
    });
  };

  const handleConfirmSubtaskBatchDispatch = async () => {
    if (!selectedProjectId || !requirementId || selectedBatchTaskIds.length === 0 || subtaskBatchSubmitting) return;
    setSubtaskBatchSubmitting(true);
    try {
      const result = await batchDispatchSubtasks(selectedProjectId, requirementId, {
        taskIds: selectedBatchTaskIds,
        step: "execution"
      });
      if (result.totalFailed > 0) {
        addToast("info", `成功 ${result.totalQueued} / 失败 ${result.totalFailed}，查看下方任务卡详情`);
      } else {
        const coveredCount = result.taskIds?.length ?? selectedBatchTaskIds.length;
        addToast("success", `已派出 1 条 su-batch，覆盖 ${coveredCount} 个子任务`);
      }
      setSubtaskBatchModalOpen(false);
      await loadDetail();
      await loadProjectData(selectedProjectId);
    } catch (error) {
      addToast("error", error instanceof Error ? error.message : "批量派工子任务失败");
    } finally {
      setSubtaskBatchSubmitting(false);
    }
  };

  if (loading && !requirement) {
    return (
      <main className={styles.page}>
        <SkeletonCard />
      </main>
    );
  }

  if (!requirement) {
    return (
      <main className={styles.page}>
        <EmptyState description="该需求可能已被删除或不在当前项目内。" icon="📋" title="需求不存在" />
      </main>
    );
  }

  // ADR-0034: 需求大状态徽章以 canonical requirement.status 为准,不被派生聚合(子任务 rollup)盖过,
  // 否则 canonical=delivered 而聚合算出非交付态时,详情会与列表矛盾。聚合仅用于子任务级展示。
  const status = requirement.status;
  const statusBadge = getRequirementStatusBadge(status);
  const terminal = TERMINAL_STATUSES.has(requirement.status);
  const editable = isRequirementEditable(requirement.status);
  const aiHasAnalysis = hasAiAnalysis(requirement);
  const aiExpired = aiHasAnalysis && Boolean(requirement.analysisStaleAt);
  const aiReady = aiHasAnalysis && !aiExpired;
  const designReady = Boolean(requirement.planDocPath);
  const breakdownReady = Boolean(requirement.breakdownDraftPath);
  const subtasksReady = subtasks.length > 0;
  const candidateByTaskId = new Map(subtaskBatchCandidates.map((candidate) => [candidate.taskId, candidate]));
  const eligibleSubtaskBatchCount = subtaskBatchCandidates.filter((candidate) => candidate.eligible).length;
  const pendingSubtaskDispatchIds = new Set(
    pendingDispatches
      .filter((dispatch) => dispatch.subjectType === "subtask")
      .map((dispatch) => dispatch.subjectId)
  );
  const selectedBatchCount = selectedBatchTaskIds.length;
  const artifactCount = [aiReady, designReady, breakdownReady, subtasksReady].filter(Boolean).length;
  const descriptionMarkdown = requirement.description?.trim() || requirement.verbatimSource?.trim() || "暂无描述。";
  const summaryMarkdown = createExcerpt(descriptionMarkdown);
  const documentModalTitle = documentModal === "edit" ? "编辑需求文档" : "需求文档";
  const confirmLifecycleText = confirmLifecycleAction ? confirmActionText(confirmLifecycleAction) : null;
  const slotReleaseIsForce = slotReleaseDraft?.state === "busy";

  return (
    <main aria-label="需求详情" className={styles.page} data-testid="requirement-detail-page">
      <header className={styles.header}>
        <button aria-label="返回需求列表" className={styles.backButton} onClick={() => navigate(toProjectPath("/requirements"))} type="button">
          <span aria-hidden="true">←</span>
          <span>返回需求列表</span>
        </button>
        <div className={styles.titleRow}>
          <h1 className={styles.title}>{requirement.title}</h1>
          <Badge color={statusBadge.color} label={statusBadge.label} />
          <span className={styles.artifactCounter}>产物 {artifactCount}/{ARTIFACT_TOTAL}</span>
          <div className={styles.titleActions}>
            <div className={styles.lifecycleMenu}>
              <Button
                aria-expanded={lifecycleMenuOpen}
                aria-haspopup="menu"
                aria-label="更多操作"
                className={styles.lifecycleMenuTrigger}
                onClick={() => setLifecycleMenuOpen((open) => !open)}
                size="sm"
                variant="ghost"
              >
                ⋯
              </Button>
              {lifecycleMenuOpen ? (
                <div aria-label="需求生命周期操作" className={styles.lifecycleMenuPanel} role="menu">
                  {LIFECYCLE_ACTIONS.map((action) => {
                    const ruleDisabledReason = lifecycleDisabledReason(action, requirement);
                    const active = planningSubmittingStep === action.command;
                    const busy = Boolean(planningSubmittingStep) && !active;
                    const disabled = Boolean(ruleDisabledReason) || active || busy;
                    const title = active
                      ? "指令已排队，等待派出"
                      : ruleDisabledReason ?? (busy ? "已有指令派出中" : `触发 /ccb:${action.command}`);
                    return (
                      <Button
                        className={styles.lifecycleMenuItem}
                        disabled={disabled}
                        key={action.command}
                        onClick={() => handleLifecycleAction(action)}
                        role="menuitem"
                        size="sm"
                        title={title}
                        variant="ghost"
                      >
                        <span aria-hidden="true" className={styles.lifecycleMenuIcon}>{action.icon}</span>
                        {active ? "派出中..." : action.label}
                      </Button>
                    );
                  })}
                </div>
              ) : null}
            </div>
          </div>
        </div>
        {cancelTracking ? (
          <div
            className={`${styles.banner} ${cancelTracking.phase === "failed" ? styles.bannerError : styles.bannerInfo}`}
            data-testid="requirement-cancel-tracking-banner"
            role="status"
          >
            {cancelTracking.phase === "queued" ? (
              <>取消指令已排队（{cancelTracking.jobId}），等待 slot 接管…</>
            ) : cancelTracking.phase === "executing" ? (
              <>取消执行中（{cancelTracking.jobId}）——agent 正在写入 cancelled 并级联清理，投影确认后本提示自动收起。</>
            ) : (
              <span className={styles.bannerActionRow}>
                <span>取消未完成：{cancelTracking.message ?? "未知原因"}。可重试取消或查看事件日志。</span>
                <Button onClick={() => setCancelTracking(null)} size="sm" variant="ghost">
                  知道了
                </Button>
              </span>
            )}
          </div>
        ) : null}
        {terminal ? (
          <div className={`${styles.banner} ${styles.bannerWarning}`} role="status">
            该需求{terminalLabel(requirement.status)}，大状态恢复请使用独立指令。
          </div>
        ) : null}
      </header>

      <div className={styles.workspace} data-testid="requirement-detail-workspace">
        <aside className={styles.leftColumn} aria-label="需求产物">
          <section className={styles.section} aria-label="需求文档摘要">
            <div className={styles.sectionHeader}>
              <h2 className={styles.sectionTitle}>需求文档</h2>
              <div className={styles.sectionActions}>
                <Button onClick={() => setDocumentModal("read")} size="sm" variant="secondary">全屏阅读</Button>
                <Button
                  disabled={!editable || !requirement.mdHash}
                  onClick={handleOpenEdit}
                  size="sm"
                  variant="secondary"
                >
                  编辑需求文档
                </Button>
              </div>
            </div>
            <div className={styles.summaryMarkdown}>
              <MarkdownViewer content={summaryMarkdown} />
            </div>
          </section>

          <section className={styles.section} aria-label="产物索引">
            <h2 className={styles.sectionTitle}>产物索引</h2>
            <div className={styles.artifactList}>
              <ArtifactCard
                action={
                  <div className={styles.actionGroup}>
                    {aiHasAnalysis ? <Button onClick={() => setArtifactModal("ai")} size="sm" variant="secondary">📖 阅读解读</Button> : null}
                    <Button
                      disabled={terminal || Boolean(planningSubmittingStep)}
                      onClick={() => void handleDispatchPlanningCommand({ command: "su-flow", step: "analysis" })}
                      size="sm"
                      variant={aiHasAnalysis ? "ghost" : "secondary"}
                    >
                      {planningSubmittingStep === "analysis" ? "派出中..." : aiHasAnalysis ? "重新解析" : "生成 AI 解析"}
                    </Button>
                  </div>
                }
                description={aiExpired ? "解析结果可能已过期" : "需求理解、歧义和保真差异"}
                icon="🧠"
                statusLabel={aiExpired ? "已过期" : aiReady ? "已生成" : "未生成"}
                statusTone={aiExpired ? "expired" : aiReady ? "ready" : "pending"}
                testId="artifact-ai-analysis"
                title="AI 解析"
              />

              <ArtifactCard
                action={
                  <div className={styles.actionGroup}>
                    {designReady ? <Button onClick={() => setArtifactModal("design")} size="sm" variant="secondary">📖 阅读设计</Button> : null}
                    <Button
                      disabled={terminal || Boolean(planningSubmittingStep)}
                      onClick={() => void handleDispatchPlanningCommand({ command: "su-flow", step: "design" })}
                      size="sm"
                      variant={designReady ? "ghost" : "secondary"}
                    >
                      {planningSubmittingStep === "design" ? "派出中..." : designReady ? "重新生成" : "生成技术设计"}
                    </Button>
                  </div>
                }
                description={designReady ? requirement.planDocPath ?? "" : "由 slot 工作流生成技术设计文档"}
                icon="📐"
                statusLabel={designReady ? "已生成" : "未生成"}
                statusTone={designReady ? "ready" : "pending"}
                testId="artifact-design"
                title="技术设计"
              />

              <ArtifactCard
                action={
                  <div className={styles.actionGroup}>
                    {breakdownReady ? (
                      <Button onClick={() => navigate(toProjectPath(`/requirements/${requirement.id}/breakdown-review`))} size="sm" variant="secondary">
                        📂 打开审查页
                      </Button>
                    ) : null}
                    <Button
                      disabled={terminal || Boolean(planningSubmittingStep)}
                      onClick={() => void handleDispatchPlanningCommand({ command: "su-flow", step: "breakdown_draft" })}
                      size="sm"
                      variant={breakdownReady ? "ghost" : "secondary"}
                    >
                      {planningSubmittingStep === "breakdown_draft" ? "派出中..." : breakdownReady ? "重新生成" : "生成拆分草案"}
                    </Button>
                  </div>
                }
                description={breakdownReady ? requirement.breakdownDraftPath ?? "" : "生成后进入全屏审查页"}
                icon="📋"
                statusLabel={breakdownReady ? "已生成" : "未生成"}
                statusTone={breakdownReady ? "ready" : "pending"}
                testId="artifact-breakdown"
                title="拆分草案"
              />

              <ArtifactCard
                action={
                  subtasksReady ? (
                    <div className={styles.actionGroup}>
                      <Button
                        disabled={eligibleSubtaskBatchCount === 0}
                        onClick={() => void handleOpenSubtaskBatchModal()}
                        size="sm"
                        title={eligibleSubtaskBatchCount === 0 ? "暂无可派工子任务" : "批量启动子任务 execution"}
                        variant="primary"
                      >
                        批量推进 {eligibleSubtaskBatchCount} 个子任务
                      </Button>
                      <Button onClick={() => setSubtasksExpanded((value) => !value)} size="sm" variant="secondary">
                        {subtasksExpanded ? "收起子任务" : "展开子任务"}
                      </Button>
                    </div>
                  ) : null
                }
                description={subtasksReady ? `${subtasks.length} 个子任务，需求内默认串行` : "同意拆分后创建子任务"}
                icon="📦"
                statusLabel={subtasksReady ? `${subtasks.length} 个` : "未生成"}
                statusTone={subtasksReady ? "ready" : "pending"}
                testId="artifact-subtasks"
                title="子任务"
              >
                {subtasksExpanded ? (
                  <ol className={styles.subtaskList}>
                    {subtasks.map((task, index) => {
                      const badge = subtaskDispatchBadge(task, candidateByTaskId.get(task.id), pendingSubtaskDispatchIds.has(task.id));
                      return (
                        <li className={styles.subtaskItem} key={task.id}>
                          <button className={styles.subtaskButton} onClick={() => setSubtaskReader(task)} type="button">
                            <span className={styles.subtaskStep}>{index + 1}</span>
                            <span className={styles.subtaskTitle}>{task.title}</span>
                            <span className={styles.subtaskMeta}>{task.currentNode ?? "待派工"} · {task.progress}%</span>
                            <span className={styles.subtaskBadge} data-tone={badge.tone}>{badge.label}</span>
                          </button>
                        </li>
                      );
                    })}
                  </ol>
                ) : null}
              </ArtifactCard>
            </div>
          </section>
        </aside>

        <section aria-label="Slot 运行位置" className={styles.terminalColumn}>
          <div className={styles.terminalToolbar}>
            <div>
              <h2 className={styles.terminalTitle}>Slot 运行位置</h2>
              <p className={styles.terminalMeta}>
                slot：{requirementSlot?.slotId ?? "未绑定"} / state：{requirementSlot?.state ?? "idle"}
              </p>
            </div>
            <SlotPanelActions
              canReleaseSlot={requirementSlot ? canUnbindRequirementSlot(requirementSlot) : false}
              hasSlot={Boolean(requirementSlot)}
              onBindSlot={() => void handleBindSlot()}
              onReleaseSlot={handleOpenReleaseSlot}
              slotAction={slotAction}
              slotLoading={slotLoading}
            />
          </div>
          <SlotTerminalPanel
            projectId={selectedProjectId ?? ""}
            requirementId={requirementId ?? ""}
            requirementSlot={requirementSlot}
            slotAction={slotAction}
            slotLoading={slotLoading}
          />
        </section>
      </div>

      <Modal
        footer={
          documentModal === "edit" ? (
            <>
              <Button disabled={editSubmitting} onClick={() => setDocumentModal(null)} variant="secondary">
                取消
              </Button>
              <Button loading={editSubmitting} onClick={() => void handleSaveEdit()}>
                {editSubmitting ? "保存中..." : "保存内容"}
              </Button>
            </>
          ) : (
            <Button onClick={() => setDocumentModal(null)} variant="secondary">关闭</Button>
          )
        }
        onClose={() => {
          if (!editSubmitting) setDocumentModal(null);
        }}
        open={documentModal !== null}
        size="xl"
        title={documentModalTitle}
      >
        {documentModal === "edit" && editError ? <div className={styles.errorMessage}>{editError}</div> : null}
        {documentModal === "read" ? (
          <div className={styles.markdownSurface}>
            <MarkdownViewer content={rewriteRequirementAssetUrls(descriptionMarkdown, selectedProjectId ?? "")} />
          </div>
        ) : documentModal === "edit" ? (
          <RequirementMarkdownEditor
            onChange={(value) => setEditDraft(value)}
            onUploadImage={handleUploadImage}
            projectId={selectedProjectId ?? ""}
            value={editDraft}
          />
        ) : null}
      </Modal>

      <Modal
        footer={
          slotReleaseDraft ? (
            <>
              <Button disabled={slotAction === "release"} onClick={() => setSlotReleaseDraft(null)} variant="secondary">
                取消
              </Button>
              <Button
                loading={slotAction === "release"}
                onClick={() => void handleConfirmReleaseSlot()}
                variant="danger"
              >
                确认解绑
              </Button>
            </>
          ) : null
        }
        onClose={() => {
          if (slotAction !== "release") setSlotReleaseDraft(null);
        }}
        open={slotReleaseDraft !== null}
        size="md"
        title={slotReleaseDraft ? `确认解绑 ${slotReleaseDraft.slotId}` : "确认解绑 slot"}
      >
        {slotReleaseDraft ? (
          <div className={styles.slotReleaseDialog}>
            {slotReleaseIsForce ? (
              <p className={styles.slotReleaseWarning} role="alert">
                该 slot 有 agent 正在运行，解绑会中断其工作。
              </p>
            ) : null}
            <p className={styles.confirmText}>
              释放后该 slot 可能被队列中其它需求立即占用。确认解绑 {slotReleaseDraft.slotId} 吗？
            </p>
            {slotReleaseIsForce ? (
              <label className={styles.slotReleaseField} htmlFor="requirement-slot-release-reason">
                解绑原因
                <Input
                  aria-label="解绑原因"
                  id="requirement-slot-release-reason"
                  onChange={(event) => setSlotReleaseDraft({ ...slotReleaseDraft, reason: event.target.value, error: null })}
                  placeholder="说明为什么需要中断该 slot"
                  value={slotReleaseDraft.reason}
                />
              </label>
            ) : null}
            {slotReleaseDraft.error ? <p className={styles.slotReleaseError}>{slotReleaseDraft.error}</p> : null}
          </div>
        ) : null}
      </Modal>

      <Modal
        footer={
          <>
            <span className={styles.batchModalCount}>将派出 {selectedBatchCount} 个</span>
            <Button disabled={subtaskBatchSubmitting} onClick={() => setSubtaskBatchModalOpen(false)} variant="secondary">
              取消
            </Button>
            <Button
              disabled={selectedBatchCount === 0 || subtaskBatchSubmitting}
              loading={subtaskBatchSubmitting}
              onClick={() => void handleConfirmSubtaskBatchDispatch()}
            >
              {subtaskBatchSubmitting ? "派出中..." : "确认批量派出"}
            </Button>
          </>
        }
        onClose={() => {
          if (!subtaskBatchSubmitting) setSubtaskBatchModalOpen(false);
        }}
        open={subtaskBatchModalOpen}
        size="lg"
        title="批量推进子任务"
      >
        <div className={styles.batchModalBody}>
          <p className={styles.batchModalText}>以下子任务将交给同一个 slot 的 su-batch 自驱编排</p>
          <code className={styles.batchCommand}>{'/ccb:su-batch --payload {"scope":"subtasks","task_ids":[...]}'}</code>
          <div className={styles.batchCandidateList}>
            {subtaskBatchCandidates.map((candidate) => {
              const checked = selectedBatchTaskIds.includes(candidate.taskId);
              return (
                <label
                  className={styles.batchCandidateItem}
                  data-disabled={String(!candidate.eligible)}
                  key={candidate.taskId}
                >
                  <input
                    aria-label={candidate.title}
                    checked={checked}
                    disabled={!candidate.eligible || subtaskBatchSubmitting}
                    onChange={(event) => handleToggleBatchTask(candidate.taskId, event.currentTarget.checked)}
                    type="checkbox"
                  />
                  <span className={styles.batchCandidateMain}>
                    <span className={styles.batchCandidateTitle}>{candidate.title}</span>
                    <span className={styles.batchCandidateMeta}>{candidate.currentNode ?? "待派工"} · {candidate.status}</span>
                  </span>
                  <span className={styles.batchCandidateReason}>
                    {candidate.eligible ? "可派工" : candidate.ineligibleReason ?? "不可派工"}
                  </span>
                </label>
              );
            })}
            {subtaskBatchCandidates.length === 0 ? (
              <div className={styles.batchEmpty}>暂无子任务候选</div>
            ) : null}
          </div>
        </div>
      </Modal>

      <Modal
        footer={
          confirmLifecycleAction && confirmLifecycleText ? (
            <>
              <Button disabled={Boolean(planningSubmittingStep)} onClick={() => setConfirmLifecycleAction(null)} variant="secondary">
                取消
              </Button>
              <Button
                disabled={Boolean(planningSubmittingStep)}
                onClick={() => {
                  const action = confirmLifecycleAction;
                  setConfirmLifecycleAction(null);
                  void handleDispatchLifecycleCommand(action.command);
                }}
                variant={confirmLifecycleAction.command === "su-cancel" ? "primary" : "danger"}
              >
                {confirmLifecycleText.button}
              </Button>
            </>
          ) : null
        }
        onClose={() => {
          if (!planningSubmittingStep) setConfirmLifecycleAction(null);
        }}
        open={Boolean(confirmLifecycleAction)}
        size="md"
        title={confirmLifecycleText?.title ?? "确认操作"}
      >
        {confirmLifecycleAction && confirmLifecycleText ? (
          confirmLifecycleAction.command === "su-cancel" ? (
            <div className={styles.cancelConfirmBody}>
              <p className={styles.confirmText}>
                你将取消需求「{requirement.title}」。指令经 slot dispatch 派发到 Claude，落地后将级联执行：
              </p>
              <ul className={styles.cancelImpactList}>
                <li>需求状态置为 cancelled（可经「复活」恢复状态，不恢复代码）</li>
                <li>所有非终态子任务级联取消</li>
                <li>删除拆分草案（breakdown draft）</li>
                <li>不可逆舍弃需求 worktree，未合并代码将丢失</li>
                <li>释放绑定 slot 并清理在途派工</li>
              </ul>
              {requirementSlot?.state === "busy" ? (
                <p className={styles.cancelBusyHint} role="alert">
                  当前绑定 slot 正忙：取消不抢占，将排队在当前任务之后生效。如需立即中断，请到 Slots 页执行
                  cancel-current-job。
                </p>
              ) : null}
              <label className={styles.slotReleaseField} htmlFor="requirement-cancel-reason">
                取消原因
                <Input
                  aria-label="取消原因"
                  id="requirement-cancel-reason"
                  onChange={(event) => setCancelReason(event.target.value)}
                  placeholder="建议填写，允许为空；将写入取消审计"
                  value={cancelReason}
                />
              </label>
            </div>
          ) : (
            <p className={styles.confirmText}>
              你将{confirmLifecycleText.verb}需求「{requirement.title}」，此动作通过 slot dispatch 派发到 Claude，是否继续？
            </p>
          )
        ) : null}
      </Modal>

      <Modal
        onClose={() => setSubtaskReader(null)}
        open={subtaskReader !== null}
        size="reader"
        title={subtaskReader ? `任务文档 · ${subtaskReader.title}` : "任务文档"}
      >
        {renderTaskMarkdownContent(subtaskMarkdownState)}
      </Modal>

      <Modal
        onClose={() => setArtifactModal(null)}
        open={artifactModal === "ai"}
        size="reader"
        title="AI 解析 · 需求文档"
      >
        {renderRequirementMarkdownContent(aiMarkdownState, selectedProjectId)}
      </Modal>

      <Modal
        onClose={() => setArtifactModal(null)}
        open={artifactModal === "design"}
        size="reader"
        title="技术设计"
      >
        {renderDesignDocumentContent(designDocumentState)}
      </Modal>
    </main>
  );
}
