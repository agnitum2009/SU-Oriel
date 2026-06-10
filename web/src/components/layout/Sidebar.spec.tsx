import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/console-api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/console-api.js")>()),
  fetchVersion: vi.fn().mockResolvedValue({ version: "1.0.0", gitSha: "abc1234", buildDate: "" }),
  fetchProjectOnboardingStatus: vi.fn()
}));

// AiCliPanel 在挂载时拉 /api/ai-cli/tools;本测试只验证导航门控,桩掉它避免无服务网络拒绝。
vi.mock("../ai-cli/AiCliPanel.js", () => ({ AiCliPanel: () => null }));

import type { ProjectOnboardingStatusView, ProjectView } from "../../types/project.js";
import { useProjectStore } from "../../stores/project-store.js";
import { useUIStore } from "../../stores/ui-store.js";
import { Sidebar } from "./Sidebar.js";

const PID = "proj-1";

const project: ProjectView = {
  id: PID,
  name: "Proj1",
  localPath: "/tmp/proj1",
  summary: null,
  initStatus: "initialized",
  syncStatus: "idle",
  lastScanAt: null
};

function status(knowledgeBaseReady: boolean): ProjectOnboardingStatusView {
  return {
    projectId: PID,
    localPath: "/tmp/proj1",
    ccbRuntimeReady: true,
    knowledgeBaseReady,
    ccbConfigPath: "/tmp/proj1/.ccb/ccb.config",
    knowledgeBaseRootPath: "/tmp/proj1/docs/.ccb/index",
    manualCommand: "cd /tmp/proj1 && ccb",
    checkedAt: "2026-06-10T00:00:00.000Z"
  };
}

function setReady(ready: boolean) {
  useProjectStore.setState({
    projects: [project],
    tasks: [],
    onboardingByProject: { [PID]: { value: status(ready), fetchedAt: Date.now(), loading: false, error: null } }
  });
}

function renderSidebar() {
  return render(
    <MemoryRouter>
      <Sidebar loading={false} projects={[project]} selectedProjectId={PID} onSelectProject={() => {}} onCreateProject={() => {}} />
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  useUIStore.setState({ sidebarCollapsed: false, modalOpen: false, modalType: null, onboardingRequiredProjectId: null });
});

afterEach(() => {
  useUIStore.setState({ modalOpen: false, modalType: null, onboardingRequiredProjectId: null });
});

describe("Sidebar onboarding gate", () => {
  it("locks 项目 group items when not ready (button, not link) and click opens onboarding-required modal", async () => {
    setReady(false);
    renderSidebar();
    const reqItem = await screen.findByText("需求管理");
    expect(reqItem.closest("button")).not.toBeNull();
    expect(reqItem.closest("a")).toBeNull();
    expect(reqItem.closest("button")).toHaveAttribute("aria-disabled", "true");

    fireEvent.click(reqItem);
    expect(useUIStore.getState().modalType).toBe("onboarding-required");
    expect(useUIStore.getState().onboardingRequiredProjectId).toBe(PID);
  });

  it("keeps non-项目 groups reachable as links even when not ready", () => {
    setReady(false);
    renderSidebar();
    // 工作组「概览」与工具组「项目设置」不受门控,仍是导航链接
    expect(screen.getByText("概览").closest("a")).not.toBeNull();
    expect(screen.getByText("项目设置").closest("a")).not.toBeNull();
  });

  it("renders 项目 group items as navigable links when ready", async () => {
    setReady(true);
    renderSidebar();
    await waitFor(() => {
      const reqItem = screen.getByText("需求管理");
      expect(reqItem.closest("a")).not.toBeNull();
      expect(reqItem.closest("button")).toBeNull();
    });
  });
});
