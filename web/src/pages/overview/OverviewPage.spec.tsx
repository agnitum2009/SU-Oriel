import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/console-api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/console-api.js")>()),
  fetchProjectOnboardingStatus: vi.fn(),
  fetchProjectInitJobStatus: vi.fn(),
  initProjectKnowledgeBase: vi.fn(),
  spawnMainTerminal: vi.fn()
}));

import type { ProjectOnboardingStatusView } from "../../types/project.js";
import { useProjectStore } from "../../stores/project-store.js";
import { useUIStore } from "../../stores/ui-store.js";
import { OverviewPage } from "./OverviewPage.js";

const PID = "ov-1";

function status(ccbRuntimeReady: boolean, knowledgeBaseReady: boolean): ProjectOnboardingStatusView {
  return {
    projectId: PID,
    localPath: "/tmp/ov1",
    ccbRuntimeReady,
    knowledgeBaseReady,
    ccbConfigPath: "/tmp/ov1/.ccb/ccb.config",
    knowledgeBaseRootPath: "/tmp/ov1/docs/.ccb/index",
    manualCommand: "cd /tmp/ov1 && ccb",
    checkedAt: "2026-06-10T00:00:00.000Z"
  };
}

function setup(ccbRuntimeReady: boolean, knowledgeBaseReady: boolean) {
  useProjectStore.setState({
    selectedProjectId: PID,
    requirements: [],
    tasks: [],
    documents: [],
    syncJobs: [],
    indexHealth: null,
    loadingData: false,
    onboardingByProject: {
      [PID]: { value: status(ccbRuntimeReady, knowledgeBaseReady), fetchedAt: Date.now(), loading: false, error: null }
    }
  });
}

function renderOverview() {
  return render(
    <MemoryRouter>
      <OverviewPage />
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  useUIStore.setState({ toasts: [], mainTerminalOpenRequest: null });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("OverviewPage onboarding switch", () => {
  it("shows the full-page setup guide and hides metric cards when not ready", () => {
    setup(true, false); // knowledge-missing
    renderOverview();
    expect(screen.getByText("欢迎接入项目 · 完成两步即可开始")).toBeInTheDocument();
    // 指标卡(数据盘)不渲染
    expect(screen.queryByText("活跃需求")).toBeNull();
  });

  it("highlights step 1 (CCB runtime) when runtime is missing", () => {
    setup(false, false); // runtime-missing
    renderOverview();
    expect(screen.getByText("初始化 CCB 运行时")).toBeInTheDocument();
    // runtime 未就绪 → 复制命令可见
    expect(screen.getByRole("button", { name: "复制命令" })).toBeInTheDocument();
  });

  it("highlights step 2 (knowledge base) when runtime ready but knowledge missing", () => {
    setup(true, false); // knowledge-missing
    renderOverview();
    expect(screen.getByRole("button", { name: "一键初始化知识库" })).toBeInTheDocument();
    // step1 已完成 → 不再显示复制命令
    expect(screen.queryByRole("button", { name: "复制命令" })).toBeNull();
  });

  it("renders the data board (metric cards) and ready banner when both ready", async () => {
    setup(true, true);
    renderOverview();
    await waitFor(() => expect(screen.getByText("活跃需求")).toBeInTheDocument());
    expect(screen.queryByText("欢迎接入项目 · 完成两步即可开始")).toBeNull();
    expect(screen.getByText("项目接入已就绪")).toBeInTheDocument();
  });
});
