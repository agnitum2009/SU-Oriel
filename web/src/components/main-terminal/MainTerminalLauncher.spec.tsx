import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";

import type { SlotProjectionView } from "../../lib/console-api.js";
import type { SlotTerminalDescriptor } from "../../types/slot-terminal.js";
import type { SlotTerminalWebSocketLike } from "../../lib/slot-terminal-ws.js";
import { useProjectStore } from "../../stores/project-store.js";
import { useUIStore } from "../../stores/ui-store.js";
import { ProjectOnboardingBanner } from "../projects/ProjectOnboardingBanner.js";
import { SlotRequirementsFab } from "../slot-requirements-fab/SlotRequirementsFab.js";
import fabStyles from "../slot-requirements-fab/SlotRequirementsFab.module.css";
import { MainTerminalLauncher } from "./MainTerminalLauncher.js";
import launcherStyles from "./MainTerminalLauncher.module.css";

const xtermMocks = vi.hoisted(() => {
  class MockTerminal {
    static instances: MockTerminal[] = [];
    buffer = { active: { baseY: 0, viewportY: 0 } };
    dispose = vi.fn();
    loadAddon = vi.fn();
    open = vi.fn();
    reset = vi.fn();
    resize = vi.fn();
    scrollToBottom = vi.fn();
    write = vi.fn((_data: string, callback?: () => void) => callback?.());
    unicode = { activeVersion: "" };
    private onDataHandler: ((data: string) => void) | null = null;

    constructor() {
      MockTerminal.instances.push(this);
    }

    onData(handler: (data: string) => void) {
      this.onDataHandler = handler;
      return { dispose: vi.fn() };
    }

    attachCustomKeyEventHandler = vi.fn();
    getSelection = vi.fn(() => "");
    hasSelection = vi.fn(() => false);

    emitData(data: string): void {
      this.onDataHandler?.(data);
    }
  }

  return { MockTerminal };
});

vi.mock("@xterm/xterm", () => ({
  Terminal: xtermMocks.MockTerminal
}));

vi.mock("@xterm/addon-unicode11", () => ({
  Unicode11Addon: vi.fn()
}));

vi.mock("@xterm/addon-web-links", () => ({
  WebLinksAddon: vi.fn()
}));

vi.mock("../../lib/console-api.js", () => ({
  resolveApiBaseUrl: vi.fn(() => ""),
  fetchSlots: vi.fn(),
  fetchTerminalDescriptor: vi.fn(),
  fetchProjectInitJobStatus: vi.fn(),
  fetchProjectOnboardingStatus: vi.fn(),
  initProjectKnowledgeBase: vi.fn(),
  spawnMainTerminal: vi.fn()
}));

import {
  fetchProjectOnboardingStatus,
  fetchSlots,
  fetchTerminalDescriptor,
  initProjectKnowledgeBase
} from "../../lib/console-api.js";

class MockSlotTerminalWebSocket implements SlotTerminalWebSocketLike {
  static instances: MockSlotTerminalWebSocket[] = [];

  readonly url: string;
  readyState = 0;
  sent: string[] = [];
  closeCode: number | undefined;
  private readonly listeners = new Map<string, Array<(event: Event | MessageEvent) => void>>();

  constructor(url: string) {
    this.url = url;
    MockSlotTerminalWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number): void {
    this.closeCode = code;
    this.readyState = 3;
    this.dispatch("close", new Event("close"));
  }

  addEventListener(type: "open" | "message" | "close" | "error", handler: (event: Event | MessageEvent) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), handler]);
  }

  open(): void {
    this.readyState = 1;
    this.dispatch("open", new Event("open"));
  }

  serverSend(payload: unknown): void {
    this.dispatch("message", new MessageEvent("message", { data: JSON.stringify(payload) }));
  }

  sentFrames(): Array<Record<string, unknown>> {
    return this.sent.map((item) => JSON.parse(item) as Record<string, unknown>);
  }

  private dispatch(type: string, event: Event | MessageEvent): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

const descriptor: SlotTerminalDescriptor = {
  slotId: "main",
  sessionName: "ccb-su-ccb-test-session",
  panes: [
    { role: "claude", target: "%1", paneIndex: 0 },
    { role: "codex", target: "%2", paneIndex: 1 }
  ]
};

