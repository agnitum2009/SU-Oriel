import { afterEach, describe, expect, it, vi } from "vitest";

import { buildTerminalDescriptorPath, fetchTerminalDescriptor } from "../../lib/console-api.js";
import { buildTerminalWsUrl, createSlotTerminalClient, type SlotTerminalWebSocketLike } from "../../lib/slot-terminal-ws.js";
import {
  parseSlotTerminalServerFrame,
  SLOT_TERMINAL_CLIENT_FRAME_TYPES,
  type SlotTerminalDescriptor,
  type SlotTerminalFrame,
  type SlotTerminalReadyDescriptor
} from "../../types/slot-terminal.js";
import {
  slotTerminalProtocolFixtureFrames,
  slotTerminalProtocolFixtureSequence
} from "../../types/slot-terminal-fixtures.js";
import {
  SLOT_TERMINAL_FULL_FRAME_CLEAR,
  SlotTerminalFrameRenderer,
  type SlotTerminalWritableTerminal
} from "./SlotTerminalFrameRenderer.js";
import { SLOT_TERMINAL_SCROLLBACK } from "./useXtermTerminal.js";

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
  operations: string[] = [];
  private readonly deferredWrites: boolean;
  private readonly pendingWriteCallbacks: Array<() => void> = [];
  resizes: Array<{ cols: number; rows: number }> = [];
  resetCalls = 0;
  scrollToBottomCalls = 0;
  writes: string[] = [];

  constructor(options: { deferredWrites?: boolean } = {}) {
    this.deferredWrites = options.deferredWrites ?? false;
  }

  reset(): void {
    this.resetCalls += 1;
    this.operations.push("reset");
  }

  resize(cols: number, rows: number): void {
    this.resizes.push({ cols, rows });
    this.operations.push(`resize:${cols}x${rows}`);
  }

  scrollToBottom(): void {
    this.scrollToBottomCalls += 1;
    this.operations.push("scrollToBottom");
  }

  write(data: string, callback?: () => void): void {
    this.writes.push(data);
    this.operations.push(`write:${data}`);
    if (this.deferredWrites) {
      this.pendingWriteCallbacks.push(() => callback?.());
      return;
    }
    callback?.();
  }

  flushNextWrite(): void {
    this.pendingWriteCallbacks.shift()?.();
  }
}

