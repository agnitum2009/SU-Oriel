import type { TaskView } from "../types/task.js";

export const PHASE_COLUMNS = [
  { key: "dispatch", label: "待派工", aliases: ["ready", "planning", "requirement"] },
  { key: "implementation", label: "执行中", aliases: ["implementing"] },
  { key: "review", label: "待评审", aliases: ["reviewing"] },
  { key: "archive", label: "已完成", aliases: ["done", "archived"] }
] as const;

export const BADGE_MAP = {
  dev_task: { label: "Dev Task", color: "blue" },
  requirement: { label: "需求", color: "orange" },
  technical_design: { label: "技术设计", color: "blue" },
  architecture: { label: "架构", color: "purple" },
  adr: { label: "ADR", color: "red" },
  module_spec: { label: "模块规格", color: "green" },
  lessons: { label: "经验", color: "yellow" },
  doc_map: { label: "文档地图", color: "gray" },
  project_overview: { label: "项目总览", color: "gray" },
  archive_index: { label: "归档索引", color: "gray" },
  index: { label: "索引", color: "gray" },
  other: { label: "Other", color: "gray" },
  urgent: { label: "紧急", color: "red" },
  high: { label: "高", color: "orange" },
  medium: { label: "中", color: "yellow" },
  low: { label: "低", color: "green" },
  draft: { label: "草稿", color: "gray" },
  reviewing: { label: "处理中", color: "blue" },
  done: { label: "完成", color: "green" },
  cancelled: { label: "已取消", color: "red" },
  "req-draft": { label: "草稿", color: "gray" },
  "req-planning": { label: "规划中", color: "blue" },
  "req-delivering": { label: "推进中", color: "orange" },
  "req-delivered": { label: "已交付", color: "green" },
  "req-deferred": { label: "已暂缓", color: "gray" },
  "req-cancelled": { label: "已取消", color: "red" }
} as const;

export const JOB_TYPE_LABEL: Record<string, string> = {
  scan: "扫描",
  parse: "解析",
  reconcile: "归并",
  generate: "生成"
};

export const JOB_STATUS_BADGE: Record<string, { label: string; color: BadgeColor }> = {
  pending: { label: "等待中", color: "gray" },
  running: { label: "运行中", color: "blue" },
  success: { label: "成功", color: "green" },
  failed: { label: "失败", color: "red" },
  partial: { label: "部分成功", color: "yellow" }
};

export const OUTPUT_MODE_LABEL = {
  requirement_only: "仅登记"
} as const;

export type BadgeColor = "gray" | "green" | "blue" | "red" | "yellow" | "orange" | "purple";

const NODE_LABEL_MAP: Record<string, string> = {
  requirement_analysis: "需求分析",
  technical_design: "技术设计",
  task_breakdown: "任务拆分",
  dispatch: "待派工",
  implementation: "执行实现",
  review: "评审验收",
  archive: "归档收尾"
};

const NODE_BOARD_LANE_MAP: Record<string, PhaseColumnKey> = {
  requirement_analysis: "dispatch",
  technical_design: "dispatch",
  task_breakdown: "dispatch",
  dispatch: "dispatch",
  implementation: "implementation",
  review: "review",
  archive: "archive"
};

export type PhaseColumnKey = (typeof PHASE_COLUMNS)[number]["key"];

export type TaskBoardItem = TaskView & {
  boardLane: PhaseColumnKey;
};

export interface TaskBoardProjection {
  totalTaskCount: number;
  visibleTaskCount: number;
  activeTaskCount: number;
  archivedCount: number;
  hiddenArchivedCount: number;
  visibleTasks: TaskBoardItem[];
  columns: Array<(typeof PHASE_COLUMNS)[number] & { tasks: TaskBoardItem[] }>;
  phaseSummary: Array<(typeof PHASE_COLUMNS)[number] & { count: number }>;
}

export function getJobTypeLabel(jobType: string): string {
  return JOB_TYPE_LABEL[jobType] ?? jobType;
}

