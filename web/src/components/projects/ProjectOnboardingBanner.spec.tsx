import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useProjectStore } from "../../stores/project-store.js";
import { useUIStore } from "../../stores/ui-store.js";
import { ProjectOnboardingBanner } from "./ProjectOnboardingBanner.js";

vi.mock("../../lib/console-api.js", () => ({
  fetchProjectInitJobStatus: vi.fn(),
  fetchProjectOnboardingStatus: vi.fn(),
  initProjectKnowledgeBase: vi.fn(),
  spawnMainTerminal: vi.fn()
}));

import * as consoleApi from "../../lib/console-api.js";

function status(overrides: Partial<Awaited<ReturnType<typeof consoleApi.fetchProjectOnboardingStatus>>> = {}) {
  return {
    projectId: "project-1",
    localPath: "/tmp/project",
    ccbRuntimeReady: true,
    knowledgeBaseReady: false,
    ccbConfigPath: "/tmp/project/.ccb/ccb.config",
    knowledgeBaseRootPath: "/tmp/project/docs/.ccb/index",
    manualCommand: "cd /tmp/project && ccb",
    checkedAt: "2026-05-20T00:00:00.000Z",
    ...overrides
  };
}

async function flushPromises() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("ProjectOnboardingBanner", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    useUIStore.setState({ toasts: [], mainTerminalOpenRequest: null });
    // banner 现经 project-store 单一源读接入状态;每例重置避免跨例缓存泄漏。
    useProjectStore.setState({ onboardingByProject: {} });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: vi.fn().mockResolvedValue(undefined)
      }
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders red runtime guidance and copies the manual ccb command", async () => {
    vi.mocked(consoleApi.fetchProjectOnboardingStatus).mockResolvedValue(
      status({ projectId: "project-red", ccbRuntimeReady: false, knowledgeBaseReady: false })
    );

    render(<ProjectOnboardingBanner projectId="project-red" />);

    expect(await screen.findByText(/项目 ccb runtime 未初始化/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "复制命令" }));

    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith("cd /tmp/project && ccb"));
    expect(screen.getByRole("button", { name: "重新检测" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /打开实体终端/ })).not.toBeInTheDocument();
  });

  it("shows the main terminal button in yellow and green states", async () => {
    vi.mocked(consoleApi.fetchProjectOnboardingStatus).mockResolvedValueOnce(
      status({ projectId: "project-terminal-yellow", ccbRuntimeReady: true, knowledgeBaseReady: false })
    );
    const yellow = render(<ProjectOnboardingBanner projectId="project-terminal-yellow" />);
    expect(await screen.findByRole("button", { name: /打开实体终端/ })).toBeInTheDocument();
    yellow.unmount();

    vi.mocked(consoleApi.fetchProjectOnboardingStatus).mockResolvedValueOnce(
      status({ projectId: "project-terminal-green", ccbRuntimeReady: true, knowledgeBaseReady: true })
    );
    render(<ProjectOnboardingBanner projectId="project-terminal-green" />);
    expect(await screen.findByRole("button", { name: /打开实体终端/ })).toBeInTheDocument();
  });

  it("opens the main native terminal from the onboarding banner", async () => {
    vi.mocked(consoleApi.fetchProjectOnboardingStatus).mockResolvedValue(
      status({ projectId: "project-terminal-open", ccbRuntimeReady: true, knowledgeBaseReady: false })
    );
    vi.mocked(consoleApi.spawnMainTerminal).mockResolvedValue({
      spawned: true,
      attempted: ["xterm -e bash -lc tmux"],
      fallbackCommand: "tmux -S /tmp/project/.ccb/ccbd/tmux.sock attach -t ccb-main",
      sessionName: "ccb-main",
      socketPath: "/tmp/project/.ccb/ccbd/tmux.sock",
      anchorPath: "/tmp/project"
    });

    render(<ProjectOnboardingBanner projectId="project-terminal-open" />);
    fireEvent.click(await screen.findByRole("button", { name: /打开实体终端/ }));

    await waitFor(() => expect(consoleApi.spawnMainTerminal).toHaveBeenCalledWith("project-terminal-open"));
    expect(useUIStore.getState().toasts.some((toast) => toast.message === "已尝试打开实体终端")).toBe(true);
  });

  it("reports native terminal spawn failures with attempted commands", async () => {
    vi.mocked(consoleApi.fetchProjectOnboardingStatus).mockResolvedValue(
      status({ projectId: "project-terminal-failed", ccbRuntimeReady: true, knowledgeBaseReady: true })
    );
    vi.mocked(consoleApi.spawnMainTerminal).mockResolvedValue({
      spawned: false,
      attempted: ["gnome-terminal (not found)", "konsole (not found)", "xterm (not found)"],
      reason: "no supported terminal emulator found",
      fallbackCommand: "tmux -S /tmp/project/.ccb/ccbd/tmux.sock attach -t ccb-main",
      sessionName: "ccb-main",
      socketPath: "/tmp/project/.ccb/ccbd/tmux.sock",
      anchorPath: "/tmp/project"
    });

    render(<ProjectOnboardingBanner projectId="project-terminal-failed" />);
    fireEvent.click(await screen.findByRole("button", { name: /打开实体终端/ }));

    await waitFor(() => expect(consoleApi.spawnMainTerminal).toHaveBeenCalledWith("project-terminal-failed"));
    expect(useUIStore.getState().toasts.some((toast) =>
      toast.message.includes("打开失败：no supported terminal emulator found") &&
      toast.message.includes("gnome-terminal (not found)") &&
      toast.message.includes("konsole (not found)") &&
      toast.message.includes("更多见 server log")
    )).toBe(true);
  });

  it("opens confirmation modal and submits /ccb:su-init for the yellow state", async () => {
    vi.mocked(consoleApi.fetchProjectOnboardingStatus).mockResolvedValue(
      status({ projectId: "project-yellow", ccbRuntimeReady: true, knowledgeBaseReady: false })
    );
    vi.mocked(consoleApi.initProjectKnowledgeBase).mockResolvedValue({
      jobId: "job-su-init",
      claudeAgentName: "project_claude",
      submittedAt: "2026-05-20T00:00:00.000Z"
    });
    vi.mocked(consoleApi.fetchProjectInitJobStatus).mockResolvedValue({
      jobId: "job-su-init",
      status: "running",
      updatedAt: "2026-05-20T00:00:03.000Z"
    });

    render(<ProjectOnboardingBanner projectId="project-yellow" />);

    fireEvent.click(await screen.findByRole("button", { name: "一键初始化知识库" }));
    expect(screen.getByRole("dialog", { name: "初始化知识库" })).toBeInTheDocument();
    expect(screen.getByText(/即将向主项目 ccbd 投递 \/ccb:su-init 命令/)).toBeInTheDocument();
    expect(screen.getByText(/如果你正在跟 Claude 聊天，会被打断/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "确认初始化" }));

    await waitFor(() => expect(consoleApi.initProjectKnowledgeBase).toHaveBeenCalledWith("project-yellow"));
    expect(await screen.findByText(/初始化中（jobId: job-su-init）/)).toBeInTheDocument();
    expect(useUIStore.getState().mainTerminalOpenRequest).toEqual({ projectId: "project-yellow" });
  });

  it("requests the main terminal modal when re-initializing from the ready state", async () => {
    vi.mocked(consoleApi.fetchProjectOnboardingStatus).mockResolvedValue(
      status({ projectId: "project-reinit", ccbRuntimeReady: true, knowledgeBaseReady: true })
    );
    vi.mocked(consoleApi.initProjectKnowledgeBase).mockResolvedValue({
      jobId: "job-reinit",
      claudeAgentName: "project_claude",
      submittedAt: "2026-05-20T00:00:00.000Z"
    });
    vi.mocked(consoleApi.fetchProjectInitJobStatus).mockResolvedValue({
      jobId: "job-reinit",
      status: "running",
      updatedAt: "2026-05-20T00:00:03.000Z"
    });

    render(<ProjectOnboardingBanner projectId="project-reinit" />);

    fireEvent.click(await screen.findByRole("button", { name: "重新初始化知识库" }));
    fireEvent.click(screen.getByRole("button", { name: "确认初始化" }));

    await waitFor(() => expect(consoleApi.initProjectKnowledgeBase).toHaveBeenCalledWith("project-reinit"));
    await waitFor(() =>
      expect(useUIStore.getState().mainTerminalOpenRequest).toEqual({ projectId: "project-reinit" })
    );
  });

  it("does not request the main terminal modal when init submit fails", async () => {
    vi.mocked(consoleApi.fetchProjectOnboardingStatus).mockResolvedValue(
      status({ projectId: "project-submit-failed", ccbRuntimeReady: true, knowledgeBaseReady: false })
    );
    vi.mocked(consoleApi.initProjectKnowledgeBase).mockRejectedValue(new Error("ccbd unreachable"));

    render(<ProjectOnboardingBanner projectId="project-submit-failed" />);

    fireEvent.click(await screen.findByRole("button", { name: "一键初始化知识库" }));
    fireEvent.click(screen.getByRole("button", { name: "确认初始化" }));

    await waitFor(() =>
      expect(useUIStore.getState().toasts.some((toast) => toast.message === "ccbd unreachable")).toBe(true)
    );
    expect(useUIStore.getState().mainTerminalOpenRequest).toBeNull();
    expect(screen.getByRole("dialog", { name: "初始化知识库" })).toBeInTheDocument();
  });

  it("polls every 3s and turns green when the knowledge base becomes ready", async () => {
    vi.useFakeTimers();
    vi.mocked(consoleApi.fetchProjectOnboardingStatus)
      .mockResolvedValueOnce(status({ projectId: "project-success", knowledgeBaseReady: false }))
      .mockResolvedValueOnce(status({ projectId: "project-success", knowledgeBaseReady: true }));
    vi.mocked(consoleApi.initProjectKnowledgeBase).mockResolvedValue({
      jobId: "job-success",
      claudeAgentName: "project_claude",
      submittedAt: "2026-05-20T00:00:00.000Z"
    });
    vi.mocked(consoleApi.fetchProjectInitJobStatus).mockResolvedValue({
      jobId: "job-success",
      status: "running",
      updatedAt: "2026-05-20T00:00:03.000Z"
    });

    render(<ProjectOnboardingBanner projectId="project-success" />);
    await flushPromises();
    fireEvent.click(screen.getByRole("button", { name: "一键初始化知识库" }));
    fireEvent.click(screen.getByRole("button", { name: "确认初始化" }));
    await flushPromises();
    expect(screen.getByText(/初始化中（jobId: job-success）/)).toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    await flushPromises();

    expect(screen.getByText("项目接入已就绪")).toBeInTheDocument();
    expect(useUIStore.getState().toasts.some((toast) => toast.message === "知识库已就绪")).toBe(true);
  });

  it("reports failed su-init jobs with a ccb pend hint", async () => {
    vi.useFakeTimers();
    vi.mocked(consoleApi.fetchProjectOnboardingStatus).mockResolvedValue(
      status({ projectId: "project-failed", knowledgeBaseReady: false })
    );
    vi.mocked(consoleApi.initProjectKnowledgeBase).mockResolvedValue({
      jobId: "job-failed",
      claudeAgentName: "project_claude",
      submittedAt: "2026-05-20T00:00:00.000Z"
    });
    vi.mocked(consoleApi.fetchProjectInitJobStatus).mockResolvedValue({
      jobId: "job-failed",
      status: "failed",
      reason: "kernel snapshot missing",
      updatedAt: "2026-05-20T00:00:03.000Z"
    });

    render(<ProjectOnboardingBanner projectId="project-failed" />);
    await flushPromises();
    fireEvent.click(screen.getByRole("button", { name: "一键初始化知识库" }));
    fireEvent.click(screen.getByRole("button", { name: "确认初始化" }));
    await flushPromises();
    expect(screen.getByText(/初始化中（jobId: job-failed）/)).toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    await flushPromises();

    expect(useUIStore.getState().toasts.some((toast) =>
      toast.message.includes("su-init 失败：kernel snapshot missing") &&
      toast.message.includes("ccb pend job-failed")
    )).toBe(true);
  });

  it("reports a timeout after 60s when the knowledge base is still not ready", async () => {
    vi.useFakeTimers();
    vi.mocked(consoleApi.fetchProjectOnboardingStatus).mockResolvedValue(
      status({ projectId: "project-timeout", knowledgeBaseReady: false })
    );
    vi.mocked(consoleApi.initProjectKnowledgeBase).mockResolvedValue({
      jobId: "job-timeout",
      claudeAgentName: "project_claude",
      submittedAt: "2026-05-20T00:00:00.000Z"
    });
    vi.mocked(consoleApi.fetchProjectInitJobStatus).mockResolvedValue({
      jobId: "job-timeout",
      status: "running",
      updatedAt: "2026-05-20T00:00:03.000Z"
    });

    render(<ProjectOnboardingBanner projectId="project-timeout" />);
    await flushPromises();
    fireEvent.click(screen.getByRole("button", { name: "一键初始化知识库" }));
    fireEvent.click(screen.getByRole("button", { name: "确认初始化" }));
    await flushPromises();
    expect(screen.getByText(/初始化中（jobId: job-timeout）/)).toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    await flushPromises();

    expect(useUIStore.getState().toasts.some((toast) =>
      toast.message.includes("执行超时") && toast.message.includes("ccb pend job-timeout")
    )).toBe(true);
  });

  it("unmounting during active init polling does not throw (poll result lands in the store)", async () => {
    vi.useFakeTimers();
    vi.mocked(consoleApi.fetchProjectOnboardingStatus).mockResolvedValue(
      status({ projectId: "project-unmount", knowledgeBaseReady: false })
    );
    vi.mocked(consoleApi.initProjectKnowledgeBase).mockResolvedValue({
      jobId: "job-unmount",
      claudeAgentName: "project_claude",
      submittedAt: "2026-05-20T00:00:00.000Z"
    });
    vi.mocked(consoleApi.fetchProjectInitJobStatus).mockResolvedValue({
      jobId: "job-unmount",
      status: "running",
      updatedAt: "2026-05-20T00:00:03.000Z"
    });

    const view = render(<ProjectOnboardingBanner projectId="project-unmount" />);
    await flushPromises();
    fireEvent.click(screen.getByRole("button", { name: "一键初始化知识库" }));
    fireEvent.click(screen.getByRole("button", { name: "确认初始化" }));
    await flushPromises();

    // 卸载后推进轮询:状态写 project-store(单一源)是安全的,settled 守卫阻止 unmounted setState。
    view.unmount();
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    await flushPromises();

    expect(useProjectStore.getState().onboardingByProject["project-unmount"]).toBeDefined();
  });
});
