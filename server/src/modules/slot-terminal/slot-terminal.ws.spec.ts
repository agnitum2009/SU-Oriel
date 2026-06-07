import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../../app.js";
import {
  SlotTerminalFramePump,
  TmuxSlotTerminalFrameCapture,
  type SlotTerminalFrame,
  type SlotTerminalFrameCaptureBackend
} from "./slot-terminal.frame-stream.js";
import { SlotTerminalTargetForbiddenError } from "./slot-terminal.errors.js";
import {
  SlotTerminalInputAuditWriter,
  TmuxSlotTerminalInputWriter,
  type SlotTerminalInputAuditSink,
  type SlotTerminalInputWriterBackend
} from "./slot-terminal.input.js";
import {
  SLOT_TERMINAL_INPUT_MAX_BYTES,
  SLOT_TERMINAL_STREAM_RECONCILE_INTERVAL_MS,
  evaluateSlotTerminalClientFrame,
  isSlotTerminalOriginAllowed,
  registerSlotTerminalWebSocketRoutes,
  type SlotTerminalWebSocketDependencies
} from "./slot-terminal.ws.js";
import {
  TmuxSlotTerminalStreamBackend,
  type SlotTerminalStreamCallbacks,
  type SlotTerminalStreamChunk,
  type SlotTerminalStreamGapEvent,
  type SlotTerminalStreamModeEvent,
  type SlotTerminalStreamSubscribeInput
} from "./slot-terminal-stream-recorder.js";
import type {
  SlotTerminalBinding,
  SlotTerminalDescriptor,
  SlotTerminalPaneTarget,
  SlotTerminalProject,
  SlotTerminalStore
} from "./slot-terminal.service.js";
import { slotTerminalProtocolFixtureFrames } from "../../../../web/src/types/slot-terminal-fixtures.ts";

const execFileAsync = promisify(execFile);
const ALLOWED_ORIGIN = "http://localhost:5173";
const BLOCKED_ORIGIN = "http://evil.example";

class FakeSlotTerminalStore implements SlotTerminalStore {
  constructor(
    private readonly projects: Map<string, SlotTerminalProject>,
    private readonly requirementProjects: Map<string, string>,
    private readonly bindings: SlotTerminalBinding[]
  ) {}

  async findProject(projectId: string): Promise<SlotTerminalProject | null> {
    return this.projects.get(projectId) ?? null;
  }

  async findProjectIdForRequirement(requirementId: string): Promise<string | null> {
    return this.requirementProjects.get(requirementId) ?? null;
  }

  async findBindingForRequirement(projectId: string, requirementId: string): Promise<SlotTerminalBinding | null> {
    return (
      this.bindings.find((binding) => binding.projectId === projectId && binding.requirementId === requirementId) ?? null
    );
  }
}

function createRouteFixture(options: { projectRoot?: string; panes?: SlotTerminalPaneTarget[] } = {}) {
  const projectId = "project-1";
  const requirementId = "req-1";
  const slotId = "slot-2";
  const agentGroup = "main";
  const projectRoot = options.projectRoot ?? "/repo/SU-CCB";
  const descriptor: SlotTerminalDescriptor = {
    slotId,
    sessionName: "ccb-realtime_translator-a8ae9ed1",
    panes: options.panes ?? [
      { role: "claude", target: "%7", paneIndex: 2 },
      { role: "codex", target: "%8", paneIndex: 3 }
    ]
  };
  const agentGroupDescriptor: SlotTerminalDescriptor = {
    slotId: agentGroup,
    sessionName: "ccb-realtime_translator-a8ae9ed1",
    panes: [
      { role: "claude", target: "%1", paneIndex: 0 },
      { role: "codex", target: "%2", paneIndex: 1 }
    ]
  };
  const store = new FakeSlotTerminalStore(
    new Map([[projectId, { id: projectId, localPath: projectRoot }]]),
    new Map([[requirementId, projectId]]),
    [{ projectId, requirementId, slotId, state: "bound" } as SlotTerminalBinding]
  );
  const service = {
    resolveRequirementTerminal: vi.fn(async () => descriptor),
    assertTargetBelongsTo: vi.fn(
      async (input: { requirementId: string; slotId: string; role: string; target: string }) => {
        const pane = descriptor.panes.find(
          (candidate) =>
            candidate.role === input.role && candidate.target === input.target && descriptor.slotId === input.slotId
        );
        if (!pane || input.requirementId !== requirementId) {
          throw new SlotTerminalTargetForbiddenError("slot terminal target does not belong to role");
        }
        return pane;
      }
    ),
    resolveAgentGroupTerminal: vi.fn(async (input: { projectId: string; group: string }) => {
      if (input.projectId !== projectId || input.group !== agentGroup) {
        throw new SlotTerminalTargetForbiddenError("agent terminal group is not allowed");
      }
      return agentGroupDescriptor;
    }),
    assertTargetBelongsToAgentGroup: vi.fn(
      async (input: { projectId: string; group: string; role: string; target: string }) => {
        const pane = agentGroupDescriptor.panes.find(
          (candidate) =>
            candidate.role === input.role &&
            candidate.target === input.target &&
            input.projectId === projectId &&
            input.group === agentGroup
        );
        if (!pane) {
          throw new SlotTerminalTargetForbiddenError("agent terminal target does not belong to role");
        }
        return pane;
      }
    )
  };

  return {
    projectId,
    requirementId,
    slotId,
    agentGroup,
    projectRoot,
    descriptor,
    agentGroupDescriptor,
    store,
    service
  };
}

function buildCapture(
  framesByTarget: Record<string, string[]>,
  dimensionsByTarget?: Record<string, Array<{ cols: number; rows: number }>>
): SlotTerminalFrameCaptureBackend & {
  calls: Array<{ target: string; socketPath?: string; initial?: boolean }>;
  dimensionCalls: Array<{ target: string; socketPath?: string; initial?: boolean }>;
} {
  const offsets = new Map<string, number>();
  const dimensionOffsets = new Map<string, number>();
  const capture: SlotTerminalFrameCaptureBackend & {
    calls: Array<{ target: string; socketPath?: string; initial?: boolean }>;
    dimensionCalls: Array<{ target: string; socketPath?: string; initial?: boolean }>;
  } = {
    calls: [],
    dimensionCalls: [],
    async capturePane(input) {
      this.calls.push(input);
      const frames = framesByTarget[input.target] ?? [""];
      const offset = offsets.get(input.target) ?? 0;
      offsets.set(input.target, offset + 1);
      return frames[Math.min(offset, frames.length - 1)];
    }
  };
  if (dimensionsByTarget) {
    capture.getPaneDimensions = async (input) => {
      capture.dimensionCalls.push(input);
      const dimensions = dimensionsByTarget[input.target] ?? [{ cols: 80, rows: 24 }];
      const offset = dimensionOffsets.get(input.target) ?? 0;
      dimensionOffsets.set(input.target, offset + 1);
      return dimensions[Math.min(offset, dimensions.length - 1)];
    };
  }
  return capture;
}

class FakeSlotTerminalStreamSubscription {
  readonly id: number;
  cursor: number;
  paused = false;
  released = false;
  private bufferedChunks: SlotTerminalStreamChunk[] = [];
  private gapOnResume: SlotTerminalStreamGapEvent | null = null;

  constructor(
    id: number,
    private readonly callbacks: SlotTerminalStreamCallbacks
  ) {
    this.id = id;
    this.cursor = 1;
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    if (this.released) {
      return;
    }
    const gap = this.gapOnResume;
    this.gapOnResume = null;
    if (gap) {
      this.paused = false;
      this.callbacks.onGap?.(gap);
      return;
    }
    const chunks = this.bufferedChunks;
    this.bufferedChunks = [];
    this.paused = false;
    for (const chunk of chunks) {
      this.callbacks.onChunk?.(chunk);
      this.cursor = (chunk.seq ?? this.cursor) + 1;
    }
  }

  async release(): Promise<void> {
    this.released = true;
  }

  emitChunk(chunk: SlotTerminalStreamChunk): void {
    if (this.released) {
      return;
    }
    if (this.paused) {
      this.bufferedChunks.push(chunk);
      return;
    }
    this.callbacks.onChunk?.(chunk);
    this.cursor = chunk.seq + 1;
  }

  emitMode(event: SlotTerminalStreamModeEvent): void {
    this.callbacks.onMode?.(event);
  }

  emitGap(event: SlotTerminalStreamGapEvent): void {
    this.callbacks.onGap?.(event);
  }

  setGapOnResume(event: SlotTerminalStreamGapEvent): void {
    this.gapOnResume = event;
  }
}

class FakeSlotTerminalStreamRecorder {
  readonly subscriptions: FakeSlotTerminalStreamSubscription[] = [];
  modeOnSubscribe: SlotTerminalStreamModeEvent = { mode: "stream" };
  private nextSubscriptionId = 1;
  private resolveFirstSubscription: ((subscription: FakeSlotTerminalStreamSubscription) => void) | null = null;

