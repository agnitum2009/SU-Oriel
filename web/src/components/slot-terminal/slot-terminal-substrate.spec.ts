import { afterEach, describe, expect, it, vi } from "vitest";

import { buildTerminalDescriptorPath, fetchTerminalDescriptor } from "../../lib/console-api.js";
import { buildTerminalWsUrl, createSlotTerminalClient, type SlotTerminalWebSocketLike } from "../../lib/slot-terminal-ws.js";
import {
  parseSlotTerminalServerFrame,
  SLOT_TERMINAL_CLIENT_FRAME_TYPES,
  type SlotTerminalDescriptor,
  type SlotTerminalReadyDescriptor
} from "../../types/slot-terminal.js";
import {
  SLOT_TERMINAL_FULL_FRAME_CLEAR,
  SlotTerminalFrameRenderer,
  type SlotTerminalWritableTerminal
} from "./SlotTerminalFrameRenderer.js";

class MockSlotTerminalWebSocket implements SlotTerminalWebSocketLike {
  static instances: MockSlotTerminalWebSocket[] = [];

  readonly url: string;
  readyState = 0;
  sent: string[] = [];
  private readonly listeners = new Map<string, Array<(event: Event | MessageEvent) => void>>();

  constructor(url: string) {
    this.url = url;
    MockSlotTerminalWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
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

class FakeTerminal implements SlotTerminalWritableTerminal {
  buffer?: SlotTerminalWritableTerminal["buffer"];
  resizes: Array<{ cols: number; rows: number }> = [];
  scrollToBottomCalls = 0;
  writes: string[] = [];

  resize(cols: number, rows: number): void {
    this.resizes.push({ cols, rows });
  }

  scrollToBottom(): void {
    this.scrollToBottomCalls += 1;
  }

  write(data: string, callback?: () => void): void {
    this.writes.push(data);
    callback?.();
  }
}

const readyDescriptor: SlotTerminalReadyDescriptor = {
  projectId: "project-1",
  requirementId: "req-1",
  slotId: "slot-2",
  pane: "claude",
  target: "%7",
  source: "slot-terminal",
  readonly: false,
  polling: {
    activeMs: 150,
    idleMs: 1_000,
    hidden: "paused"
  }
};

const agentGroupReadyDescriptor: SlotTerminalReadyDescriptor = {
  projectId: "project-1",
  group: "main",
  slotId: "main",
  pane: "codex",
  target: "%2",
  source: "slot-terminal",
  readonly: false,
  polling: {
    activeMs: 150,
    idleMs: 1_000,
    hidden: "paused"
  }
};

afterEach(() => {
  MockSlotTerminalWebSocket.instances = [];
  vi.unstubAllGlobals();
});

describe("slot-terminal protocol contract", () => {
  it("accepts pr2/pr3 ready and full-frame snapshots", () => {
    expect(parseSlotTerminalServerFrame(JSON.stringify({ type: "ready", descriptor: readyDescriptor }))).toEqual({
      type: "ready",
      descriptor: readyDescriptor
    });
    expect(parseSlotTerminalServerFrame(JSON.stringify({ type: "ready", descriptor: agentGroupReadyDescriptor }))).toEqual({
      type: "ready",
      descriptor: agentGroupReadyDescriptor
    });
    expect(
      parseSlotTerminalServerFrame(
        JSON.stringify({
          type: "frame",
          data: "\u001b[32m中文 frame\u001b[0m\n",
          cols: 4,
          rows: 1,
          generation: 2,
          initial: false
        })
      )
    ).toEqual({
      type: "frame",
      data: "\u001b[32m中文 frame\u001b[0m\n",
      cols: 4,
      rows: 1,
      generation: 2,
      initial: false
    });
  });

  it("keeps forbidden writer/viewport commands out of the client contract", () => {
    expect(SLOT_TERMINAL_CLIENT_FRAME_TYPES).toEqual([
      "visibility",
      "active",
      "hint",
      "viewport",
      "input",
      "paste",
      "ping",
      "close"
    ]);
    expect(SLOT_TERMINAL_CLIENT_FRAME_TYPES).not.toContain("resize");
    expect(SLOT_TERMINAL_CLIENT_FRAME_TYPES).not.toContain("request_write");
    expect(SLOT_TERMINAL_CLIENT_FRAME_TYPES).not.toContain("release_write");
  });
});

describe("slot-terminal mock websocket substrate", () => {
  it("builds requirement and agent-group terminal descriptor and websocket URLs", async () => {
    const descriptor: SlotTerminalDescriptor = {
      slotId: "slot-2",
      sessionName: "ccb-su-ccb-test-session",
      panes: [{ role: "claude", target: "%7", paneIndex: 1 }]
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(descriptor)));
    const requirementTarget = { kind: "requirement" as const, projectId: "project-1", requirementId: "req-1" };
    const agentGroupTarget = { kind: "agentGroup" as const, projectId: "project-1", group: "main" };

    expect(buildTerminalDescriptorPath(requirementTarget)).toBe("/api/projects/project-1/requirements/req-1/slot-terminal");
    await expect(fetchTerminalDescriptor(requirementTarget)).resolves.toEqual(descriptor);
    expect(fetch).toHaveBeenCalledWith("/api/projects/project-1/requirements/req-1/slot-terminal");
    expect(buildTerminalDescriptorPath(agentGroupTarget)).toBe("/api/projects/project-1/agent-terminal/main");
    expect(buildTerminalWsUrl({ target: requirementTarget, pane: "claude" })).toMatch(
      /\/api\/slot-terminal\/ws\?projectId=project-1&requirementId=req-1&pane=claude$/
    );
    expect(buildTerminalWsUrl({ target: agentGroupTarget, pane: "codex" })).toMatch(
      /\/api\/agent-terminal\/ws\?projectId=project-1&group=main&pane=codex$/
    );
  });

  it("renders initial history once and repaints changed-only live frames without trailing newlines", async () => {
    const terminal = new FakeTerminal();
    const renderer = new SlotTerminalFrameRenderer(terminal);
    const client = createSlotTerminalClient({
      target: { kind: "requirement", projectId: "project-1", requirementId: "req-1" },
      pane: "claude",
      webSocketFactory: MockSlotTerminalWebSocket,
      callbacks: {
        onFrame: (frame) => renderer.applyFrame(frame)
      }
    });
    const socket = MockSlotTerminalWebSocket.instances[0];
    socket.open();

    socket.serverSend({ type: "ready", descriptor: readyDescriptor });
    socket.serverSend({ type: "frame", data: "中文\n", cols: 80, rows: 24, generation: 1, initial: true });
    await nextRenderFrame();
    socket.serverSend({ type: "frame", data: "中文\n", cols: 80, rows: 24, generation: 2, initial: false });
    await nextRenderFrame();
    socket.serverSend({ type: "frame", data: "中文\n", cols: 100, rows: 30, generation: 3, initial: false });
    await nextRenderFrame();

    expect(terminal.resizes).toEqual([
      { cols: 80, rows: 24 },
      { cols: 100, rows: 30 }
    ]);
    expect(terminal.writes).toEqual(["中文", `${SLOT_TERMINAL_FULL_FRAME_CLEAR}中文`]);
    expect(socket.sentFrames().some((frame) => frame.type === "resize")).toBe(false);
    client.close();
  });

  it("does not force xterm back to the bottom while the user is scrolled up", async () => {
    const terminal = new FakeTerminal();
    terminal.buffer = { active: { baseY: 12, viewportY: 3 } };
    const renderer = new SlotTerminalFrameRenderer(terminal);

    renderer.applyFrame({ type: "frame", data: "live\n", cols: 80, rows: 24, generation: 2, initial: false });
    await nextRenderFrame();

    expect(terminal.writes).toEqual([`${SLOT_TERMINAL_FULL_FRAME_CLEAR}live`]);
    expect(terminal.scrollToBottomCalls).toBe(0);
  });

  it("keeps following live frames when xterm is already at the bottom", async () => {
    const terminal = new FakeTerminal();
    terminal.buffer = { active: { baseY: 12, viewportY: 12 } };
    const renderer = new SlotTerminalFrameRenderer(terminal);

    renderer.applyFrame({ type: "frame", data: "live\n", cols: 80, rows: 24, generation: 2, initial: false });
    await nextRenderFrame();

    expect(terminal.writes).toEqual([`${SLOT_TERMINAL_FULL_FRAME_CLEAR}live`]);
    expect(terminal.scrollToBottomCalls).toBe(1);
  });

  it("sends visibility and active hints for hidden pause and never sends resize", () => {
    const client = createSlotTerminalClient({
      target: { kind: "requirement", projectId: "project-1", requirementId: "req-1" },
      pane: "codex",
      webSocketFactory: MockSlotTerminalWebSocket
    });
    const socket = MockSlotTerminalWebSocket.instances[0];

    client.sendVisibility("hidden");
    client.sendActive(false);
    client.sendInput("echo ok");
    socket.open();
    client.sendVisibility("visible");
    client.sendActive(true);
    client.ping();

    expect(socket.url).toContain("/api/slot-terminal/ws?");
    expect(socket.sentFrames()).toEqual([
      { type: "visibility", state: "hidden" },
      { type: "active", active: false },
      { type: "input", data: "echo ok" },
      { type: "visibility", state: "visible" },
      { type: "active", active: true },
      { type: "ping" }
    ]);
    expect(socket.sentFrames().some((frame) => frame.type === "resize")).toBe(false);
    expect(socket.sentFrames().some((frame) => frame.type === "request_write")).toBe(false);
    expect(socket.sentFrames().some((frame) => frame.type === "release_write")).toBe(false);
    client.close();
  });
});

async function nextRenderFrame(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json"
    }
  });
}
