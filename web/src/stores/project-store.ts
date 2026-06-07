import { create } from "zustand";

import {
  createProject as createProjectRequest,
  createRequirement as createRequirementRequest,
  fetchDocuments,
  fetchProjectIndexHealth,
  fetchProjects,
  fetchRequirements,
  fetchSyncJobs,
  fetchTasks,
  scanProject as scanProjectRequest,
  updateTask as updateTaskRequest
} from "../lib/console-api.js";
import type { CreateProjectFormValue, ProjectIndexHealthView, ProjectView } from "../types/project.js";
import type { RequirementFormValue, RequirementView } from "../types/requirement.js";
import type { SyncJobView } from "../types/sync-job.js";
import type { TaskView, UpdateTaskInput } from "../types/task.js";
import type { DocumentView } from "../types/document.js";

const MISSING_PROJECT_MESSAGE = "项目不存在，请重新创建或选择项目";

interface ProjectStore {
  projects: ProjectView[];
  selectedProjectId: string | null;
  documents: DocumentView[];
  tasks: TaskView[];
  requirements: RequirementView[];
  syncJobs: SyncJobView[];
  indexHealth: ProjectIndexHealthView | null;
  loadingProjects: boolean;
  loadingData: boolean;
  savingTask: boolean;
  loadProjects: () => Promise<void>;
  silentRefreshProjects: () => Promise<void>;
  syncSelectedProjectFromUrl: (id: string | null) => void;
  loadProjectData: (projectId: string) => Promise<void>;
  createProject: (input: CreateProjectFormValue) => Promise<ProjectView>;
  scanProject: () => Promise<void>;
  createRequirement: (input: RequirementFormValue) => Promise<RequirementView>;
  updateTask: (taskId: string, input: UpdateTaskInput) => Promise<TaskView>;
}

function resolveSelectedProjectId(projects: ProjectView[], selectedProjectId: string | null): string | null {
  if (selectedProjectId && projects.some((project) => project.id === selectedProjectId)) {
    return selectedProjectId;
  }
  return null;
}

function emptyProjectData() {
  return {
    documents: [],
    tasks: [],
    requirements: [],
    syncJobs: [],
    indexHealth: null
  };
}

export const useProjectStore = create<ProjectStore>()((set, get) => ({
  projects: [],
  selectedProjectId: null,
  documents: [],
  tasks: [],
  requirements: [],
  syncJobs: [],
  indexHealth: null,
  loadingProjects: false,
  loadingData: false,
  savingTask: false,
  loadProjects: async () => {
    set({ loadingProjects: true });
    try {
      const projects = await fetchProjects();
      set((state) => {
        const selectedProjectId = resolveSelectedProjectId(projects, state.selectedProjectId);
        return {
          projects,
          ...(selectedProjectId === state.selectedProjectId ? {} : emptyProjectData())
        };
      });
    } finally {
      set({ loadingProjects: false });
    }
  },
  // ADR-0012 后端可能在 file-watcher 触发后改 DB；前端无 push 通道，改用 silent refresh
  // 30s 轮询比对 lastScanAt。silent 表示不动 loadingProjects/loadingData，避免 UI 闪 skeleton。
  silentRefreshProjects: async () => {
    try {
      const projects = await fetchProjects();
      set((state) => {
        const selectedProjectId = resolveSelectedProjectId(projects, state.selectedProjectId);
        return {
          projects,
          ...(selectedProjectId === state.selectedProjectId ? {} : emptyProjectData())
        };
      });
    } catch {
      // polling 失败不打扰用户；下一次心跳会重试
    }
  },
  syncSelectedProjectFromUrl: (id) => {
    set({ selectedProjectId: id });
  },
  loadProjectData: async (projectId) => {
    set({ loadingData: true });
    try {
      const [documents, tasks, requirements, syncJobs, indexHealth] = await Promise.all([
        fetchDocuments(projectId),
        fetchTasks(projectId),
        fetchRequirements(projectId),
        fetchSyncJobs(projectId),
        fetchProjectIndexHealth(projectId)
      ]);
      set({ documents, tasks, requirements, syncJobs, indexHealth });
    } finally {
      set({ loadingData: false });
    }
  },
  createProject: async (input) => {
    const createdProject = await createProjectRequest(input);
    const projects = await fetchProjects();
    set({
      projects
    });
    return createdProject;
  },
  scanProject: async () => {
    const projectId = get().selectedProjectId;
    if (!projectId) {
      throw new Error("当前没有选中的项目");
    }
    if (!get().projects.some((project) => project.id === projectId)) {
      set(emptyProjectData());
      throw new Error(MISSING_PROJECT_MESSAGE);
    }

    await scanProjectRequest(projectId);
    set((state) => ({
      projects: state.projects.map((project) =>
        project.id === projectId ? { ...project, syncStatus: "scanning" } : project
      )
    }));
    await get().silentRefreshProjects();
  },
  createRequirement: async (input) => {
    const projectId = get().selectedProjectId;
    if (!projectId) {
      throw new Error("当前没有选中的项目");
    }

    const requirement = await createRequirementRequest(projectId, input);
    await get().loadProjectData(projectId);
    return requirement;
  },
  updateTask: async (taskId, input) => {
    set({ savingTask: true });
    try {
      const updatedTask = await updateTaskRequest(taskId, input);
      set((state) => ({
        tasks: state.tasks.map((task) => (task.id === taskId ? { ...task, ...updatedTask } : task))
      }));
      return updatedTask;
    } finally {
      set({ savingTask: false });
    }
  }
}));