  async subscribe(input: SlotTerminalStreamSubscribeInput) {
    const subscription = new FakeSlotTerminalStreamSubscription(
      this.nextSubscriptionId++,
      input.callbacks ?? {}
    );
    this.subscriptions.push(subscription);
    this.resolveFirstSubscription?.(subscription);
    this.resolveFirstSubscription = null;
    input.callbacks?.onMode?.(this.modeOnSubscribe);
    return subscription as never;
  }

  async waitForSubscription(): Promise<FakeSlotTerminalStreamSubscription> {
    const existing = this.subscriptions[0];
    if (existing) {
      return existing;
    }
    return await new Promise((resolve) => {
      this.resolveFirstSubscription = resolve;
    });
  }
}

function buildSlotTerminalWebSocketApp(input: {
  store: SlotTerminalStore;
  service: ReturnType<typeof createRouteFixture>["service"];
  capture: SlotTerminalFrameCaptureBackend;
  inputWriter?: SlotTerminalInputWriterBackend;
  auditSink?: SlotTerminalInputAuditSink;
  streamRecorder?: SlotTerminalWebSocketDependencies["streamRecorder"];
  activeIntervalMs?: number;
  idleIntervalMs?: number;
  allowedOrigins?: string[];
}) {
  const app = Fastify();
  void app.register(websocket);
  void app.register(registerSlotTerminalWebSocketRoutes, {
    store: input.store,
    service: input.service,
    capture: input.capture,
    inputWriter: input.inputWriter,
    auditSink: input.auditSink,
    streamRecorder: input.streamRecorder ?? null,
    activeIntervalMs: input.activeIntervalMs ?? 150,
    idleIntervalMs: input.idleIntervalMs ?? 1_000,
    allowedOrigins: input.allowedOrigins ?? [ALLOWED_ORIGIN]
  });
  return app;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("slot-terminal frame pump", () => {
  it("emits the initial capture and then changed-only frames", async () => {
    vi.useFakeTimers();
    const frames: SlotTerminalFrame[] = [];
    const capture = buildCapture({
      "%7": ["\u001b[32mfirst\u001b[0m\n", "\u001b[32mfirst\u001b[0m\n", "second\n"]
    });
    const pump = new SlotTerminalFramePump({
      capture,
      target: "%7",
      socketPath: "/tmp/tmux.sock",
      activeIntervalMs: 150,
      onFrame: (frame) => frames.push(frame),
      onError: (error) => {
        throw error;
      }
    });

    await pump.start();
    await vi.advanceTimersByTimeAsync(150);
    await vi.advanceTimersByTimeAsync(150);
    pump.stop();

    expect(frames).toEqual([
      {
        data: "\u001b[32mfirst\u001b[0m\n",
        cols: 5,
        rows: 1,
        generation: 1,
        initial: true
      },
      {
        data: "second\n",
        cols: 6,
        rows: 1,
        generation: 2,
        initial: false
      }
    ]);
    expect(capture.calls.map((call) => call.target)).toEqual(["%7", "%7", "%7"]);
  });

  it("pauses while hidden and captures immediately after visibility resumes", async () => {
    vi.useFakeTimers();
    const frames: string[] = [];
    const capture = buildCapture({
      "%7": ["initial\n", "resumed\n"]
    });
    const pump = new SlotTerminalFramePump({
      capture,
      target: "%7",
      activeIntervalMs: 150,
      onFrame: (frame) => frames.push(frame.data),
      onError: (error) => {
        throw error;
      }
    });

    await pump.start();
    await pump.setVisibility("hidden");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(capture.calls).toHaveLength(1);

    await pump.setVisibility("visible");
    pump.stop();

    expect(frames).toEqual(["initial\n", "resumed\n"]);
    expect(capture.calls).toHaveLength(2);
  });

  it("uses idle cadence when the active hint is false", async () => {
    vi.useFakeTimers();
    const capture = buildCapture({
      "%7": ["initial\n", "idle\n"]
    });
    const pump = new SlotTerminalFramePump({
      capture,
      target: "%7",
      activeIntervalMs: 100,
      idleIntervalMs: 800,
      onFrame: () => undefined,
      onError: (error) => {
        throw error;
      }
    });

    await pump.start();
    await pump.setActive(false);
    await vi.advanceTimersByTimeAsync(799);
    expect(capture.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    pump.stop();

    expect(capture.calls).toHaveLength(3);
  });

  it("uses pane dimensions from the capture backend instead of inferring CJK text width", async () => {
    const frames: SlotTerminalFrame[] = [];
    const capture: SlotTerminalFrameCaptureBackend = {
      capturePane: vi.fn(async () => "中文\n"),
      getPaneDimensions: vi.fn(async () => ({ cols: 80, rows: 24 }))
    };
    const pump = new SlotTerminalFramePump({
      capture,
      target: "%7",
      socketPath: "/tmp/tmux.sock",
      onFrame: (frame) => frames.push(frame),
      onError: (error) => {
        throw error;
      }
    });

    await pump.start();
    pump.stop();

    expect(frames).toEqual([
      {
        data: "中文\n",
        cols: 80,
        rows: 24,
        generation: 1,
        initial: true
      }
    ]);
    expect(capture.getPaneDimensions).toHaveBeenCalledWith({
      target: "%7",
      socketPath: "/tmp/tmux.sock"
    });
  });
});

describe("slot-terminal websocket", () => {
  it("buildApp mounts slot-terminal websocket and rejects disallowed origins before pane resolution", async () => {
    const app = buildApp({
      enableFileWatcher: false,
      fileWatcherService: null,
      startupProjectScan: null
    });

    try {
      await app.ready();
      let resolveMessages!: (messages: Array<Record<string, unknown>>) => void;
      let rejectMessages!: (error: unknown) => void;
      const messagesPromise = new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
        resolveMessages = resolve;
        rejectMessages = reject;
      });
      const socket = await app.injectWS(
        "/api/slot-terminal/ws?projectId=project-1&requirementId=req-1&pane=claude",
        webSocketRequest(BLOCKED_ORIGIN),
        {
          onInit(ws) {
            collectWebSocketMessages(ws, 1).then(resolveMessages, rejectMessages);
          }
        }
      );
      const [error] = await messagesPromise;

      expect(error).toMatchObject({
        type: "error",
        code: "FORBIDDEN",
        message: "websocket origin is not allowed"
      });
      socket.terminate();
    } finally {
      await app.close();
    }
  });

  it("rejects disallowed or missing origins and accepts the configured allowlist", async () => {
    expect(isSlotTerminalOriginAllowed(ALLOWED_ORIGIN, [ALLOWED_ORIGIN])).toBe(true);
    expect(isSlotTerminalOriginAllowed(BLOCKED_ORIGIN, [ALLOWED_ORIGIN])).toBe(false);
    expect(isSlotTerminalOriginAllowed(undefined, [ALLOWED_ORIGIN])).toBe(false);

    const fixture = createRouteFixture();
    const capture = buildCapture({ "%7": ["claude frame\n"] });
    const app = buildSlotTerminalWebSocketApp({
      store: fixture.store,
      service: fixture.service,
      capture
    });

    try {
      await app.ready();
      let resolveMessages!: (messages: Array<Record<string, unknown>>) => void;
      let rejectMessages!: (error: unknown) => void;
      const messagesPromise = new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
        resolveMessages = resolve;
        rejectMessages = reject;
      });
      const socket = await app.injectWS(
        `/api/slot-terminal/ws?projectId=${fixture.projectId}&requirementId=${fixture.requirementId}&pane=claude`,
        webSocketRequest(BLOCKED_ORIGIN),
        {
          onInit(ws) {
            collectWebSocketMessages(ws, 1).then(resolveMessages, rejectMessages);
          }
        }
      );
      const [error] = await messagesPromise;

      expect(error).toMatchObject({
        type: "error",
        code: "FORBIDDEN",
        message: "websocket origin is not allowed"
      });
      expect(fixture.service.resolveRequirementTerminal).not.toHaveBeenCalled();
      expect(fixture.service.assertTargetBelongsTo).not.toHaveBeenCalled();
      expect(capture.calls).toHaveLength(0);
      socket.terminate();
    } finally {
      await app.close();
    }
  });

  it("rejects cross-project, cross-slot, and cross-pane read subscriptions before capture", async () => {
    const crossProject = createRouteFixture();
    crossProject.service.resolveRequirementTerminal.mockImplementation(async (input: { projectId: string }) => {
      if (input.projectId !== crossProject.projectId) {
        throw new SlotTerminalTargetForbiddenError("slot terminal target does not belong to requirement");
      }
      return crossProject.descriptor;
    });
    const crossProjectCapture = buildCapture({ "%7": ["must not capture\n"] });
    const crossProjectApp = buildSlotTerminalWebSocketApp({
      store: crossProject.store,
      service: crossProject.service,
      capture: crossProjectCapture
    });

    try {
      await crossProjectApp.ready();
      const [error] = await collectRejectedInjectedMessages(
        crossProjectApp,
        `/api/slot-terminal/ws?projectId=project-2&requirementId=${crossProject.requirementId}&pane=claude`
      );
      expect(error).toMatchObject({
        type: "error",
        code: "FORBIDDEN",
        message: "slot terminal target does not belong to requirement"
      });
      expect(crossProject.service.assertTargetBelongsTo).not.toHaveBeenCalled();
      expect(crossProjectCapture.calls).toHaveLength(0);
    } finally {
      await crossProjectApp.close();
    }

    const crossSlot = createRouteFixture();
    crossSlot.service.assertTargetBelongsTo.mockRejectedValue(
      new SlotTerminalTargetForbiddenError("slot terminal target does not belong to slot")
    );
    const crossSlotCapture = buildCapture({ "%7": ["must not capture\n"] });
    const crossSlotApp = buildSlotTerminalWebSocketApp({
      store: crossSlot.store,
      service: crossSlot.service,
      capture: crossSlotCapture
    });

    try {
      await crossSlotApp.ready();
      const [error] = await collectRejectedInjectedMessages(
        crossSlotApp,
        `/api/slot-terminal/ws?projectId=${crossSlot.projectId}&requirementId=${crossSlot.requirementId}&pane=claude`
      );
      expect(error).toMatchObject({
        type: "error",
        code: "FORBIDDEN",
        message: "slot terminal target does not belong to slot"
      });
      expect(crossSlotCapture.calls).toHaveLength(0);
    } finally {
      await crossSlotApp.close();
    }

    const crossPane = createRouteFixture();
    crossPane.service.assertTargetBelongsTo.mockRejectedValue(
      new SlotTerminalTargetForbiddenError("slot terminal target does not belong to role")
    );
    const crossPaneCapture = buildCapture({ "%8": ["must not capture\n"] });
    const crossPaneApp = buildSlotTerminalWebSocketApp({
      store: crossPane.store,
      service: crossPane.service,
      capture: crossPaneCapture
    });

    try {
      await crossPaneApp.ready();
      const [error] = await collectRejectedInjectedMessages(
        crossPaneApp,
        `/api/slot-terminal/ws?projectId=${crossPane.projectId}&requirementId=${crossPane.requirementId}&pane=codex`
      );
      expect(error).toMatchObject({
        type: "error",
        code: "FORBIDDEN",
        message: "slot terminal target does not belong to role"
      });
      expect(crossPaneCapture.calls).toHaveLength(0);
    } finally {
      await crossPaneApp.close();
    }
  });

  it("sends ready and an initial frame after the target guard passes", async () => {
    const fixture = createRouteFixture();
    const capture = buildCapture({ "%7": ["claude frame\n"] });
    const app = buildSlotTerminalWebSocketApp({
      store: fixture.store,
      service: fixture.service,
      capture
    });

    try {
      await app.ready();
      let resolveMessages!: (messages: Array<Record<string, unknown>>) => void;
      let rejectMessages!: (error: unknown) => void;
      const messagesPromise = new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
        resolveMessages = resolve;
        rejectMessages = reject;
      });
      const socket = await app.injectWS(
        `/api/slot-terminal/ws?projectId=${fixture.projectId}&requirementId=${fixture.requirementId}&pane=claude`,
        webSocketRequest(),
        {
          onInit(ws) {
            collectWebSocketMessages(ws, 2).then(resolveMessages, rejectMessages);
          }
        }
      );
      const messages = await messagesPromise;

      assert.deepEqual(messages.map((message) => message.type), ["ready", "frame"]);
      assert.deepEqual(messages[0].descriptor, {
        projectId: fixture.projectId,
        requirementId: fixture.requirementId,
        slotId: fixture.slotId,
        pane: "claude",
        target: "%7",
        source: "slot-terminal",
        readonly: false,
        polling: {
          activeMs: 150,
          idleMs: 1_000,
          hidden: "paused"
        }
      });
      assert.deepEqual(messages[1], {
        type: "frame",
        data: "claude frame\n",
        cols: 12,
        rows: 1,
        generation: 1,
        initial: true
      });
      expect(fixture.service.assertTargetBelongsTo).toHaveBeenCalledWith({
        requirementId: fixture.requirementId,
        slotId: fixture.slotId,
        role: "claude",
        target: "%7"
      });
      expect(capture.calls).toEqual([
        {
          target: "%7",
          socketPath: join(fixture.projectRoot, ".ccb", "ccbd", "tmux.sock"),
          initial: true
        }
      ]);
      socket.terminate();
    } finally {
      await app.close();
    }
  });

  it("subscribes to stream mode before initial capture and flushes buffered chunks after the snapshot seam", async () => {
    const fixture = createRouteFixture();
    const streamRecorder = new FakeSlotTerminalStreamRecorder();
    let releaseInitialCapture!: () => void;
    const initialCaptureGate = new Promise<void>((resolve) => {
      releaseInitialCapture = resolve;
    });
    const capture: SlotTerminalFrameCaptureBackend & {
      calls: Array<{ target: string; socketPath?: string; initial?: boolean }>;
    } = {
      calls: [],
      async capturePane(input) {
        this.calls.push(input);
        await initialCaptureGate;
        return "initial snapshot\n";
      },
      async getPaneDimensions() {
        return { cols: 80, rows: 24 };
      }
    };
    const app = buildSlotTerminalWebSocketApp({
      store: fixture.store,
      service: fixture.service,
      capture,
      streamRecorder
    });

    try {
      await app.ready();
      let socket: { send: (data: string) => void; terminate: () => void } | null = null;
      const messagesPromise = new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
        void app
          .injectWS(
            `/api/slot-terminal/ws?projectId=${fixture.projectId}&requirementId=${fixture.requirementId}&pane=claude`,
            webSocketRequest(),
            {
              onInit(ws) {
                socket = ws;
                collectWebSocketMessages(ws, 3).then(resolve, reject);
              }
            }
          )
          .catch(reject);
      });
      const subscription = await streamRecorder.waitForSubscription();
      subscription.emitChunk(slotTerminalProtocolFixtureFrames.streamChunkA);
      releaseInitialCapture();
      const messages = await messagesPromise;

      expect(messages.map((message) => message.type)).toEqual(["ready", "frame", "frame"]);
      expect(messages[1]).toMatchObject({
        type: "frame",
        data: "initial snapshot\n",
        cols: 80,
        rows: 24,
        generation: 1,
        initial: true,
        mode: "stream"
      });
      expect(messages[2]).toEqual(slotTerminalProtocolFixtureFrames.streamChunkA);
      expect(capture.calls).toEqual([
        {
          target: "%7",
          socketPath: join(fixture.projectRoot, ".ccb", "ccbd", "tmux.sock"),
          initial: true
        }
      ]);
      socket?.terminate();
    } finally {
      await app.close();
    }
  });

  it("pauses stream subscriptions while hidden and replays buffered chunks on visible", async () => {
    const fixture = createRouteFixture();
    const streamRecorder = new FakeSlotTerminalStreamRecorder();
    const capture = buildCapture(
      { "%7": ["initial snapshot\n"] },
      { "%7": [{ cols: 80, rows: 24 }, { cols: 80, rows: 24 }, { cols: 80, rows: 24 }] }
    );
    const app = buildSlotTerminalWebSocketApp({
      store: fixture.store,
      service: fixture.service,
      capture,
      streamRecorder
    });

    try {
      await app.ready();
      const { socket } = await collectInjectedMessages(
        app,
        `/api/slot-terminal/ws?projectId=${fixture.projectId}&requirementId=${fixture.requirementId}&pane=claude`,
        2
      );
      const subscription = await streamRecorder.waitForSubscription();

      socket.send(JSON.stringify({ type: "visibility", state: "hidden" }));
      await waitForCondition(() => subscription.paused, "stream subscription was not paused");
      expect(subscription.paused).toBe(true);
      subscription.emitChunk({ kind: "stream", mode: "stream", seq: 1, data: "hidden-a" });
      subscription.emitChunk({ kind: "stream", mode: "stream", seq: 2, data: "hidden-b" });

      const replayPromise = collectWebSocketMessages(socket, 2);
      socket.send(JSON.stringify({ type: "visibility", state: "visible" }));
      const replay = await replayPromise;

      expect(subscription.paused).toBe(false);
      expect(replay).toEqual([
        { type: "frame", kind: "stream", data: "hidden-a", seq: 1, mode: "stream" },
        { type: "frame", kind: "stream", data: "hidden-b", seq: 2, mode: "stream" }
      ]);
      socket.terminate();
    } finally {
      await app.close();
    }
  });

  it("turns hidden resume ring gaps into reset frames with a deep snapshot", async () => {
    const fixture = createRouteFixture();
    const streamRecorder = new FakeSlotTerminalStreamRecorder();
    const capture = buildCapture(
      { "%7": ["initial snapshot\n", "reset snapshot\n"] },
      { "%7": [{ cols: 80, rows: 24 }, { cols: 80, rows: 24 }] }
    );
    const app = buildSlotTerminalWebSocketApp({
      store: fixture.store,
      service: fixture.service,
      capture,
      streamRecorder
    });

    try {
      await app.ready();
      const { socket } = await collectInjectedMessages(
        app,
        `/api/slot-terminal/ws?projectId=${fixture.projectId}&requirementId=${fixture.requirementId}&pane=claude`,
        2
      );
      const subscription = await streamRecorder.waitForSubscription();
      socket.send(JSON.stringify({ type: "visibility", state: "hidden" }));
      await waitForCondition(() => subscription.paused, "stream subscription was not paused");
      expect(subscription.paused).toBe(true);
      subscription.setGapOnResume({
        reason: "ring-gap",
        fromSeq: 1,
        nextSeq: 20,
        message: "slot terminal stream ring no longer contains the requested cursor"
      });
      const resetPromise = collectWebSocketMessages(socket, 1);

      socket.send(JSON.stringify({ type: "visibility", state: "visible" }));
      const [reset] = await resetPromise;

      expect(reset).toMatchObject({
        type: "frame",
        kind: "reset",
        reason: "gap",
        data: "reset snapshot\n",
        cols: 80,
        rows: 24,
        generation: 2,
        initial: true,
        mode: "stream"
      });
      socket.terminate();
    } finally {
      await app.close();
    }
  });

  it("resets from a deep snapshot when pane dimensions change during stream mode", async () => {
    const fixture = createRouteFixture();
    const streamRecorder = new FakeSlotTerminalStreamRecorder();
    const capture = buildCapture(
      { "%7": ["initial snapshot\n", "resized snapshot\n"] },
      { "%7": [{ cols: 80, rows: 24 }, { cols: 100, rows: 30 }, { cols: 100, rows: 30 }] }
    );
    const app = buildSlotTerminalWebSocketApp({
      store: fixture.store,
      service: fixture.service,
      capture,
      streamRecorder
    });

    try {
      await app.ready();
      const { socket } = await collectInjectedMessages(
        app,
        `/api/slot-terminal/ws?projectId=${fixture.projectId}&requirementId=${fixture.requirementId}&pane=claude`,
        2
      );
      const subscription = await streamRecorder.waitForSubscription();
      const resetPromise = collectWebSocketMessages(socket, 1);

      subscription.emitChunk({ kind: "stream", mode: "stream", seq: 1, data: "after resize" });
      const [reset] = await resetPromise;

      expect(reset).toMatchObject({
        type: "frame",
        kind: "reset",
        reason: "resize",
        data: "resized snapshot\n",
        cols: 100,
        rows: 30,
        generation: 2,
        initial: true,
        mode: "stream"
      });
      socket.terminate();
    } finally {
      await app.close();
    }
  });

  it("reconciles stream mode when the sent history tail diverges from tmux capture", async () => {
    vi.useFakeTimers();
    const fixture = createRouteFixture();
    const streamRecorder = new FakeSlotTerminalStreamRecorder();
    const capture = buildCapture(
      { "%7": ["initial-a\n", "tmux-a\ntmux-b\n", "tmux-a\ntmux-b\n"] },
      { "%7": [{ cols: 80, rows: 24 }, { cols: 80, rows: 24 }, { cols: 80, rows: 24 }] }
    );
    const app = buildSlotTerminalWebSocketApp({
      store: fixture.store,
      service: fixture.service,
      capture,
      streamRecorder
    });

    try {
      await app.ready();
      const { socket } = await collectInjectedMessages(
        app,
        `/api/slot-terminal/ws?projectId=${fixture.projectId}&requirementId=${fixture.requirementId}&pane=claude`,
        2
      );
      const subscription = await streamRecorder.waitForSubscription();
      const streamPromise = collectWebSocketMessages(socket, 1);
      subscription.emitChunk({ kind: "stream", mode: "stream", seq: 1, data: "client-missing\n" });
      await streamPromise;

      const resetPromise = collectWebSocketMessages(socket, 1, SLOT_TERMINAL_STREAM_RECONCILE_INTERVAL_MS + 2_000);
      await vi.advanceTimersByTimeAsync(SLOT_TERMINAL_STREAM_RECONCILE_INTERVAL_MS);
      const [reset] = await resetPromise;

      expect(reset).toMatchObject({
        type: "frame",
        kind: "reset",
        reason: "reconcile",
        data: "tmux-a\ntmux-b\n",
        cols: 80,
        rows: 24,
        initial: true,
        mode: "stream"
      });
      socket.terminate();
    } finally {
      await app.close();
    }
  });

  it("keeps stream mode when reconcile capture matches the sent history tail", async () => {
    vi.useFakeTimers();
    const fixture = createRouteFixture();
    const streamRecorder = new FakeSlotTerminalStreamRecorder();
    const capture = buildCapture(
      { "%7": ["line-a\n", "line-a\nline-b\n"] },
      { "%7": [{ cols: 80, rows: 24 }, { cols: 80, rows: 24 }] }
    );
    const app = buildSlotTerminalWebSocketApp({
      store: fixture.store,
      service: fixture.service,
      capture,
      streamRecorder
    });

    try {
      await app.ready();
      const { socket } = await collectInjectedMessages(
        app,
        `/api/slot-terminal/ws?projectId=${fixture.projectId}&requirementId=${fixture.requirementId}&pane=claude`,
        2
      );
      const subscription = await streamRecorder.waitForSubscription();
      const streamPromise = collectWebSocketMessages(socket, 1);
      subscription.emitChunk({ kind: "stream", mode: "stream", seq: 1, data: "line-b\n" });
      await streamPromise;

      await vi.advanceTimersByTimeAsync(SLOT_TERMINAL_STREAM_RECONCILE_INTERVAL_MS);
      await Promise.resolve();

      expect(capture.calls).toEqual([
        {
          target: "%7",
          socketPath: join(fixture.projectRoot, ".ccb", "ccbd", "tmux.sock"),
          initial: true
        },
        {
          target: "%7",
          socketPath: join(fixture.projectRoot, ".ccb", "ccbd", "tmux.sock"),
          initial: true
        }
      ]);
      socket.terminate();
    } finally {
      await app.close();
    }
  });

  it("falls back to snapshot polling with mode metadata when the recorder is degraded", async () => {
    const fixture = createRouteFixture();
    const streamRecorder = new FakeSlotTerminalStreamRecorder();
    streamRecorder.modeOnSubscribe = {
      mode: "snapshot-fallback",
      reason: "pane-pipe-occupied",
      message: "tmux pane pipe is already occupied"
    };
    const capture = buildCapture({ "%7": ["fallback snapshot\n"] });
    const app = buildSlotTerminalWebSocketApp({
      store: fixture.store,
      service: fixture.service,
      capture,
      streamRecorder
    });

    try {
      await app.ready();
      const { socket, messages } = await collectInjectedMessages(
        app,
        `/api/slot-terminal/ws?projectId=${fixture.projectId}&requirementId=${fixture.requirementId}&pane=claude`,
        2
      );

      expect(messages[1]).toMatchObject({
        type: "frame",
        data: "fallback snapshot\n",
        generation: 1,
        initial: true,
        mode: "snapshot-fallback"
      });
      expect(capture.calls).toHaveLength(1);
      socket.terminate();
    } finally {
      await app.close();
    }
  });

  it("re-runs the stream seam when an initial snapshot fallback upgrades to stream mode", async () => {
    const fixture = createRouteFixture();
    const streamRecorder = new FakeSlotTerminalStreamRecorder();
    streamRecorder.modeOnSubscribe = {
      mode: "snapshot-fallback",
      reason: "pane-pipe-occupied",
      message: "tmux pane pipe is already occupied"
    };
    const capture = buildCapture(
      { "%7": ["fallback snapshot\n", "upgrade reset snapshot\n"] },
      { "%7": [{ cols: 80, rows: 24 }, { cols: 80, rows: 24 }] }
    );
    const app = buildSlotTerminalWebSocketApp({
      store: fixture.store,
      service: fixture.service,
      capture,
      streamRecorder,
      activeIntervalMs: 10_000
    });

    try {
      await app.ready();
      const { socket, messages } = await collectInjectedMessages(
        app,
        `/api/slot-terminal/ws?projectId=${fixture.projectId}&requirementId=${fixture.requirementId}&pane=claude`,
        2
      );
      const subscription = await streamRecorder.waitForSubscription();

      expect(messages[1]).toMatchObject({
        type: "frame",
        data: "fallback snapshot\n",
        generation: 1,
        initial: true,
        mode: "snapshot-fallback"
      });

      const upgradeMessagesPromise = collectWebSocketMessages(socket, 2);
      subscription.emitMode({ mode: "stream" });
      subscription.emitChunk({ kind: "stream", mode: "stream", seq: 9, data: "post-upgrade" });
      const upgradeMessages = await upgradeMessagesPromise;

      expect(upgradeMessages).toEqual([
        {
          type: "frame",
          kind: "reset",
          reason: "reconcile",
          data: "upgrade reset snapshot\n",
          cols: 80,
          rows: 24,
          generation: 2,
          initial: true,
          mode: "stream"
        },
        {
          type: "frame",
          kind: "stream",
          data: "post-upgrade",
          seq: 9,
          mode: "stream"
        }
      ]);
      expect(capture.calls).toEqual([
        {
          target: "%7",
          socketPath: join(fixture.projectRoot, ".ccb", "ccbd", "tmux.sock"),
          initial: true
        },
        {
          target: "%7",
          socketPath: join(fixture.projectRoot, ".ccb", "ccbd", "tmux.sock"),
          initial: true
        }
      ]);
      socket.terminate();
    } finally {
      await app.close();
    }
  });

  it("serves agent-terminal ready, frames, input, and per-write guard through the shared core", async () => {
    const fixture = createRouteFixture();
    const capture = buildCapture({ "%1": ["main claude frame\n"] });
    let resolveAudit!: () => void;
    const auditPromise = new Promise<void>((resolve) => {
      resolveAudit = resolve;
    });
    const inputWriter: SlotTerminalInputWriterBackend = {
      sendInput: vi.fn(async () => ({ commandCount: 1, bytes: 5 }))
    };
    const auditSink: SlotTerminalInputAuditSink = {
      recordInput: vi.fn(async () => {
        resolveAudit();
      })
    };
    const app = buildSlotTerminalWebSocketApp({
      store: fixture.store,
      service: fixture.service,
      capture,
      inputWriter,
      auditSink
    });

    try {
      await app.ready();
      const { socket, messages } = await collectInjectedMessages(
        app,
        `/api/agent-terminal/ws?projectId=${fixture.projectId}&group=${fixture.agentGroup}&pane=claude`,
        2
      );

      assert.deepEqual(messages.map((message) => message.type), ["ready", "frame"]);
      assert.deepEqual(messages[0].descriptor, {
        projectId: fixture.projectId,
        group: fixture.agentGroup,
        slotId: fixture.agentGroup,
        pane: "claude",
        target: "%1",
        source: "slot-terminal",
        readonly: false,
        polling: {
          activeMs: 150,
          idleMs: 1_000,
          hidden: "paused"
        }
      });
      assert.deepEqual(messages[1], {
        type: "frame",
        data: "main claude frame\n",
        cols: 17,
        rows: 1,
        generation: 1,
        initial: true
      });
      expect(fixture.service.resolveAgentGroupTerminal).toHaveBeenCalledWith({
        projectId: fixture.projectId,
        group: fixture.agentGroup
      });
      expect(fixture.service.assertTargetBelongsToAgentGroup).toHaveBeenCalledWith({
        projectId: fixture.projectId,
        group: fixture.agentGroup,
        role: "claude",
        target: "%1"
      });
      expect(fixture.service.assertTargetBelongsTo).not.toHaveBeenCalled();
      expect(capture.calls).toEqual([
        {
          target: "%1",
          socketPath: join(fixture.projectRoot, ".ccb", "ccbd", "tmux.sock"),
          initial: true
        }
      ]);

      socket.send(JSON.stringify({ type: "input", data: "main\r" }));
      await auditPromise;

      expect(fixture.service.assertTargetBelongsToAgentGroup).toHaveBeenCalledTimes(2);
      expect(fixture.service.assertTargetBelongsToAgentGroup).toHaveBeenLastCalledWith({
        projectId: fixture.projectId,
        group: fixture.agentGroup,
        role: "claude",
        target: "%1"
      });
      expect(inputWriter.sendInput).toHaveBeenCalledWith({
        target: "%1",
        socketPath: join(fixture.projectRoot, ".ccb", "ccbd", "tmux.sock"),
        data: "main\r"
      });
      expect(auditSink.recordInput).toHaveBeenCalledWith({
        projectId: fixture.projectId,
        contextKind: "agent-group",
        contextId: fixture.agentGroup,
        slotId: fixture.agentGroup,
        pane: "claude",
        target: "%1",
        remoteAddr: "127.0.0.1",
        data: "main\r",
        commandCount: 1,
        outcome: "accepted"
      });
      socket.terminate();
    } finally {
      await app.close();
    }
  });

  it("rejects disallowed origins on agent-terminal before pane resolution", async () => {
    const fixture = createRouteFixture();
    const capture = buildCapture({ "%1": ["must not capture\n"] });
    const app = buildSlotTerminalWebSocketApp({
      store: fixture.store,
      service: fixture.service,
      capture
    });

    try {
      await app.ready();
      let resolveMessages!: (messages: Array<Record<string, unknown>>) => void;
      let rejectMessages!: (error: unknown) => void;
      const messagesPromise = new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
        resolveMessages = resolve;
        rejectMessages = reject;
      });
      const socket = await app.injectWS(
        `/api/agent-terminal/ws?projectId=${fixture.projectId}&group=${fixture.agentGroup}&pane=claude`,
        webSocketRequest(BLOCKED_ORIGIN),
        {
          onInit(ws) {
            collectWebSocketMessages(ws, 1).then(resolveMessages, rejectMessages);
          }
        }
      );
      const [error] = await messagesPromise;

      expect(error).toMatchObject({
        type: "error",
        code: "FORBIDDEN",
        message: "websocket origin is not allowed"
      });
      expect(fixture.service.resolveAgentGroupTerminal).not.toHaveBeenCalled();
      expect(fixture.service.assertTargetBelongsToAgentGroup).not.toHaveBeenCalled();
      expect(capture.calls).toHaveLength(0);
      socket.terminate();
    } finally {
      await app.close();
    }
  });

  it("rejects agent-terminal resize and write-lease control messages", async () => {
    const fixture = createRouteFixture();
    const capture = buildCapture({ "%1": ["main claude frame\n"] });
    const inputWriter: SlotTerminalInputWriterBackend = {
      sendInput: vi.fn(async () => ({ commandCount: 1, bytes: 1 }))
    };
    const app = buildSlotTerminalWebSocketApp({
      store: fixture.store,
      service: fixture.service,
      capture,
      inputWriter
    });

    try {
      await app.ready();
      const { socket } = await collectInjectedMessages(
        app,
        `/api/agent-terminal/ws?projectId=${fixture.projectId}&group=${fixture.agentGroup}&pane=claude`,
        2
      );
      const errorsPromise = collectWebSocketMessages(socket, 3);

      socket.send(JSON.stringify({ type: "resize", cols: 200, rows: 50 }));
      socket.send(JSON.stringify({ type: "request_write" }));
      socket.send(JSON.stringify({ type: "release_write" }));
      const errors = await errorsPromise;

      expect(errors).toEqual([
        {
          type: "error",
          code: "READ_ONLY",
          message: "slot terminal websocket is read-only"
        },
        {
          type: "error",
          code: "READ_ONLY",
          message: "slot terminal websocket is read-only"
        },
        {
          type: "error",
          code: "READ_ONLY",
          message: "slot terminal websocket is read-only"
        }
      ]);
      expect(inputWriter.sendInput).not.toHaveBeenCalled();
      expect(fixture.service.assertTargetBelongsToAgentGroup).toHaveBeenCalledTimes(1);
      socket.terminate();
    } finally {
      await app.close();
    }
  });

  it("rejects forbidden agent-terminal input revalidation without sending keys", async () => {
    const fixture = createRouteFixture();
    const capture = buildCapture({ "%1": ["main claude frame\n"] });
    let guardCalls = 0;
    fixture.service.assertTargetBelongsToAgentGroup.mockImplementation(
      async (input: { projectId: string; group: string; role: string; target: string }) => {
        guardCalls += 1;
        if (guardCalls === 1) {
          return { role: "claude", target: input.target, paneIndex: 0 };
        }
        throw new SlotTerminalTargetForbiddenError("agent terminal target does not belong to role");
      }
    );
    const inputWriter: SlotTerminalInputWriterBackend = {
      sendInput: vi.fn(async () => ({ commandCount: 1, bytes: 1 }))
    };
    const auditSink: SlotTerminalInputAuditSink = {
      recordInput: vi.fn()
    };
    const app = buildSlotTerminalWebSocketApp({
      store: fixture.store,
      service: fixture.service,
      capture,
      inputWriter,
      auditSink
    });

    try {
      await app.ready();
      const { socket } = await collectInjectedMessages(
        app,
        `/api/agent-terminal/ws?projectId=${fixture.projectId}&group=${fixture.agentGroup}&pane=claude`,
        2
      );
      const errorPromise = collectWebSocketMessages(socket, 1);

      socket.send(JSON.stringify({ type: "input", data: "x" }));
      const [error] = await errorPromise;

      expect(error).toMatchObject({
        type: "error",
        code: "FORBIDDEN",
        message: "agent terminal target does not belong to role"
      });
      expect(fixture.service.assertTargetBelongsToAgentGroup).toHaveBeenCalledTimes(2);
      expect(inputWriter.sendInput).not.toHaveBeenCalled();
      expect(auditSink.recordInput).toHaveBeenCalledWith({
        projectId: fixture.projectId,
        contextKind: "agent-group",
        contextId: fixture.agentGroup,
        slotId: fixture.agentGroup,
        pane: "claude",
        target: "%1",
        remoteAddr: "127.0.0.1",
        data: "x",
        commandCount: 0,
        outcome: "forbidden",
        rejectionCode: "FORBIDDEN",
        rejectionReason: "agent terminal target does not belong to role"
      });
      socket.terminate();
    } finally {
      await app.close();
    }
  });

  it("applies visibility hints received before ready before starting capture", async () => {
    const fixture = createRouteFixture();
    let resolveDescriptor!: (descriptor: SlotTerminalDescriptor) => void;
    const descriptorPromise = new Promise<SlotTerminalDescriptor>((resolve) => {
      resolveDescriptor = resolve;
    });
    fixture.service.resolveRequirementTerminal.mockImplementation(async () => await descriptorPromise);
    const capture = buildCapture({ "%7": ["hidden-resumed\n"] });
    const app = buildSlotTerminalWebSocketApp({
      store: fixture.store,
      service: fixture.service,
      capture,
      activeIntervalMs: 20
    });

    try {
      await app.ready();
      let resolveReady!: (messages: Array<Record<string, unknown>>) => void;
      let rejectReady!: (error: unknown) => void;
      const readyPromise = new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
      });
      const socket = await app.injectWS(
        `/api/slot-terminal/ws?projectId=${fixture.projectId}&requirementId=${fixture.requirementId}&pane=claude`,
        webSocketRequest(),
        {
          onInit(ws) {
            collectWebSocketMessages(ws, 1).then(resolveReady, rejectReady);
          }
        }
      );

      socket.send(JSON.stringify({ type: "visibility", state: "hidden" }));
      await sleep(20);
      resolveDescriptor(fixture.descriptor);
      const [ready] = await readyPromise;
      expect(ready.type).toBe("ready");
      await sleep(80);
      expect(capture.calls).toHaveLength(0);

      const framePromise = collectWebSocketMessages(socket, 1);
      socket.send(JSON.stringify({ type: "visibility", state: "visible" }));
      const [frame] = await framePromise;

      expect(frame).toMatchObject({
        type: "frame",
        data: "hidden-resumed\n",
        generation: 1,
        initial: true
      });
      expect(capture.calls).toHaveLength(1);
      socket.terminate();
    } finally {
      await app.close();
    }
  });

  it("keeps claude and codex subscriptions independent", async () => {
    const fixture = createRouteFixture();
    const capture = buildCapture({
      "%7": ["claude initial\n"],
      "%8": ["codex initial\n"]
    });
    const app = buildSlotTerminalWebSocketApp({
      store: fixture.store,
      service: fixture.service,
      capture
    });

    try {
      await app.ready();
      const claudeMessages = collectInjectedMessages(
        app,
        `/api/slot-terminal/ws?projectId=${fixture.projectId}&requirementId=${fixture.requirementId}&pane=claude`,
        2
      );
      const codexMessages = collectInjectedMessages(
        app,
        `/api/slot-terminal/ws?projectId=${fixture.projectId}&requirementId=${fixture.requirementId}&pane=codex`,
        2
      );

      const [claude, codex] = await Promise.all([claudeMessages, codexMessages]);

      expect(claude.messages[0].descriptor).toMatchObject({ pane: "claude", target: "%7" });
      expect(claude.messages[1]).toMatchObject({ type: "frame", data: "claude initial\n", generation: 1 });
      expect(codex.messages[0].descriptor).toMatchObject({ pane: "codex", target: "%8" });
      expect(codex.messages[1]).toMatchObject({ type: "frame", data: "codex initial\n", generation: 1 });
      expect(capture.calls.map((call) => call.target).sort()).toEqual(["%7", "%8"]);
      claude.socket.terminate();
      codex.socket.terminate();
    } finally {
      await app.close();
    }
  });

  it("revalidates target before input, writes to the guarded target, and records audit", async () => {
    const fixture = createRouteFixture();
    const capture = buildCapture({ "%7": ["claude frame\n"] });
    let resolveAudit!: () => void;
    const auditPromise = new Promise<void>((resolve) => {
      resolveAudit = resolve;
    });
    const inputWriter: SlotTerminalInputWriterBackend = {
      sendInput: vi.fn(async () => ({ commandCount: 2, bytes: 7 }))
    };
    const auditSink: SlotTerminalInputAuditSink = {
      recordInput: vi.fn(async () => {
        resolveAudit();
      })
    };
    const app = buildSlotTerminalWebSocketApp({
      store: fixture.store,
      service: fixture.service,
      capture,
      inputWriter,
      auditSink
    });

    try {
      await app.ready();
      const { socket } = await collectInjectedMessages(
        app,
        `/api/slot-terminal/ws?projectId=${fixture.projectId}&requirementId=${fixture.requirementId}&pane=claude`,
        2
      );

      socket.send(JSON.stringify({ type: "input", data: "中文\r" }));
      await auditPromise;

      expect(fixture.service.assertTargetBelongsTo).toHaveBeenCalledTimes(2);
      expect(fixture.service.assertTargetBelongsTo).toHaveBeenLastCalledWith({
        requirementId: fixture.requirementId,
        slotId: fixture.slotId,
        role: "claude",
        target: "%7"
      });
      expect(inputWriter.sendInput).toHaveBeenCalledWith({
        target: "%7",
        socketPath: join(fixture.projectRoot, ".ccb", "ccbd", "tmux.sock"),
        data: "中文\r"
      });
      expect(auditSink.recordInput).toHaveBeenCalledWith({
        projectId: fixture.projectId,
        contextKind: "requirement",
        contextId: fixture.requirementId,
        requirementId: fixture.requirementId,
        slotId: fixture.slotId,
        pane: "claude",
        target: "%7",
        remoteAddr: "127.0.0.1",
        data: "中文\r",
        commandCount: 2,
        outcome: "accepted"
      });
      socket.terminate();
    } finally {
      await app.close();
    }
  });

  it("rejects forbidden input revalidation without sending keys", async () => {
    const fixture = createRouteFixture();
    const capture = buildCapture({ "%7": ["claude frame\n"] });
    let guardCalls = 0;
    fixture.service.assertTargetBelongsTo.mockImplementation(
      async (input: { requirementId: string; slotId: string; role: string; target: string }) => {
        guardCalls += 1;
        if (guardCalls === 1) {
          return { role: "claude", target: input.target, paneIndex: 2 };
        }
        throw new SlotTerminalTargetForbiddenError("slot terminal target does not belong to role");
      }
    );
    const inputWriter: SlotTerminalInputWriterBackend = {
      sendInput: vi.fn(async () => ({ commandCount: 1, bytes: 1 }))
    };
    const auditSink: SlotTerminalInputAuditSink = {
      recordInput: vi.fn()
    };
    const app = buildSlotTerminalWebSocketApp({
      store: fixture.store,
      service: fixture.service,
      capture,
      inputWriter,
      auditSink
    });

    try {
      await app.ready();
      const { socket } = await collectInjectedMessages(
        app,
        `/api/slot-terminal/ws?projectId=${fixture.projectId}&requirementId=${fixture.requirementId}&pane=claude`,
        2
      );
      const errorPromise = collectWebSocketMessages(socket, 1);

      socket.send(JSON.stringify({ type: "input", data: "x" }));
      const [error] = await errorPromise;

      expect(error).toMatchObject({
        type: "error",
        code: "FORBIDDEN",
        message: "slot terminal target does not belong to role"
      });
      expect(fixture.service.assertTargetBelongsTo).toHaveBeenCalledTimes(2);
      expect(inputWriter.sendInput).not.toHaveBeenCalled();
      expect(auditSink.recordInput).toHaveBeenCalledWith({
        projectId: fixture.projectId,
        contextKind: "requirement",
        contextId: fixture.requirementId,
        requirementId: fixture.requirementId,
        slotId: fixture.slotId,
        pane: "claude",
        target: "%7",
        remoteAddr: "127.0.0.1",
        data: "x",
        commandCount: 0,
        outcome: "forbidden",
        rejectionCode: "FORBIDDEN",
        rejectionReason: "slot terminal target does not belong to role"
      });
      socket.terminate();
    } finally {
      await app.close();
    }
  });

  it("rejects oversized input, records rejected audit, and does not send keys", async () => {
    const fixture = createRouteFixture();
    const capture = buildCapture({ "%7": ["claude frame\n"] });
    const inputWriter: SlotTerminalInputWriterBackend = {
      sendInput: vi.fn(async () => ({ commandCount: 1, bytes: 1 }))
    };
    const auditSink: SlotTerminalInputAuditSink = {
      recordInput: vi.fn()
    };
    const app = buildSlotTerminalWebSocketApp({
      store: fixture.store,
      service: fixture.service,
      capture,
      inputWriter,
      auditSink
    });

    try {
      await app.ready();
      const { socket } = await collectInjectedMessages(
        app,
        `/api/slot-terminal/ws?projectId=${fixture.projectId}&requirementId=${fixture.requirementId}&pane=claude`,
        2
      );
      const errorPromise = collectWebSocketMessages(socket, 1);
      const oversized = "x".repeat(SLOT_TERMINAL_INPUT_MAX_BYTES + 1);

      socket.send(JSON.stringify({ type: "input", data: oversized }));
      const [error] = await errorPromise;

      expect(error).toMatchObject({
        type: "error",
        code: "INPUT_TOO_LARGE",
        message: `input.data exceeds ${SLOT_TERMINAL_INPUT_MAX_BYTES} bytes`
      });
      expect(fixture.service.assertTargetBelongsTo).toHaveBeenCalledTimes(1);
      expect(inputWriter.sendInput).not.toHaveBeenCalled();
      expect(auditSink.recordInput).toHaveBeenCalledWith({
        projectId: fixture.projectId,
        contextKind: "requirement",
        contextId: fixture.requirementId,
        requirementId: fixture.requirementId,
        slotId: fixture.slotId,
        pane: "claude",
        target: "%7",
        remoteAddr: "127.0.0.1",
        data: oversized,
        commandCount: 0,
        outcome: "rejected",
        rejectionCode: "INPUT_TOO_LARGE",
        rejectionReason: `input.data exceeds ${SLOT_TERMINAL_INPUT_MAX_BYTES} bytes`
      });
      socket.terminate();
    } finally {
      await app.close();
    }
  });

  it("writes additive input audit files for requirement and agent-group contexts", async () => {
    const auditDir = await mkdtempSlotTerminal();
    const writer = new SlotTerminalInputAuditWriter({ auditDir });

    try {
      await writer.recordInput({
        projectId: "project-1",
        contextKind: "requirement",
        contextId: "req-1",
        requirementId: "req-1",
        slotId: "slot-2",
        pane: "claude",
        target: "%7",
        remoteAddr: "127.0.0.1",
        data: "req input",
        commandCount: 1,
        outcome: "accepted"
      });
      await writer.recordInput({
        projectId: "project-1",
        contextKind: "agent-group",
        contextId: "main",
        slotId: "main",
        pane: "codex",
        target: "%2",
        remoteAddr: "127.0.0.1",
        data: "main input",
        commandCount: 1,
        outcome: "accepted"
      });

      const requirementRow = JSON.parse(await readFile(join(auditDir, "req-1.jsonl"), "utf8")) as Record<
        string,
        unknown
      >;
      const agentGroupRow = JSON.parse(await readFile(join(auditDir, "agent-group-main.jsonl"), "utf8")) as Record<
        string,
        unknown
      >;

      expect(requirementRow).toMatchObject({
        projectId: "project-1",
        contextKind: "requirement",
        contextId: "req-1",
        requirementId: "req-1",
        slotId: "slot-2",
        pane: "claude",
        target: "%7",
        outcome: "accepted",
        command_count: 1
      });
      expect(agentGroupRow).toMatchObject({
        projectId: "project-1",
        contextKind: "agent-group",
        contextId: "main",
        slotId: "main",
        pane: "codex",
        target: "%2",
        outcome: "accepted",
        command_count: 1
      });
      expect(agentGroupRow).not.toHaveProperty("requirementId");
    } finally {
      await rm(auditDir, { recursive: true, force: true });
    }
  });

  it("parses visibility, active, and input frames while still rejecting resize", () => {
    expect(evaluateSlotTerminalClientFrame(JSON.stringify({ type: "visibility", state: "hidden" }))).toEqual({
      type: "hint",
      visibility: "hidden",
      active: undefined
    });
    expect(evaluateSlotTerminalClientFrame(JSON.stringify({ type: "hint", visible: true, active: false }))).toEqual({
      type: "hint",
      visibility: "visible",
      active: false
    });
    expect(evaluateSlotTerminalClientFrame(JSON.stringify({ type: "viewport", active: true }))).toEqual({
      type: "hint",
      visibility: undefined,
      active: true
    });
    expect(evaluateSlotTerminalClientFrame(JSON.stringify({ type: "input", data: "中文" }))).toEqual({
      type: "input",
      data: "中文"
    });
    expect(evaluateSlotTerminalClientFrame(JSON.stringify({ type: "in", data: "\u0003" }))).toEqual({
      type: "input",
      data: "\u0003"
    });
    expect(evaluateSlotTerminalClientFrame(JSON.stringify({ type: "write", data: "legacy" }))).toEqual({
      type: "input",
      data: "legacy"
    });
    expect(evaluateSlotTerminalClientFrame(JSON.stringify({ type: "input" }))).toEqual({
      type: "send",
      payload: {
        type: "error",
        code: "BAD_FRAME",
        message: "input.data must be a string"
      }
    });
    expect(evaluateSlotTerminalClientFrame(JSON.stringify({ type: "resize", cols: 200, rows: 50 }))).toEqual({
      type: "send",
      payload: {
        type: "error",
        code: "READ_ONLY",
        message: "slot terminal websocket is read-only"
      }
    });
  });

  it("tmux slot-terminal backends only use the allowed tmux command whitelist on the real socket path", async () => {
    const execFileProcess = vi.fn(async (_command: string, args: string[]) => {
      if (args.includes("#{pane_pipe}\t#{@slot_terminal_pipe}")) {
        return { stdout: "0\t\n", stderr: "" };
      }
      if (args.includes("display-message")) {
        return { stdout: "100 30\n", stderr: "" };
      }
      return { stdout: "frame\n", stderr: "" };
    });
    const capture = new TmuxSlotTerminalFrameCapture({
      execFileProcess
    });
    const streamBackend = new TmuxSlotTerminalStreamBackend({
      execFileProcess
    });
    const socketPath = "/repo/SU-CCB/.ccb/ccbd/tmux.sock";

    const initialFrame = await capture.capturePane({
      target: "%7",
      socketPath,
      initial: true
    });
    const frame = await capture.capturePane({
      target: "%7",
      socketPath,
      initial: false
    });
    const dimensions = await capture.getPaneDimensions({
      target: "%7",
      socketPath
    });
    const panePipe = await streamBackend.getPanePipe({ target: "%7", socketPath });
    await streamBackend.stopPipe({ target: "%7", socketPath });
    await streamBackend.startPipe({ target: "%7", socketPath, fifoPath: "/tmp/slot fifo" });
    await streamBackend.setPipeOwner({ target: "%7", socketPath, fifoPath: "/tmp/slot fifo" });
    await streamBackend.clearPipeOwner({ target: "%7", socketPath });

    expect(initialFrame).toBe("frame\n");
    expect(frame).toBe("frame\n");
    expect(dimensions).toEqual({ cols: 100, rows: 30 });
    expect(panePipe).toBe("0\t");
    expect(execFileProcess.mock.calls.map((call) => call[1])).toEqual([
      [
        "-S",
        socketPath,
        "capture-pane",
        "-S",
        "-2000",
        "-p",
        "-e",
        "-t",
        "%7"
      ],
      [
        "-S",
        socketPath,
        "capture-pane",
        "-p",
        "-e",
        "-t",
        "%7"
      ],
      [
        "-S",
        socketPath,
        "display-message",
        "-p",
        "-t",
        "%7",
        "#{pane_width} #{pane_height}"
      ],
      [
        "-S",
        socketPath,
        "display-message",
        "-p",
        "-t",
        "%7",
        "#{pane_pipe}\t#{@slot_terminal_pipe}"
      ],
      [
        "-S",
        socketPath,
        "pipe-pane",
        "-t",
        "%7"
      ],
      [
        "-S",
        socketPath,
        "pipe-pane",
        "-o",
        "-t",
        "%7",
        "cat > '/tmp/slot fifo'"
      ],
      [
        "-S",
        socketPath,
        "set-option",
        "-p",
        "-t",
        "%7",
        "@slot_terminal_pipe",
        "/tmp/slot fifo"
      ],
      [
        "-S",
        socketPath,
        "set-option",
        "-pu",
        "-t",
        "%7",
        "@slot_terminal_pipe"
      ]
    ]);
    const invokedArgs = execFileProcess.mock.calls.flatMap(([, args]) => args);
    expect(invokedArgs).toContain("capture-pane");
    expect(invokedArgs).toContain("display-message");
    expect(invokedArgs).toContain("pipe-pane");
    expect(invokedArgs).toContain("set-option");
    expect(invokedArgs).not.toContain("resize-window");
    expect(invokedArgs).not.toContain("refresh-client");
    expect(invokedArgs).not.toContain("-C");
    expect(invokedArgs).not.toContain("attach");
    expect(invokedArgs).not.toContain("send-keys");
  });

  it("tmux input writer maps text and keys to only send-keys -t commands", async () => {
    const execFileProcess = vi.fn(async () => ({ stdout: "", stderr: "" }));
    const writer = new TmuxSlotTerminalInputWriter({ execFileProcess });

    const result = await writer.sendInput({
      target: "%7",
      socketPath: "/repo/SU-CCB/.ccb/ccbd/tmux.sock",
      data: "中文\u007f\r\u001b[A\u001b[B\u001b[C\u001b[D\u0003"
    });

    expect(result).toEqual({
      commandCount: 8,
      bytes: Buffer.byteLength("中文\u007f\r\u001b[A\u001b[B\u001b[C\u001b[D\u0003", "utf8")
    });
    expect(execFileProcess.mock.calls.map((call) => call[1])).toEqual([
      ["-S", "/repo/SU-CCB/.ccb/ccbd/tmux.sock", "send-keys", "-t", "%7", "-l", "--", "中文"],
      ["-S", "/repo/SU-CCB/.ccb/ccbd/tmux.sock", "send-keys", "-t", "%7", "BSpace"],
      ["-S", "/repo/SU-CCB/.ccb/ccbd/tmux.sock", "send-keys", "-t", "%7", "Enter"],
      ["-S", "/repo/SU-CCB/.ccb/ccbd/tmux.sock", "send-keys", "-t", "%7", "Up"],
      ["-S", "/repo/SU-CCB/.ccb/ccbd/tmux.sock", "send-keys", "-t", "%7", "Down"],
      ["-S", "/repo/SU-CCB/.ccb/ccbd/tmux.sock", "send-keys", "-t", "%7", "Right"],
      ["-S", "/repo/SU-CCB/.ccb/ccbd/tmux.sock", "send-keys", "-t", "%7", "Left"],
      ["-S", "/repo/SU-CCB/.ccb/ccbd/tmux.sock", "send-keys", "-t", "%7", "C-c"]
    ]);
    const invokedArgs = execFileProcess.mock.calls.flatMap(([, args]) => args);
    expect(invokedArgs.every((arg) => arg !== "attach")).toBe(true);
    expect(invokedArgs).not.toContain("resize-window");
    expect(invokedArgs).not.toContain("refresh-client");
    expect(invokedArgs).not.toContain("-C");
    expect(invokedArgs).not.toContain("pipe-pane");
  });

  it("tmux input writer terminates literal args so leading dash text is not parsed as flags", async () => {
    const execFileProcess = vi.fn(async () => ({ stdout: "", stderr: "" }));
    const writer = new TmuxSlotTerminalInputWriter({ execFileProcess });

    const result = await writer.sendInput({
      target: "%7",
      socketPath: "/repo/SU-CCB/.ccb/ccbd/tmux.sock",
      data: "-rf\r--help"
    });

    expect(result.commandCount).toBe(3);
    expect(execFileProcess.mock.calls.map((call) => call[1])).toEqual([
      ["-S", "/repo/SU-CCB/.ccb/ccbd/tmux.sock", "send-keys", "-t", "%7", "-l", "--", "-rf"],
      ["-S", "/repo/SU-CCB/.ccb/ccbd/tmux.sock", "send-keys", "-t", "%7", "Enter"],
      ["-S", "/repo/SU-CCB/.ccb/ccbd/tmux.sock", "send-keys", "-t", "%7", "-l", "--", "--help"]
    ]);
    const literalCommands = execFileProcess.mock.calls.map((call) => call[1]).filter((args) => args.includes("-l"));
    for (const args of literalCommands) {
      expect(args.slice(-2, -1)).toEqual(["--"]);
      expect(args[args.length - 1]?.startsWith("-")).toBe(true);
    }
  });

  it("writes Chinese and control keys through websocket into a temporary tmux pane", async () => {
    const tempDir = await mkdtempSlotTerminal();
    const socketPath = join(tempDir, ".ccb", "ccbd", "tmux.sock");
    const sessionName = `slot_terminal_${process.pid}_${Date.now()}`;
    let app: ReturnType<typeof buildSlotTerminalWebSocketApp> | null = null;

    try {
      await mkdir(dirname(socketPath), { recursive: true });
      const readerPath = join(tempDir, "reader.cjs");
      await writeFile(readerPath, rawInputReaderScript(), "utf8");
      await execFileAsync("tmux", [
        "-S",
        socketPath,
        "new-session",
        "-d",
        "-s",
        sessionName,
        "-x",
        "100",
        "-y",
        "30",
        `node ${shellQuote(readerPath)}`
      ]);
      const paneId = await resolveSinglePaneId(socketPath, sessionName);
      await waitForPaneText(socketPath, paneId, ["READY"]);

      const fixture = createRouteFixture({
        projectRoot: tempDir,
        panes: [{ role: "claude", target: paneId, paneIndex: 0 }]
      });
      app = buildSlotTerminalWebSocketApp({
        store: fixture.store,
        service: fixture.service,
        capture: new TmuxSlotTerminalFrameCapture(),
        inputWriter: new TmuxSlotTerminalInputWriter(),
        auditSink: { recordInput: vi.fn() },
        activeIntervalMs: 1_000
      });
      await app.ready();
      const { socket } = await collectInjectedMessages(
        app,
        `/api/slot-terminal/ws?projectId=${fixture.projectId}&requirementId=${fixture.requirementId}&pane=claude`,
        2
      );

      socket.send(JSON.stringify({ type: "input", data: "中文" }));
      socket.send(JSON.stringify({ type: "input", data: "-rf" }));
      socket.send(JSON.stringify({ type: "input", data: "\u007f" }));
      socket.send(JSON.stringify({ type: "input", data: "\r" }));
      socket.send(JSON.stringify({ type: "input", data: "\u001b[A\u001b[B\u001b[C\u001b[D" }));
      socket.send(JSON.stringify({ type: "input", data: "\u0003" }));

      const output = await waitForPaneText(socketPath, paneId, [
        "TEXT:中",
        "TEXT:文",
        "TEXT:-",
        "TEXT:r",
        "TEXT:f",
        "KEY:<Backspace>",
        "KEY:<Enter>",
        "KEY:<Up>",
        "KEY:<Down>",
        "KEY:<Right>",
        "KEY:<Left>",
        "KEY:<C-c>"
      ]);

      expect(output).toContain("TEXT:中");
      expect(output).toContain("TEXT:文");
      socket.terminate();
    } finally {
      await app?.close();
      await execFileAsync("tmux", ["-S", socketPath, "kill-server"]).catch(() => undefined);
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 10_000);
});