function projection(mainState = "available"): SlotProjectionView {
  return {
    project: { id: "p1", name: "P1", slotCount: 3 },
    slotCount: 3,
    main: { slotId: "main", lane: "coordination", state: mainState, canBindBusiness: false },
    slots: [],
    queue: [],
    shrinkEligibility: {
      projectId: "p1",
      slotCount: 3,
      tailSlotId: "slot-3",
      canShrink: true,
      eligible: true,
      checks: {
        slotBindingIdle: true,
        queueClear: true,
        runtimeIdle: true
      },
      reasons: [],
      details: {}
    }
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  MockSlotTerminalWebSocket.instances = [];
  xtermMocks.MockTerminal.instances = [];
  vi.mocked(fetchSlots).mockResolvedValue(projection());
  vi.mocked(fetchTerminalDescriptor).mockResolvedValue(descriptor);
  useProjectStore.setState({ selectedProjectId: "p1" });
  useUIStore.setState({ toasts: [], mainTerminalOpenRequest: null });
});

afterEach(() => {
  useProjectStore.setState({ selectedProjectId: null });
  useUIStore.setState({ mainTerminalOpenRequest: null });
});

describe("MainTerminalLauncher", () => {
  it("opens the main terminal modal, streams frames, sends input, switches panes, and closes websocket on unmount", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <MainTerminalLauncher webSocketFactory={MockSlotTerminalWebSocket} />
      </MemoryRouter>
    );

    await user.click(await screen.findByLabelText("main agent 组终端快捷入口"));

    expect(await screen.findByText("正在写 main 的 claude")).toBeInTheDocument();
    await waitFor(() => expect(MockSlotTerminalWebSocket.instances).toHaveLength(1));
    expect(MockSlotTerminalWebSocket.instances[0].url).toMatch(
      /\/api\/agent-terminal\/ws\?projectId=p1&group=main&pane=claude$/
    );

    MockSlotTerminalWebSocket.instances[0].open();
    MockSlotTerminalWebSocket.instances[0].serverSend({
      type: "frame",
      data: "main claude\n",
      cols: 80,
      rows: 24,
      generation: 1,
      initial: true,
      mode: "snapshot-fallback"
    });
    await nextRenderFrame();
    expect(xtermMocks.MockTerminal.instances[0].write).toHaveBeenCalledWith("main claude", expect.any(Function));
    expect(await screen.findByText("历史受限(快照模式)")).toBeInTheDocument();

    MockSlotTerminalWebSocket.instances[0].serverSend({
      type: "frame",
      kind: "stream",
      data: "live chunk",
      seq: 1,
      mode: "stream"
    });
    await waitFor(() => expect(screen.queryByText("历史受限(快照模式)")).not.toBeInTheDocument());

    xtermMocks.MockTerminal.instances[0].emitData("echo ok");
    expect(MockSlotTerminalWebSocket.instances[0].sentFrames()).toContainEqual({ type: "input", data: "echo ok" });

    await user.click(screen.getByRole("tab", { name: "codex" }));
    expect(await screen.findByText("正在写 main 的 codex")).toBeInTheDocument();
    await waitFor(() => expect(MockSlotTerminalWebSocket.instances).toHaveLength(2));
    expect(MockSlotTerminalWebSocket.instances[0].closeCode).toBe(1000);
    expect(MockSlotTerminalWebSocket.instances[1].url).toMatch(
      /\/api\/agent-terminal\/ws\?projectId=p1&group=main&pane=codex$/
    );

    await user.click(screen.getByRole("button", { name: "关闭" }));
    expect(MockSlotTerminalWebSocket.instances[1].closeCode).toBe(1000);
    expect(screen.queryByRole("dialog", { name: "main agent 组终端" })).not.toBeInTheDocument();
  });

  it("shows the main fallback without opening websocket when descriptor returns 404", async () => {
    vi.mocked(fetchTerminalDescriptor).mockRejectedValueOnce(new Error("slot terminal unavailable"));
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <MainTerminalLauncher webSocketFactory={MockSlotTerminalWebSocket} />
      </MemoryRouter>
    );

    await user.click(await screen.findByLabelText("main agent 组终端快捷入口"));

    expect(await screen.findByText("main 会话未启动，请在 ccb 启动后重试")).toBeInTheDocument();
    expect(MockSlotTerminalWebSocket.instances).toHaveLength(0);
  });

  it("opens the modal from a ui-store request and clears the request", async () => {
    render(
      <MemoryRouter>
        <MainTerminalLauncher webSocketFactory={MockSlotTerminalWebSocket} />
      </MemoryRouter>
    );
    await screen.findByLabelText("main agent 组终端快捷入口");

    act(() => {
      useUIStore.getState().requestOpenMainTerminal("p1");
    });

    expect(await screen.findByRole("dialog", { name: "main agent 组终端" })).toBeInTheDocument();
    expect(useUIStore.getState().mainTerminalOpenRequest).toBeNull();
  });

  it("discards a ui-store request for a different project without opening", async () => {
    render(
      <MemoryRouter>
        <MainTerminalLauncher webSocketFactory={MockSlotTerminalWebSocket} />
      </MemoryRouter>
    );
    await screen.findByLabelText("main agent 组终端快捷入口");

    act(() => {
      useUIStore.getState().requestOpenMainTerminal("p2");
    });

    await waitFor(() => expect(useUIStore.getState().mainTerminalOpenRequest).toBeNull());
    expect(screen.queryByRole("dialog", { name: "main agent 组终端" })).not.toBeInTheDocument();
  });

  it("keeps the modal open when a duplicate request arrives", async () => {
    render(
      <MemoryRouter>
        <MainTerminalLauncher webSocketFactory={MockSlotTerminalWebSocket} />
      </MemoryRouter>
    );
    await screen.findByLabelText("main agent 组终端快捷入口");

    act(() => {
      useUIStore.getState().requestOpenMainTerminal("p1");
    });
    expect(await screen.findByRole("dialog", { name: "main agent 组终端" })).toBeInTheDocument();

    act(() => {
      useUIStore.getState().requestOpenMainTerminal("p1");
    });

    expect(await screen.findByRole("dialog", { name: "main agent 组终端" })).toBeInTheDocument();
    await waitFor(() => expect(useUIStore.getState().mainTerminalOpenRequest).toBeNull());
  });

  it("auto-opens the main terminal modal after init confirm succeeds (banner integration)", async () => {
    const user = userEvent.setup();
    vi.mocked(fetchProjectOnboardingStatus).mockResolvedValue({
      projectId: "p1",
      localPath: "/tmp/p1",
      ccbRuntimeReady: true,
      knowledgeBaseReady: false,
      ccbConfigPath: "/tmp/p1/.ccb/ccb.config",
      knowledgeBaseRootPath: "/tmp/p1/docs/.ccb/index",
      manualCommand: "cd /tmp/p1 && ccb",
      checkedAt: "2026-05-20T00:00:00.000Z"
    });
    vi.mocked(initProjectKnowledgeBase).mockResolvedValue({
      jobId: "job-auto-open",
      claudeAgentName: "project_claude",
      submittedAt: "2026-05-20T00:00:00.000Z"
    });

    render(
      <MemoryRouter>
        <ProjectOnboardingBanner projectId="p1" />
        <MainTerminalLauncher webSocketFactory={MockSlotTerminalWebSocket} />
      </MemoryRouter>
    );

    await user.click(await screen.findByRole("button", { name: "一键初始化知识库" }));
    await user.click(screen.getByRole("button", { name: "确认初始化" }));

    const terminalDialog = await screen.findByRole("dialog", { name: "main agent 组终端" });
    expect(screen.queryByRole("dialog", { name: "初始化知识库" })).not.toBeInTheDocument();
    await waitFor(() => expect(useUIStore.getState().mainTerminalOpenRequest).toBeNull());
    const closeButton = terminalDialog.querySelector("button[aria-label='关闭']");
    expect(closeButton).not.toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(closeButton));
  });

  it("shows a retry button in the fallback state and resolves the terminal after retry", async () => {
    vi.mocked(fetchTerminalDescriptor)
      .mockRejectedValueOnce(new Error("slot terminal unavailable"))
      .mockResolvedValueOnce(descriptor);
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <MainTerminalLauncher webSocketFactory={MockSlotTerminalWebSocket} />
      </MemoryRouter>
    );

    await user.click(await screen.findByLabelText("main agent 组终端快捷入口"));

    expect(await screen.findByText("main 会话未启动，请在 ccb 启动后重试")).toBeInTheDocument();
    expect(MockSlotTerminalWebSocket.instances).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: "重试" }));

    expect(await screen.findByTestId("main-terminal-surface-wrap")).toBeInTheDocument();
    await waitFor(() => expect(MockSlotTerminalWebSocket.instances.length).toBeGreaterThan(0));
  });

  it("coexists with the slot requirements FAB and applies the terminal modal scroll-layer class", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <MainTerminalLauncher webSocketFactory={MockSlotTerminalWebSocket} />
        <SlotRequirementsFab />
      </MemoryRouter>
    );

    expect(await screen.findByLabelText("main agent 组终端快捷入口")).toBeInTheDocument();
    expect(screen.getByLabelText("绑定 slot 的需求快捷入口")).toBeInTheDocument();
    expect(document.querySelector(`.${launcherStyles.root}`)).not.toBeNull();
    expect(document.querySelector(`.${fabStyles.root}`)).not.toBeNull();

    await user.click(screen.getByLabelText("main agent 组终端快捷入口"));
    const dialog = await screen.findByRole("dialog", { name: "main agent 组终端" });
    expect(dialog.querySelector(`.${launcherStyles.modalContent}`)).not.toBeNull();
    expect(await screen.findByTestId("main-terminal-surface-wrap")).toBeInTheDocument();
  });
});

async function nextRenderFrame(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}
