import type { ProjectView } from "../types/project.js";

/**
 * 项目过滤纯函数：按项目名或本地路径做大小写不敏感匹配，keyword 前后空白忽略。
 * 顶部项目条「更多」弹层与侧栏项目下拉共用同一规则，避免两处实现漂移。
 */
export function filterProjects(projects: ProjectView[], keyword: string): ProjectView[] {
  const normalized = keyword.trim().toLowerCase();
  if (!normalized) {
    return projects;
  }
  return projects.filter(
    (project) =>
      project.name.toLowerCase().includes(normalized) || project.localPath.toLowerCase().includes(normalized)
  );
}

export interface VisibleProjectSplit {
  visible: ProjectView[];
  overflow: ProjectView[];
}

/**
 * 计算顶部项目条的可见集合：
 * - 项目数 <= maxVisible：全部可见，无溢出。
 * - 超出：取前 maxVisible 个；若当前项目落在溢出区，则把它 pin 到可见区末位
 *   （前 maxVisible-1 个 + 当前项目），其余进溢出。
 * 保证：可见区不重复、当前项目恒可见、溢出计数 = 项目总数 - maxVisible（pin 不会篡改计数）。
 */
export function computeVisibleProjects(
  projects: ProjectView[],
  selectedProjectId: string | null,
  maxVisible: number
): VisibleProjectSplit {
  if (maxVisible <= 0 || projects.length <= maxVisible) {
    return { visible: projects, overflow: [] };
  }

  const head = projects.slice(0, maxVisible);
  const currentInHead = selectedProjectId != null && head.some((project) => project.id === selectedProjectId);
  if (selectedProjectId == null || currentInHead) {
    return { visible: head, overflow: projects.slice(maxVisible) };
  }

  const current = projects.find((project) => project.id === selectedProjectId);
  if (!current) {
    return { visible: head, overflow: projects.slice(maxVisible) };
  }

  const visible = [...projects.slice(0, maxVisible - 1), current];
  const visibleIds = new Set(visible.map((project) => project.id));
  const overflow = projects.filter((project) => !visibleIds.has(project.id));
  return { visible, overflow };
}

export type ProjectStatusTone = "error" | "busy" | "idle";

/**
 * 项目状态点色调：仅在「有事」时返回（失败/进行中/未初始化），健康项目返回 null（不显点）。
 */
export function projectStatusTone(project: ProjectView): ProjectStatusTone | null {
  if (project.initStatus === "error" || project.syncStatus === "failed") {
    return "error";
  }
  if (project.syncStatus === "running" || project.syncStatus === "scanning") {
    return "busy";
  }
  if (project.initStatus === "not_initialized") {
    return "idle";
  }
  return null;
}