function collectInjectedMessages(
  app: ReturnType<typeof buildSlotTerminalWebSocketApp>,
  url: string,
  count: number
): Promise<{ socket: { send: (data: string) => void; terminate: () => void }; messages: Array<Record<string, unknown>> }> {
  return new Promise((resolve, reject) => {
    void app
      .injectWS(
        url,
        webSocketRequest(),
        {
          onInit(ws) {
            collectWebSocketMessages(ws, count).then(
              (messages) => resolve({ socket: ws, messages }),
              reject
            );
          }
        }
      )
      .catch(reject);
  });
}

async function collectRejectedInjectedMessages(
  app: ReturnType<typeof buildSlotTerminalWebSocketApp>,
  url: string
): Promise<Array<Record<string, unknown>>> {
  let socket: { terminate: () => void } | null = null;
  try {
    return await new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
      void app
        .injectWS(url, webSocketRequest(), {
          onInit(ws) {
            socket = ws;
            collectWebSocketMessages(ws, 1).then(resolve, reject);
          }
        })
        .catch(reject);
    });
  } finally {
    socket?.terminate();
  }
}

function webSocketRequest(origin = ALLOWED_ORIGIN): Partial<IncomingMessage> {
  return {
    headers: { origin },
    socket: { remoteAddress: "127.0.0.1" }
  } as Partial<IncomingMessage>;
}