export function getJobStatusBadge(status: string): { label: string; color: BadgeColor } {
  return JOB_STATUS_BADGE[status] ?? { label: status, color: "gray" };
}

export function getPhaseLabel(phase: string): string {
  return PHASE_COLUMNS.find((item) => item.key === phase || (item.aliases as readonly string[]).includes(phase))?.label ?? phase;
}

export function deriveTaskBoardLane(
  task: Pick<TaskView, "phase" | "status" | "currentNode" | "runtimeState">
): PhaseColumnKey {
  const status = task.status?.trim().toLowerCase();
  const currentNode = task.currentNode?.trim().toLowerCase();
  const runtimeState = task.runtimeState?.trim().toLowerCase();

  if (status === "done" || status === "cancelled" || status === "archived" || currentNode === "archive") {
    return "archive";
  }

  if (runtimeState === "blocked") {
    return "implementation";
  }

  // board lane 是 Console 投影桶，优先遵循 kernel 节点；phase 仅用于旧数据兼容。
  if (currentNode && NODE_BOARD_LANE_MAP[currentNode]) {
    return NODE_BOARD_LANE_MAP[currentNode];
  }

  if (status === "done" || status === "completed" || status === "complete" || runtimeState === "completed") {
    return "archive";
  }

  const phase = task.phase?.trim().toLowerCase();
  const matchedColumn = PHASE_COLUMNS.find(
    (item) => item.key === phase || (item.aliases as readonly string[]).includes(phase ?? "")
  );
  return matchedColumn?.key ?? "dispatch";
}

export function isTaskArchived(task: Pick<TaskView, "status" | "currentNode">): boolean {
  const status = task.status?.trim().toLowerCase();
  return status === "done" || status === "cancelled" || status === "archived" || task.currentNode === "archive";
}

export function isEpicContainerTask(task: Pick<TaskView, "semanticKind">): boolean {
  void task;
  return false;
}

export function isExecutableTask(task: Pick<TaskView, "semanticKind" | "status" | "currentNode">): boolean {
  return !isEpicContainerTask(task) && !isTaskArchived(task);
}

export function createTaskBoardProjection(
  tasks: TaskView[],
  options: { includeArchived?: boolean } = {}
): TaskBoardProjection {
  const includeArchived = Boolean(options.includeArchived);
  const allTasks = tasks
    .map((task) => ({
      ...task,
      boardLane: deriveTaskBoardLane(task)
    }))
    .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());
  const visibleTasks = includeArchived ? allTasks : allTasks.filter((task) => !isTaskArchived(task));
  const archivedCount = allTasks.filter((task) => isTaskArchived(task)).length;
  const columns = PHASE_COLUMNS.map((column) => ({
    ...column,
    tasks: visibleTasks.filter((task) => task.boardLane === column.key)
  }));

  return {
    totalTaskCount: allTasks.length,
    visibleTaskCount: visibleTasks.length,
    activeTaskCount: visibleTasks.filter((task) => task.boardLane === "implementation").length,
    archivedCount,
    hiddenArchivedCount: includeArchived ? 0 : archivedCount,
    visibleTasks,
    columns,
    phaseSummary: columns.map((column) => ({
      ...column,
      count: column.tasks.length
    }))
  };
}

export function getNodeBadge(
  currentNode: string | null | undefined,
  nodeSubstate: string | null | undefined
): { label: string; color: BadgeColor } | null {
  if (!currentNode) {
    return null;
  }

  const nodeLabel = NODE_LABEL_MAP[currentNode] ?? currentNode;
  const trimmedSubstate = nodeSubstate?.trim();

  // v0.3.2 只读展示节点投影；真实流转仍以 kernel manifest 为准。
  return {
    label: trimmedSubstate ? `${nodeLabel} · ${trimmedSubstate}` : nodeLabel,
    color: "blue"
  };
}

