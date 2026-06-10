import type { AttentionItem } from "./console-api.js";
import { projectPath } from "./project-paths.js";

export function buildAttentionNavigatePath(item: AttentionItem, fallbackProjectId?: string | null): string {
  const projectId = item.projectId ?? fallbackProjectId ?? null;
  const scoped = (path: string) => (projectId ? projectPath(projectId, path) : path);
  if (item.cta.type === "task" && item.cta.taskId) {
    return scoped(`/tasks/${item.cta.taskId}`);
  }
  if (item.cta.type === "requirement" && item.cta.requirementId) {
    return scoped(`/requirements/${item.cta.requirementId}`);
  }
  if (item.taskId) {
    return scoped(`/tasks/${item.taskId}`);
  }
  if (item.requirementId) {
    return scoped(`/requirements/${item.requirementId}`);
  }
  return scoped("/overview");
}