function collectWebSocketMessages(
  socket: { on: (event: "message" | "error", handler: (...args: unknown[]) => void) => void },
  count: number,
  timeoutMs = 2_000
): Promise<Array<Record<string, unknown>>> {
  return new Promise((resolve, reject) => {
    const messages: Array<Record<string, unknown>> = [];
    const timeout = setTimeout(() => {
      reject(new Error(`timed out waiting for ${count} websocket messages`));
    }, timeoutMs);
    socket.on("message", (data) => {
      messages.push(JSON.parse(String(data)) as Record<string, unknown>);
      if (messages.length === count) {
        clearTimeout(timeout);
        resolve(messages);
      }
    });
    socket.on("error", () => {
      clearTimeout(timeout);
      reject(new Error("websocket error"));
    });
  });
}

async function mkdtempSlotTerminal(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "slot-terminal-ws-"));
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForCondition(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await sleep(10);
  }
  throw new Error(message);
}

async function resolveSinglePaneId(socketPath: string, sessionName: string): Promise<string> {
  const { stdout } = await execFileAsync("tmux", [
    "-S",
    socketPath,
    "list-panes",
    "-t",
    sessionName,
    "-F",
    "#{pane_id}"
  ]);
  const paneId = String(stdout).trim().split(/\r?\n/)[0];
  assert.ok(paneId?.startsWith("%"), `expected tmux pane id, got ${String(stdout)}`);
  return paneId;
}