export function getDocumentKindBadge(kind: string): { label: string; color: BadgeColor } {
  if (
    kind === "dev_task" ||
    kind === "requirement" ||
    kind === "technical_design" ||
    kind === "architecture" ||
    kind === "adr" ||
    kind === "module_spec" ||
    kind === "lessons" ||
    kind === "doc_map" ||
    kind === "project_overview" ||
    kind === "archive_index" ||
    kind === "index"
  ) {
    return BADGE_MAP[kind];
  }

  return BADGE_MAP.other;
}

export function getPriorityBadge(priority: string): { label: string; color: BadgeColor } {
  if (priority === "urgent" || priority === "high" || priority === "medium" || priority === "low") {
    return BADGE_MAP[priority];
  }

  return { label: priority, color: "gray" };
}

export function getTaskStatusBadge(status: string): { label: string; color: BadgeColor } {
  if (status === "reviewing" || status === "done" || status === "cancelled") {
    return BADGE_MAP[status];
  }

  return { label: status, color: "gray" };
}

export function getRequirementStatusBadge(status: string): { label: string; color: BadgeColor } {
  switch (status) {
    case "drafting":
    case "draft":
      return BADGE_MAP["req-draft"];
    case "planning":
      return BADGE_MAP["req-planning"];
    case "delivering":
      return BADGE_MAP["req-delivering"];
    case "delivered":
      return BADGE_MAP["req-delivered"];
    case "deferred":
      return BADGE_MAP["req-deferred"];
    case "cancelled":
      return BADGE_MAP["req-cancelled"];
    default:
      if (typeof console !== "undefined" && typeof console.warn === "function") {
        console.warn(`未知需求状态: ${status}`);
      }
      return { label: status, color: "gray" };
  }
}

export type RequirementTabKey = "pending" | "planning" | "delivering" | "delivered" | "archived";

export const REQUIREMENT_TAB_LABELS: Record<RequirementTabKey, string> = {
  pending: "待处理",
  planning: "规划中",
  delivering: "推进中",
  delivered: "已交付",
  archived: "已搁置"
};

/**
 * 把需求 status 归类到列表页 5 个生命周期 tab。
 *
 * planning / delivering 各自独立成桶（看板列对应 5 列）；
 * 未知 status 兜底到 archived，避免数据从 UI 消失。
 */
export function classifyRequirementTab(status: string): RequirementTabKey {
  switch (status) {
    case "drafting":
      return "pending";
    case "planning":
      return "planning";
    case "delivering":
      return "delivering";
    case "delivered":
      return "delivered";
    case "deferred":
    case "cancelled":
      return "archived";
    default:
      return "archived";
  }
}

/**
 * 需求是否处于「活跃」生命周期（待处理 / 规划中 / 推进中）。
 *
 * 首页「活跃需求」聚合口径的单一真相源：delivered / archived 不算活跃。
 * 抽成谓词，避免调用方内联枚举 tab 时漏掉 planning（规划中需求被静默漏算）。
 */
export function isActiveRequirementTab(tab: RequirementTabKey): boolean {
  return tab === "pending" || tab === "planning" || tab === "delivering";
}

export interface RequirementAction {
  kind: "open-detail" | "open-breakdown" | "archived";
  label: string;
  disabled?: boolean;
}

/**
 * 计算需求行的主 action 按钮态。
 *
 * 主判定走 status；generatedTaskId 仅作未知 status 的 legacy 兜底（旧数据可能没走过 hierarchy 模型）。
 */
export function getRequirementAction(status: string, generatedTaskId: string | null): RequirementAction {
  void generatedTaskId;
  if (status === "drafting") {
    return { kind: "open-detail", label: "开始分析" };
  }
  if (status === "planning") {
    return { kind: "open-detail", label: "继续设计" };
  }
  if (status === "delivering") {
    return { kind: "open-detail", label: "查看子任务" };
  }
  if (status === "delivered") {
    return { kind: "open-detail", label: "查看详情" };
  }
  if (status === "deferred" || status === "cancelled") {
    return { kind: "archived", label: "已搁置", disabled: true };
  }
  return { kind: "open-detail", label: "查看详情" };
}

export function createRequirementPreviewItems(_mode: "requirement_only"): string[] {
  return ["1 条需求记录"];
}
