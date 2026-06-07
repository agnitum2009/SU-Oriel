import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";

import styles from "./TaskDetailPage.module.css";
import { ActiveNodePanel } from "../../components/task-detail-v2/ActiveNodePanel.js";
import { AdvancedDrawer } from "../../components/task-detail-v2/AdvancedDrawer.js";
import { AlertStrip } from "../../components/task-detail-v2/AlertStrip.js";
import { AnchorStartStrip } from "../../components/task-detail-v2/AnchorStartStrip.js";
import { CheckpointDrawer } from "../../components/task-detail-v2/CheckpointDrawer.js";
import { CheckpointsListDrawer } from "../../components/task-detail-v2/CheckpointsListDrawer.js";
import { ConsultationStream } from "../../components/task-detail-v2/ConsultationStream.js";
import { DecisionTimeline } from "../../components/task-detail-v2/DecisionTimeline.js";
import { DocumentPreviewDrawer } from "../../components/task-detail-v2/DocumentPreviewDrawer.js";
import { NodeActions } from "../../components/task-detail-v2/NodeActions.js";
import { NodeActivityFeed } from "../../components/task-detail-v2/NodeActivityFeed.js";
import { NodeStepper } from "../../components/task-detail-v2/NodeStepper.js";
import { PropertiesDrawer } from "../../components/task-detail-v2/PropertiesDrawer.js";
import { ReviewDrawer } from "../../components/task-detail-v2/ReviewDrawer.js";
import { StatusStrip } from "../../components/task-detail-v2/StatusStrip.js";
import { DerivedFollowupsCard } from "../../components/task-detail-v2/sidebar/DerivedFollowupsCard.js";
import { DocumentsCard } from "../../components/task-detail-v2/sidebar/DocumentsCard.js";
import { TaskSidebar } from "../../components/task-detail-v2/sidebar/TaskSidebar.js";
import type { NodeDetail, NodeId, NodeStatus } from "../../components/task-detail-v2/types.js";
import {
  cancelReviewIntent,
  createReviewIntent,
  dispatchTaskAnchorCommand,
  fetchEventJournalEvents
} from "../../lib/console-api.js";
import { isExecutableTask, isTaskArchived, NODE_BOARD_COLUMNS } from "../../lib/node-board-config.js";
import { useTaskNodeFlow } from "../../lib/use-task-node-flow.js";
import { useDetailStore } from "../../stores/detail-store.js";
import { useProjectStore } from "../../stores/project-store.js";
import { useUIStore } from "../../stores/ui-store.js";
import type { ReviewIntentView, TaskDetailView } from "../../types/task.js";

interface TaskDetailPageProps {
  task: TaskDetailView;
}

interface TaskDraft {
  priority: string;
  progress: number;
  blockedReason: string;
}

interface PendingTaskDispatch {
  jobId: string;
  command: string;
}

type DrawerKind = "properties" | "review" | "advanced" | "checkpoints-list" | null;

const NODE_IDS: NodeId[] = [
  "requirement_analysis",
  "technical_design",
  "task_breakdown",
  "dispatch",
  "implementation",
  "review",
  "archive"
];

const CONSULT_ELIGIBLE_NODES: NodeId[] = ["requirement_analysis", "technical_design", "task_breakdown"];

function isNodeId(value: string | null): value is NodeId {
  return NODE_IDS.includes(value as NodeId);
}

function nodeLabel(nodeId: NodeId): string {
  return NODE_BOARD_COLUMNS.find((column) => column.key === nodeId)?.label ?? nodeId;
}

function currentNodeId(task: TaskDetailView): NodeId {
  return isNodeId(task.currentNode) ? task.currentNode : "implementation";
}

function nodeStatus(nodeId: NodeId, current: NodeId, task: TaskDetailView): NodeStatus {
  if (nodeId === current) {
    if (current === "archive") return "archive";
    if (task.runtimeState === "blocked" || task.blockedReason?.trim()) return "blocked";
    if (task.runtimeState === "pending") return "pending";
    return "in_progress";
  }
  return NODE_IDS.indexOf(nodeId) < NODE_IDS.indexOf(current) ? "done" : "idle";
}

function serializeDraft(draft: TaskDraft): string {
  return JSON.stringify(draft);
}

