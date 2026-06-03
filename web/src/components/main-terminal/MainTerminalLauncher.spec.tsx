import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";

import type { SlotProjectionView } from "../../lib/console-api.js";
import type { SlotTerminalDescriptor } from "../../types/slot-terminal.js";
import type { SlotTerminalWebSocketLike } from "../../lib/slot-terminal-ws.js";
import { useProjectStore } from "../../stores/project-store.js";
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
  fetchTerminalDescriptor: vi.fn()
}));

import { fetchSlots, fetchTerminalDescriptor } from "../../lib/console-api.js";

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
    project: { id: "p1", name: "P1" },
    main: { slotId: "main", lane: "coordination", state: mainState, canBindBusiness: false },
    slots: [],
    queue: []
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  MockSlotTerminalWebSocket.instances = [];
  xtermMocks.MockTerminal.instances = [];
  vi.mocked(fetchSlots).mockResolvedValue(projection());
  vi.mocked(fetchTerminalDescriptor).mockResolvedValue(descriptor);
  useProjectStore.setState({ selectedProjectId: "p1" });
});

afterEach(() => {
  useProjectStore.setState({ selectedProjectId: null });
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
    MockSlotTerminalWebSocket.instances[0].serverSend({ type: "frame", data: "main claude\n", cols: 80, rows: 24, generation: 1, initial: true });
    await nextRenderFrame();
    expect(xtermMocks.MockTerminal.instances[0].write).toHaveBeenCalledWith("main claude", expect.any(Function));

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