class FakeScrollHost {
  scrollTop = 0;
  clientHeight = 100;
  scrollHeight = 100;
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
  it("accepts pr2/pr3 ready and snapshot/stream/reset frame fixtures", () => {
    expect(parseSlotTerminalServerFrame(JSON.stringify({ type: "ready", descriptor: readyDescriptor }))).toEqual({
      type: "ready",
      descriptor: readyDescriptor
    });
    expect(parseSlotTerminalServerFrame(JSON.stringify({ type: "ready", descriptor: agentGroupReadyDescriptor }))).toEqual({
      type: "ready",
      descriptor: agentGroupReadyDescriptor
    });
    for (const frame of slotTerminalProtocolFixtureSequence) {
      expect(parseSlotTerminalServerFrame(JSON.stringify(frame))).toEqual(frame);
    }
    expect(parseSlotTerminalServerFrame(JSON.stringify({ type: "frame", kind: "unknown", data: "nope" }))).toBeNull();
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

  it("keeps the slot terminal scrollback cap in one adjustable constant", () => {
    expect(SLOT_TERMINAL_SCROLLBACK).toBe(2_500);
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
    expect(terminal.resetCalls).toBe(1);
    expect(terminal.writes).toEqual(["中文", `${SLOT_TERMINAL_FULL_FRAME_CLEAR}中文`]);
    expect(socket.sentFrames().some((frame) => frame.type === "resize")).toBe(false);
    client.close();
  });

  it("dispatches stream and reset frames through websocket callbacks", () => {
    const frames: SlotTerminalFrame[] = [];
    const client = createSlotTerminalClient({
      target: { kind: "requirement", projectId: "project-1", requirementId: "req-1" },
      pane: "claude",
      webSocketFactory: MockSlotTerminalWebSocket,
      callbacks: {
        onFrame: (frame) => frames.push(frame)
      }
    });
    const socket = MockSlotTerminalWebSocket.instances[0];
    socket.open();

    socket.serverSend(slotTerminalProtocolFixtureFrames.streamChunkA);
    socket.serverSend(slotTerminalProtocolFixtureFrames.reset);

    expect(frames).toEqual([
      slotTerminalProtocolFixtureFrames.streamChunkA,
      slotTerminalProtocolFixtureFrames.reset
    ]);
    client.close();
  });

  it("writes same-tick stream chunks in order without RAF coalescing", () => {
    const terminal = new FakeTerminal({ deferredWrites: true });
    const renderer = new SlotTerminalFrameRenderer(terminal);
    const requestAnimationFrame = vi.fn();
    vi.stubGlobal("requestAnimationFrame", requestAnimationFrame);

    renderer.applyFrame(slotTerminalProtocolFixtureFrames.streamChunkA);
    renderer.applyFrame(slotTerminalProtocolFixtureFrames.streamChunkB);

    expect(requestAnimationFrame).not.toHaveBeenCalled();
    expect(terminal.writes).toEqual(["stream-a"]);
    terminal.flushNextWrite();
    expect(terminal.writes).toEqual(["stream-a", "\r\nstream-b"]);
    terminal.flushNextWrite();
  });

  it("resets terminal state before loading reset snapshots with short lines, SGR and wide characters", async () => {
    const terminal = new FakeTerminal();
    const renderer = new SlotTerminalFrameRenderer(terminal);

    renderer.applyFrame({ type: "frame", kind: "stream", data: "\u001b[?1000h\u001b[31mstale" });
    renderer.applyFrame(slotTerminalProtocolFixtureFrames.reset);
    await nextRenderFrame();

    expect(terminal.resetCalls).toBe(1);
    expect(terminal.resizes).toEqual([{ cols: 100, rows: 30 }]);
    expect(terminal.writes).toEqual([
      "\u001b[?1000h\u001b[31mstale",
      "\u001b[31mreset line\u001b[0m\nwide 中文"
    ]);
    expect(terminal.operations).toEqual([
      "write:\u001b[?1000h\u001b[31mstale",
      "scrollToBottom",
      "reset",
      "resize:100x30",
      "write:\u001b[31mreset line\u001b[0m\nwide 中文",
      "scrollToBottom"
    ]);
  });

  it("does not force xterm back to the bottom while the user is scrolled up", async () => {
    const terminal = new FakeTerminal();
    terminal.buffer = { active: { baseY: 12, viewportY: 3 } };
    const renderer = new SlotTerminalFrameRenderer(terminal);

    renderer.applyFrame({ type: "frame", kind: "stream", data: "live" });
    await nextRenderFrame();

    expect(terminal.writes).toEqual(["live"]);
    expect(terminal.scrollToBottomCalls).toBe(0);
    expect(terminal.buffer.active.viewportY).toBe(3);
  });

  it("keeps following live frames when xterm is already at the bottom", async () => {
    const terminal = new FakeTerminal();
    terminal.buffer = { active: { baseY: 12, viewportY: 12 } };
    const renderer = new SlotTerminalFrameRenderer(terminal);

    renderer.applyFrame({ type: "frame", kind: "stream", data: "live" });
    await nextRenderFrame();

    expect(terminal.writes).toEqual(["live"]);
    expect(terminal.scrollToBottomCalls).toBe(1);
  });

  it("follows both xterm and host to the bottom when both are already at the bottom (Opt-1a' host wiring)", async () => {
    const terminal = new FakeTerminal();
    terminal.buffer = { active: { baseY: 12, viewportY: 12 } };
    const host = new FakeScrollHost();
    host.scrollTop = 900;
    host.clientHeight = 100;
    host.scrollHeight = 1000;
    const renderer = new SlotTerminalFrameRenderer(terminal, host as unknown as HTMLElement);

    renderer.applyFrame({ type: "frame", kind: "stream", data: "live" });
    await nextRenderFrame();

    expect(terminal.scrollToBottomCalls).toBe(1);
    expect(host.scrollTop).toBe(host.scrollHeight);
  });

  it("does not follow when the host is scrolled up even though xterm is at the bottom", async () => {
    const terminal = new FakeTerminal();
    terminal.buffer = { active: { baseY: 12, viewportY: 12 } };
    const host = new FakeScrollHost();
    host.scrollTop = 200;
    host.clientHeight = 100;
    host.scrollHeight = 1000;
    const renderer = new SlotTerminalFrameRenderer(terminal, host as unknown as HTMLElement);

    renderer.applyFrame({ type: "frame", kind: "stream", data: "live" });
    await nextRenderFrame();

    expect(terminal.scrollToBottomCalls).toBe(0);
    expect(host.scrollTop).toBe(200);
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