async function waitForPaneText(socketPath: string, target: string, expected: string[]): Promise<string> {
  const deadline = Date.now() + 5_000;
  let last = "";
  while (Date.now() < deadline) {
    const { stdout } = await execFileAsync("tmux", ["-S", socketPath, "capture-pane", "-p", "-e", "-t", target]);
    last = String(stdout);
    if (expected.every((item) => last.includes(item))) {
      return last;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for tmux pane text: ${expected.join(", ")}\n${last}`);
}

function rawInputReaderScript(): string {
  return `
process.stdin.setRawMode(true);
process.stdin.resume();
console.log("READY");
const known = [
  ["\\u001b[A", "<Up>"],
  ["\\u001b[B", "<Down>"],
  ["\\u001b[C", "<Right>"],
  ["\\u001b[D", "<Left>"]
];
process.stdin.on("data", (buffer) => {
  let text = buffer.toString("utf8");
  while (text.length > 0) {
    const match = known.find(([sequence]) => text.startsWith(sequence));
    if (match) {
      console.log("KEY:" + match[1]);
      text = text.slice(match[0].length);
      continue;
    }
    const codePoint = text.codePointAt(0);
    const char = String.fromCodePoint(codePoint);
    text = text.slice(char.length);
    if (char === "\\u0003") {
      console.log("KEY:<C-c>");
    } else if (char === "\\r" || char === "\\n") {
      console.log("KEY:<Enter>");
    } else if (char === "\\u007f" || char === "\\b") {
      console.log("KEY:<Backspace>");
    } else {
      console.log("TEXT:" + char);
    }
  }
});
`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
