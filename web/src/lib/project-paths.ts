import { createContext, useContext } from "react";

import { useProjectStore } from "../stores/project-store.js";
import type { ProjectView } from "../types/project.js";

export type ProjectScopeValue = {
  projectId: string;
  project: ProjectView;
};

export const ProjectScopeContext = createContext<ProjectScopeValue | null>(null);

export function useProjectScope(): ProjectScopeValue {
  const value = useContext(ProjectScopeContext);
  if (!value) {
    throw new Error("useProjectScope must be used under ProjectScopeProvider");
  }
  return value;
}

export function useOptionalProjectScope(): ProjectScopeValue | null {
  return useContext(ProjectScopeContext);
}

export function useProjectPathBuilder(): (path: string) => string {
  const scope = useOptionalProjectScope();
  const selectedProjectId = useProjectStore((state) => state.selectedProjectId);
  const projectId = scope?.projectId ?? selectedProjectId;
  return (path: string) => (projectId ? projectPath(projectId, path) : path);
}

export function projectPath(projectId: string, path = "/overview"): string {
  const normalized = normalizeProjectRelativePath(path);
  return `/projects/${encodeURIComponent(projectId)}${normalized}`;
}

export function projectOverviewPath(projectId: string): string {
  return projectPath(projectId, "/overview");
}

export function projectRequirementsPath(projectId: string): string {
  return projectPath(projectId, "/requirements");
}

export function projectRequirementPath(projectId: string, requirementId: string): string {
  return projectPath(projectId, `/requirements/${encodeURIComponent(requirementId)}`);
}

export function projectRequirementBreakdownReviewPath(projectId: string, requirementId: string): string {
  return projectPath(projectId, `/requirements/${encodeURIComponent(requirementId)}/breakdown-review`);
}

export function projectTasksPath(projectId: string): string {
  return projectPath(projectId, "/tasks");
}

export function projectTaskPath(projectId: string, taskId: string): string {
  return projectPath(projectId, `/tasks/${encodeURIComponent(taskId)}`);
}

export function projectDocumentsPath(projectId: string): string {
  return projectPath(projectId, "/documents");
}

export function projectDocumentPath(projectId: string, documentId: string): string {
  return projectPath(projectId, `/documents/${encodeURIComponent(documentId)}`);
}

export function projectSlotsPath(projectId: string): string {
  return projectPath(projectId, "/anchors");
}

export function normalizeProjectRelativePath(path: string): string {
  const [pathnameAndSearch, hash = ""] = path.split("#", 2);
  const [pathname = "", search = ""] = pathnameAndSearch.split("?", 2);
  const cleanPath = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return `${cleanPath}${search ? `?${search}` : ""}${hash ? `#${hash}` : ""}`;
}

export function stripProjectPathPrefix(pathname: string): string {
  const match = matchProjectPath(pathname);
  return match?.relativePath ?? pathname;
}

export function matchProjectPath(pathname: string): { projectId: string; relativePath: string } | null {
  const match = pathname.match(/^\/projects\/([^/]+)(\/.*)?$/);
  if (!match) {
    return null;
  }
  return {
    projectId: decodeURIComponent(match[1] ?? ""),
    relativePath: match[2] && match[2] !== "/" ? match[2] : "/overview"
  };
}
