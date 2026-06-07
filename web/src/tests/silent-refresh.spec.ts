import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useProjectStore } from "../stores/project-store.js";
import type { ProjectView } from "../types/project.js";

function makeProject(overrides: Partial<ProjectView> = {}): ProjectView {
  return {
    id: "p1",
    name: "P1",
    localPath: "/tmp/p1",
    summary: null,
    initStatus: "initialized",
    lastScanAt: "2026-05-08T10:00:00.000Z",
    syncStatus: "idle",
    ...overrides
  };
}

function mockFetchProjectsResponse(items: ProjectView[]): void {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ items }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    })
  );
  vi.stubGlobal("fetch", fetchMock);
}

describe("ADR-0012 §R3 silentRefreshProjects", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // 重置 store 状态（zustand vanilla store 没自动隔离）
    useProjectStore.setState({
      projects: [],
      selectedProjectId: null,
      documents: [],
      tasks: [],
      requirements: [],
      syncJobs: [],
      indexHealth: null,
      loadingProjects: false,
      loadingData: false,
      savingTask: false
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("silent refresh 更新 projects 数组但不切换 loadingProjects 为 true", async () => {
    mockFetchProjectsResponse([makeProject({ id: "p1" })]);
    const before = useProjectStore.getState();
    expect(before.loadingProjects).toBe(false);

    let observedLoadingDuringFetch = false;
    const unsubscribe = useProjectStore.subscribe((state) => {
      if (state.loadingProjects) observedLoadingDuringFetch = true;
    });

    await useProjectStore.getState().silentRefreshProjects();
    unsubscribe();

    const after = useProjectStore.getState();
    expect(after.projects).toHaveLength(1);
    expect(after.projects[0].id).toBe("p1");
    expect(after.loadingProjects).toBe(false);
    expect(observedLoadingDuringFetch).toBe(false);
  });

  it("loadProjects（非 silent）会设置 loadingProjects=true 再回 false", async () => {
    mockFetchProjectsResponse([makeProject({ id: "p2" })]);
    let sawLoading = false;
    const unsubscribe = useProjectStore.subscribe((state) => {
      if (state.loadingProjects) sawLoading = true;
    });

    await useProjectStore.getState().loadProjects();
    unsubscribe();

    expect(sawLoading).toBe(true);
    expect(useProjectStore.getState().loadingProjects).toBe(false);
    expect(useProjectStore.getState().projects).toHaveLength(1);
  });

  it("loadProjects 不改写 URL 投影的 selectedProjectId，仅清理失效项目数据", async () => {
    useProjectStore.setState({
      projects: [makeProject({ id: "stale-project" })],
      selectedProjectId: "stale-project",
      documents: [{ id: "doc-1" } as never],
      tasks: [{ id: "task-1" } as never],
      requirements: [{ id: "req-1" } as never]
    });
    mockFetchProjectsResponse([]);

    await useProjectStore.getState().loadProjects();

    expect(useProjectStore.getState().projects).toHaveLength(0);
    expect(useProjectStore.getState().selectedProjectId).toBe("stale-project");
    expect(useProjectStore.getState().documents).toHaveLength(0);
    expect(useProjectStore.getState().tasks).toHaveLength(0);
    expect(useProjectStore.getState().requirements).toHaveLength(0);
  });

  it("project identity 只能通过 URL 同步器写入，旧 selectProject setter 已移除", () => {
    expect(useProjectStore.getState()).not.toHaveProperty("selectProject");

    useProjectStore.getState().syncSelectedProjectFromUrl("p1");
    expect(useProjectStore.getState().selectedProjectId).toBe("p1");
    useProjectStore.getState().syncSelectedProjectFromUrl(null);
    expect(useProjectStore.getState().selectedProjectId).toBeNull();
  });

  it("silentRefreshProjects 不修正失效 selectedProjectId，避免 30s 轮询造成身份漂移", async () => {
    useProjectStore.setState({
      projects: [makeProject({ id: "stale-project" })],
      selectedProjectId: "stale-project",
      documents: [{ id: "doc-1" } as never]
    });
    mockFetchProjectsResponse([makeProject({ id: "p2" })]);

    await useProjectStore.getState().silentRefreshProjects();

    expect(useProjectStore.getState().selectedProjectId).toBe("stale-project");
    expect(useProjectStore.getState().projects.map((project) => project.id)).toEqual(["p2"]);
    expect(useProjectStore.getState().documents).toHaveLength(0);
  });

  it("scanProject 在 selectedProjectId 不属于项目列表时给出前端友好错误", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    useProjectStore.setState({
      projects: [],
      selectedProjectId: "stale-project"
    });

    await expect(useProjectStore.getState().scanProject()).rejects.toThrow("项目不存在，请重新创建或选择项目");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("silent refresh 的网络失败不抛异常（polling 容错）", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(useProjectStore.getState().silentRefreshProjects()).resolves.toBeUndefined();
    expect(useProjectStore.getState().loadingProjects).toBe(false);
  });

  it("lastScanAt 变化时 store 持有新值，可供调用方比对触发 loadProjectData", async () => {
    mockFetchProjectsResponse([makeProject({ id: "p1", lastScanAt: "2026-05-08T10:00:00.000Z" })]);
    await useProjectStore.getState().silentRefreshProjects();
    expect(useProjectStore.getState().projects[0].lastScanAt).toBe("2026-05-08T10:00:00.000Z");

    mockFetchProjectsResponse([makeProject({ id: "p1", lastScanAt: "2026-05-08T11:00:00.000Z" })]);
    await useProjectStore.getState().silentRefreshProjects();
    expect(useProjectStore.getState().projects[0].lastScanAt).toBe("2026-05-08T11:00:00.000Z");
  });
});
