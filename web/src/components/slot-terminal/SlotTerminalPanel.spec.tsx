import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SlotTerminalWebSocketLike } from "../../lib/slot-terminal-ws.js";
import type { SlotTerminalDescriptor } from "../../types/slot-terminal.js";
import { SlotTerminalPanel } from "./SlotTerminalPanel.js";

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
  slotId: "slot-3",
  sessionName: "ccb-su-ccb-test-session",
  panes: [
    { role: "claude", target: "%7", paneIndex: 1 },
    { role: "codex", target: "%8", paneIndex: 2 }
  ]
};

beforeEach(() => {
  MockSlotTerminalWebSocket.instances = [];
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(descriptor)));
  setDocumentHidden(false);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SlotTerminalPanel", () => {
  it("resolves requirement-scoped panes, renders claude/codex tabs, and only connects the active tab", async () => {
    renderPanel();

    expect(await screen.findByText("正在写 slot-3 的 claude")).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith("/api/projects/project-1/requirements/req-1/slot-terminal");
    expect(screen.getByRole("tab", { name: "claude" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "codex" })).toHaveAttribute("aria-selected", "false");
    await waitFor(() => expect(MockSlotTerminalWebSocket.instances).toHaveLength(1));
    expect(MockSlotTerminalWebSocket.instances[0].url).toMatch(
      /\/api\/slot-terminal\/ws\?projectId=project-1&requirementId=req-1&pane=claude$/
    );

    MockSlotTerminalWebSocket.instances[0].open();
    expect(MockSlotTerminalWebSocket.instances[0].sentFrames()).toEqual([
      { type: "visibility", state: "visible" },
      { type: "active", active: true }
    ]);

    fireEvent.click(screen.getByRole("tab", { name: "codex" }));

    expect(await screen.findByText("正在写 slot-3 的 codex")).toBeInTheDocument();
    await waitFor(() => expect(MockSlotTerminalWebSocket.instances).toHaveLength(2));
    expect(MockSlotTerminalWebSocket.instances[0].closeCode).toBe(1000);
    expect(MockSlotTerminalWebSocket.instances[1].url).toMatch(
      /\/api\/slot-terminal\/ws\?projectId=project-1&requirementId=req-1&pane=codex$/
    );
  });

  it("sends hidden and visible hints for the current terminal and never emits resize", async () => {
    renderPanel();
    expect(await screen.findByText("正在写 slot-3 的 claude")).toBeInTheDocument();
    await waitFor(() => expect(MockSlotTerminalWebSocket.instances).toHaveLength(1));
    const socket = MockSlotTerminalWebSocket.instances[0];
    socket.open();

    setDocumentHidden(true);
    document.dispatchEvent(new Event("visibilitychange"));
    setDocumentHidden(false);
    document.dispatchEvent(new Event("visibilitychange"));

    expect(socket.sentFrames()).toContainEqual({ type: "visibility", state: "hidden" });
    expect(socket.sentFrames()).toContainEqual({ type: "visibility", state: "visible" });
    expect(socket.sentFrames().some((frame) => frame.type === "resize")).toBe(false);
    expect(socket.sentFrames().some((frame) => frame.type === "request_write")).toBe(false);
    expect(socket.sentFrames().some((frame) => frame.type === "release_write")).toBe(false);
  });

  it("falls back to the original guidance when resolver returns 404 or the requirement has no slot", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ message: "missing" }, 404));
    renderPanel();

    expect(await screen.findByText("已绑定 slot-3 · bound")).toBeInTheDocument();
    expect(screen.getByText("终端请在 ccb 原生 sidebar 查看对应 slot 窗口。")).toBeInTheDocument();
    expect(MockSlotTerminalWebSocket.instances).toHaveLength(0);

    vi.mocked(fetch).mockClear();
    renderPanel({ requirementSlot: null });

    expect(await screen.findByText("未绑定 slot")).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });
});

function renderPanel(overrides: Partial<Parameters<typeof SlotTerminalPanel>[0]> = {}) {
  const props: Parameters<typeof SlotTerminalPanel>[0] = {
    projectId: "project-1",
    requirementId: "req-1",
    requirementSlot: { slotId: "slot-3", state: "bound" },
    slotLoading: false,
    slotAction: null,
    webSocketFactory: MockSlotTerminalWebSocket,
    ...overrides
  };
  return render(<SlotTerminalPanel {...props} />);
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json"
    }
  });
}

function setDocumentHidden(hidden: boolean): void {
  Object.defineProperty(document, "hidden", {
    configurable: true,
    value: hidden
  });
}