export function TaskDetailPage({ task }: TaskDetailPageProps) {
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedProjectId = useProjectStore((state) => state.selectedProjectId);
  const savingTask = useProjectStore((state) => state.savingTask);
  const updateTask = useProjectStore((state) => state.updateTask);
  const loadProjectData = useProjectStore((state) => state.loadProjectData);
  const loadTaskDetail = useDetailStore((state) => state.loadTaskDetail);
  const addToast = useUIStore((state) => state.addToast);

  const [draft, setDraft] = useState<TaskDraft>(() => ({
    priority: task.priority,
    progress: task.progress,
    blockedReason: task.blockedReason ?? ""
  }));
  const [reviewComment, setReviewComment] = useState("");
  const [reviewBusy, setReviewBusy] = useState(false);
  const [drawer, setDrawer] = useState<DrawerKind>(null);
  const [openTransitionId, setOpenTransitionId] = useState<string | null>(null);
  const [previewDocId, setPreviewDocId] = useState<string | null>(null);
  const [dispatchingCommand, setDispatchingCommand] = useState<string | null>(null);
  const [pendingDispatches, setPendingDispatches] = useState<PendingTaskDispatch[]>([]);
  const lastSavedRef = useRef("");
  const pendingDispatchesRef = useRef<PendingTaskDispatch[]>([]);

  const current = currentNodeId(task);
  const selectedNodeId: NodeId = isNodeId(searchParams.get("node")) ? (searchParams.get("node") as NodeId) : current;
  const isExecutable = isExecutableTask(task);

  const nodes = useMemo(
    () => NODE_IDS.map((id) => ({ id, label: nodeLabel(id), status: nodeStatus(id, current, task) })),
    [current, task]
  );

  const selectedNode: NodeDetail = useMemo(
    () => ({
      id: selectedNodeId,
      label: nodeLabel(selectedNodeId),
      status: nodeStatus(selectedNodeId, current, task),
      substate: selectedNodeId === current ? task.nodeSubstate ?? undefined : undefined
    }),
    [current, selectedNodeId, task]
  );

  const isSelectedCurrent = selectedNodeId === current;
  const supportsConsult = CONSULT_ELIGIBLE_NODES.includes(selectedNodeId);

  const { data: nodeFlow, error: nodeFlowError } = useTaskNodeFlow(isSelectedCurrent ? task.id : null);
  const nodeFlowActions = nodeFlow?.applicableActions ?? [];
  const hasVisibleNodeActions = nodeFlowActions.some((action) => action.applicability === "user_actionable");
  const selectedNodeGuide = NODE_BOARD_COLUMNS.find((column) => column.key === selectedNodeId)?.guide ?? null;
  const selectedNodeCommand = selectedNodeGuide?.command?.replace(/^\/ccb:/, "") ?? null;

  useEffect(() => {
    pendingDispatchesRef.current = pendingDispatches;
  }, [pendingDispatches]);

  useEffect(() => {
    const next = { priority: task.priority, progress: task.progress, blockedReason: task.blockedReason ?? "" };
    setDraft(next);
    lastSavedRef.current = serializeDraft(next);
  }, [task]);

  const reconcilePendingDispatches = useCallback(async () => {
    const pending = pendingDispatchesRef.current;
    if (pending.length === 0) return;
    try {
      const result = await fetchEventJournalEvents({
        subjectType: "subtask",
        subjectId: task.id,
        limit: 20
      });
      const pendingByJobId = new Map(pending.map((item) => [item.jobId, item]));
      const resolved = [];
      for (const event of result.items) {
        if (event.eventType !== "anchor_dispatch_submitted" && event.eventType !== "anchor_dispatch_failed") {
          continue;
        }
        const jobId = typeof event.payload.jobId === "string" ? event.payload.jobId : null;
        if (!jobId || !pendingByJobId.has(jobId)) continue;
        resolved.push({ event, dispatch: pendingByJobId.get(jobId)! });
        pendingByJobId.delete(jobId);
      }
      if (resolved.length === 0) return;

      const resolvedJobIds = new Set(resolved.map((item) => item.dispatch.jobId));
      setPendingDispatches((items) => items.filter((item) => !resolvedJobIds.has(item.jobId)));
      setDispatchingCommand(null);
      for (const item of resolved) {
        if (item.event.eventType === "anchor_dispatch_submitted") {
          addToast("success", `已派出 /ccb:${item.dispatch.command}：${item.dispatch.jobId}`);
        } else {
          const message =
            typeof item.event.payload.errorMessage === "string"
              ? item.event.payload.errorMessage
              : "slot dispatch 失败";
          addToast("error", `派出失败：${message}。请到 Slots 页确认 slot 状态后手动重试`);
        }
      }
      await loadTaskDetail(task.id);
      if (selectedProjectId) {
        await loadProjectData(selectedProjectId);
      }
    } catch {
      // EventJournal 轮询失败不阻断任务详情页；下一轮轮询继续尝试。
    }
  }, [addToast, loadProjectData, loadTaskDetail, selectedProjectId, task.id]);

  useEffect(() => {
    const refetch = () => {
      void reconcilePendingDispatches();
    };
    const intervalId = window.setInterval(refetch, 30_000);
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        refetch();
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("focus", refetch);

    return () => {
      window.clearInterval(intervalId);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("focus", refetch);
    };
  }, [reconcilePendingDispatches]);

  useEffect(() => {
    if (draft.priority === task.priority) return undefined;
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          await updateTask(task.id, {
            priority: draft.priority
          });
          lastSavedRef.current = serializeDraft({
            priority: draft.priority,
            progress: task.progress,
            blockedReason: task.blockedReason ?? ""
          });
          await loadTaskDetail(task.id);
        } catch (error) {
          addToast("error", error instanceof Error ? error.message : "保存任务失败");
        }
      })();
    }, 500);
    return () => window.clearTimeout(timer);
  }, [addToast, draft.priority, loadTaskDetail, task, updateTask]);

  useEffect(() => {
    const tab = searchParams.get("tab");
    if (!tab) return;
    const next = new URLSearchParams(searchParams);
    next.delete("tab");
    if (!isNodeId(next.get("node"))) next.set("node", current);
    setSearchParams(next, { replace: true });
  }, [current, searchParams, setSearchParams]);

  const selectNode = (id: NodeId) => {
    const next = new URLSearchParams(searchParams);
    next.delete("tab");
    next.set("node", id);
    setSearchParams(next, { replace: false });
  };

  const handleCopyPath = (path: string) => {
    void navigator.clipboard?.writeText(path);
    addToast("success", "已复制路径");
  };

  const handleCreateReviewIntent = async (intentType: ReviewIntentView["intentType"]) => {
    setReviewBusy(true);
    try {
      await createReviewIntent(task.id, { intentType, payload: reviewComment.trim() || undefined });
      setReviewComment("");
      await loadTaskDetail(task.id);
      addToast("success", "评审意图已记录");
    } catch (error) {
      addToast("error", error instanceof Error ? error.message : "记录评审意图失败");
    } finally {
      setReviewBusy(false);
    }
  };

  const handleCancelReviewIntent = async (intentId: string) => {
    setReviewBusy(true);
    try {
      await cancelReviewIntent(intentId);
      await loadTaskDetail(task.id);
      addToast("success", "评审意图已取消");
    } catch (error) {
      addToast("error", error instanceof Error ? error.message : "取消评审意图失败");
    } finally {
      setReviewBusy(false);
    }
  };

  const handleStateDispatch = async (
    requestedAction:
      | { type: "set_status"; status: "reviewing"; blocked_reason: string }
      | { type: "set_status"; status: "done"; progress: 100 }
  ) => {
    if (dispatchingCommand) return;
    setDispatchingCommand("su-reconcile");
    try {
      const result = await dispatchTaskAnchorCommand(task.id, {
        command: "su-reconcile",
        payload: {
          mode: "detect",
          scope: "task",
          source: "task-detail",
          requested_action: requestedAction
        }
      });
      setPendingDispatches((items) => [...items, { jobId: result.jobId, command: "su-reconcile" }]);
      await loadTaskDetail(task.id);
      addToast("success", `已排队 /ccb:su-reconcile：${result.jobId}`);
    } catch (error) {
      addToast("error", error instanceof Error ? error.message : "发送 Reconcile 指令失败");
      setDispatchingCommand(null);
    }
  };

  const handleMarkBlocked = (reason: string) => {
    setDraft((state) => ({ ...state, blockedReason: reason }));
    void handleStateDispatch({ type: "set_status", status: "reviewing", blocked_reason: reason });
  };

  const handleMarkDone = () => {
    setDraft((state) => ({ ...state, blockedReason: "" }));
    void handleStateDispatch({ type: "set_status", status: "done", progress: 100 });
  };

  const handleDispatchTaskCommand = async (command: string) => {
    if (dispatchingCommand) return;
    setDispatchingCommand(command);
    try {
      const result = await dispatchTaskAnchorCommand(task.id, { command, payload: {} });
      setPendingDispatches((items) => [...items, { jobId: result.jobId, command }]);
      addToast("success", `已排队 /ccb:${command}：${result.jobId}`);
      await loadTaskDetail(task.id);
      if (selectedProjectId) {
        await loadProjectData(selectedProjectId);
      }
    } catch (error) {
      addToast("error", error instanceof Error ? error.message : "发送 Anchor 指令失败");
      setDispatchingCommand(null);
    }
  };

  const commandActionSlot = isSelectedCurrent && isExecutable && selectedNodeCommand ? (
    <div className={styles.commandAction}>
      <button
        className={styles.commandActionButton}
        disabled={Boolean(dispatchingCommand)}
        onClick={() => void handleDispatchTaskCommand(selectedNodeCommand)}
        type="button"
      >
        {dispatchingCommand === selectedNodeCommand ? "派出中..." : `发送 ${selectedNodeGuide?.command ?? selectedNodeCommand}`}
      </button>
      {selectedNodeGuide?.description ? <span className={styles.commandHint}>{selectedNodeGuide.description}</span> : null}
    </div>
  ) : null;

  return (
    <div className={styles.page} data-testid="task-detail-page">
      <AlertStrip
        onSelectNode={selectNode}
        task={task}
      />

      <NodeStepper
        currentNodeId={current}
        nodes={nodes}
        onSelect={selectNode}
        selectedNodeId={selectedNodeId}
      />

      <StatusStrip
        onOpenAdvanced={() => setDrawer("advanced")}
        onOpenCheckpoints={() => setDrawer("checkpoints-list")}
        onOpenProperties={() => setDrawer("properties")}
        onOpenReview={() => setDrawer("review")}
        task={task}
      />

      <AnchorStartStrip
        taskId={task.id}
        taskTitle={task.title}
        taskKind={task.kind}
        requirementId={task.requirementId ?? null}
        visible={task.kind === "subtask" && !isTaskArchived(task)}
      />

      <div className={styles.layout}>
        <div className={styles.mainColumn}>
          <ActiveNodePanel
            actionsSlot={
              isSelectedCurrent && isExecutable && (commandActionSlot || hasVisibleNodeActions) ? (
                <>
                  {commandActionSlot}
                  {hasVisibleNodeActions ? (
                    <NodeActions
                      actions={nodeFlowActions}
                      error={nodeFlowError}
                    />
                  ) : null}
                </>
              ) : isSelectedCurrent && !isExecutable ? (
                <p className={styles.epicNote}>该子任务当前不可执行派发 / 评审操作</p>
              ) : null
            }
            activitySlot={<NodeActivityFeed nodeId={selectedNodeId} taskId={task.id} />}
            consultationSlot={
              supportsConsult ? (
                <ConsultationStream nodeId={selectedNodeId} taskId={task.id} />
              ) : null
            }
            isCurrent={isSelectedCurrent}
            node={selectedNode}
          />
          <DecisionTimeline taskId={task.id} />
        </div>

        <TaskSidebar>
          <DocumentsCard documents={task.linkedDocuments} onOpenDocument={setPreviewDocId} />
          <DerivedFollowupsCard
            sourceRequirementId={task.requirementId ?? null}
            taskId={task.id}
          />
        </TaskSidebar>
      </div>

      <PropertiesDrawer
        blockedReason={draft.blockedReason}
        isOpen={drawer === "properties"}
        onBlockedReasonChange={(value) => setDraft((s) => ({ ...s, blockedReason: value }))}
        onClose={() => setDrawer(null)}
        onPriorityChange={(value) => setDraft((s) => ({ ...s, priority: value }))}
        onProgressChange={(value) => setDraft((s) => ({ ...s, progress: value }))}
        priority={draft.priority}
        progress={draft.progress}
        saving={savingTask}
      />

      <ReviewDrawer
        busy={reviewBusy}
        isExecutable={isExecutable}
        isOpen={drawer === "review"}
        onCancelIntent={handleCancelReviewIntent}
        onClose={() => setDrawer(null)}
        onCommentChange={setReviewComment}
        onCreateIntent={handleCreateReviewIntent}
        reviewComment={reviewComment}
        task={task}
      />

      <AdvancedDrawer
        blockedReason={draft.blockedReason}
        isExecutable={isExecutable}
        isOpen={drawer === "advanced"}
        onClose={() => setDrawer(null)}
        onCopyPath={handleCopyPath}
        onMarkBlocked={handleMarkBlocked}
        onMarkDone={handleMarkDone}
        task={task}
      />

      <CheckpointsListDrawer
        isOpen={drawer === "checkpoints-list"}
        onClose={() => setDrawer(null)}
        onSelect={(transitionId) => {
          setOpenTransitionId(transitionId);
        }}
        taskId={task.id}
      />

      <CheckpointDrawer
        isOpen={Boolean(openTransitionId)}
        onClose={() => setOpenTransitionId(null)}
        taskId={task.id}
        transitionId={openTransitionId ?? ""}
      />

      <DocumentPreviewDrawer
        documentId={previewDocId}
        onClose={() => setPreviewDocId(null)}
        onCopyPath={handleCopyPath}
      />
    </div>
  );
}
