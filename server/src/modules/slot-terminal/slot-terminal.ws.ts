import type { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";

import { prisma } from "../../db/prisma.js";
import { assertTargetBelongsTo } from "./slot-terminal.guard.js";
import {
  isSlotTerminalNotFoundError,
  isSlotTerminalTargetForbiddenError
} from "./slot-terminal.errors.js";
import {
  buildSlotTerminalTmuxSocketPath,
  isSlotTerminalRole,
  PrismaSlotTerminalStore,
  SlotTerminalService,
  type SlotTerminalDescriptor,
  type SlotTerminalPaneTarget,
  type SlotTerminalRole,
  type SlotTerminalStore
} from "./slot-terminal.service.js";
import {
  SLOT_TERMINAL_ACTIVE_FRAME_INTERVAL_MS,
  SLOT_TERMINAL_IDLE_FRAME_INTERVAL_MS,
  SlotTerminalFramePump,
  inferFrameDimensions,
  TmuxSlotTerminalFrameCapture,
  type SlotTerminalFrameCaptureBackend,
  type SlotTerminalPaneDimensions,
  type SlotTerminalPollingHint,
  type SlotTerminalVisibility
} from "./slot-terminal.frame-stream.js";
import {
  SlotTerminalInputAuditWriter,
  TmuxSlotTerminalInputWriter,
  type SlotTerminalInputAuditSink,
  type SlotTerminalInputWriterBackend
} from "./slot-terminal.input.js";
import {
  SlotTerminalStreamRecorderRegistry,
  type SlotTerminalStreamChunk,
  type SlotTerminalStreamMode,
  type SlotTerminalStreamSubscription
} from "./slot-terminal-stream-recorder.js";

export const SLOT_TERMINAL_INPUT_MAX_BYTES = 64 * 1024;

type SlotTerminalStreamRecorderDependency = Pick<SlotTerminalStreamRecorderRegistry, "subscribe">;

export type SlotTerminalWebSocketService = Pick<
  SlotTerminalService,
  | "resolveRequirementTerminal"
  | "assertTargetBelongsTo"
  | "resolveAgentGroupTerminal"
  | "assertTargetBelongsToAgentGroup"
>;

export type SlotTerminalWebSocketDependencies = {
  prismaClient?: PrismaClient;
  store?: SlotTerminalStore;
  service?: SlotTerminalWebSocketService;
  capture?: SlotTerminalFrameCaptureBackend;
  inputWriter?: SlotTerminalInputWriterBackend;
  auditSink?: SlotTerminalInputAuditSink;
  streamRecorder?: SlotTerminalStreamRecorderDependency | null;
  activeIntervalMs?: number;
  idleIntervalMs?: number;
  allowedOrigins?: string[];
  inputMaxBytes?: number;
};

export type SlotTerminalClientFrameAction =
  | { type: "send"; payload: unknown }
  | { type: "close" }
  | { type: "hint"; visibility?: SlotTerminalVisibility; active?: boolean }
  | { type: "input"; data: string }
  | { type: "paste"; data: string }
  | { type: "ignore" };

type SlotTerminalSubscription = {
  slotId: string;
  role: SlotTerminalRole;
  target: string;
  socketPath: string;
};

type SlotTerminalWebSocketTarget =
  | {
      kind: "requirement";
      projectId: string;
      requirementId: string;
    }
  | {
      kind: "agentGroup";
      projectId: string;
      group: string;
    };

type SlotTerminalAuditContext =
  | { contextKind: "requirement"; contextId: string; requirementId: string }
  | { contextKind: "agent-group"; contextId: string };

export async function registerSlotTerminalWebSocketRoutes(
  app: FastifyInstance,
  dependencies: SlotTerminalWebSocketDependencies = {}
): Promise<void> {
  const store = dependencies.store ?? new PrismaSlotTerminalStore(dependencies.prismaClient ?? prisma);
  const service = dependencies.service ?? new SlotTerminalService({ store });
  const capture = dependencies.capture ?? new TmuxSlotTerminalFrameCapture();
  const inputWriter = dependencies.inputWriter ?? new TmuxSlotTerminalInputWriter();
  const auditSink = dependencies.auditSink ?? new SlotTerminalInputAuditWriter();
  const streamRecorder =
    dependencies.streamRecorder === undefined ? new SlotTerminalStreamRecorderRegistry() : dependencies.streamRecorder;
  const activeIntervalMs = dependencies.activeIntervalMs ?? SLOT_TERMINAL_ACTIVE_FRAME_INTERVAL_MS;
  const idleIntervalMs = dependencies.idleIntervalMs ?? SLOT_TERMINAL_IDLE_FRAME_INTERVAL_MS;
  const allowedOrigins = dependencies.allowedOrigins ?? getDefaultAllowedOrigins();
  const inputMaxBytes = dependencies.inputMaxBytes ?? SLOT_TERMINAL_INPUT_MAX_BYTES;

  const shared = {
    store,
    service,
    capture,
    inputWriter,
    auditSink,
    streamRecorder,
    activeIntervalMs,
    idleIntervalMs,
    inputMaxBytes
  };

  app.get("/api/slot-terminal/ws", { websocket: true }, (socket, request) => {
    if (!isSlotTerminalOriginAllowed(request.headers.origin, allowedOrigins)) {
      sendErrorAndClose(socket, "FORBIDDEN", "websocket origin is not allowed", 1008);
      return;
    }

    const { projectId, requirementId, pane } = request.query as {
      projectId?: string;
      requirementId?: string;
      pane?: string;
    };

    if (!projectId || !requirementId || !pane) {
      sendErrorAndClose(socket, "BAD_REQUEST", "projectId, requirementId, and pane are required", 1008);
      return;
    }
    if (!isSlotTerminalRole(pane)) {
      sendErrorAndClose(socket, "BAD_REQUEST", "pane must be claude or codex", 1008);
      return;
    }

    handleSlotTerminalWebSocketConnection({
      ...shared,
      socket,
      request,
      target: { kind: "requirement", projectId, requirementId },
      role: pane
    });
  });

  app.get("/api/agent-terminal/ws", { websocket: true }, (socket, request) => {
    if (!isSlotTerminalOriginAllowed(request.headers.origin, allowedOrigins)) {
      sendErrorAndClose(socket, "FORBIDDEN", "websocket origin is not allowed", 1008);
      return;
    }

    const { projectId, group, pane } = request.query as {
      projectId?: string;
      group?: string;
      pane?: string;
    };

    if (!projectId || !group || !pane) {
      sendErrorAndClose(socket, "BAD_REQUEST", "projectId, group, and pane are required", 1008);
      return;
    }
    if (!isSlotTerminalRole(pane)) {
      sendErrorAndClose(socket, "BAD_REQUEST", "pane must be claude or codex", 1008);
      return;
    }

    handleSlotTerminalWebSocketConnection({
      ...shared,
      socket,
      request,
      target: { kind: "agentGroup", projectId, group },
      role: pane
    });
  });
}

function handleSlotTerminalWebSocketConnection(input: {
  socket: {
    send: (data: string) => void;
    close: (code?: number, reason?: string) => void;
    on: {
      (event: "message", handler: (raw: Buffer | string) => void): void;
      (event: "close", handler: () => void): void;
    };
  };
  request: { ip?: string; socket: { remoteAddress?: string } };
  store: Pick<SlotTerminalStore, "findProject">;
  service: SlotTerminalWebSocketService;
  capture: SlotTerminalFrameCaptureBackend;
  inputWriter: SlotTerminalInputWriterBackend;
  auditSink: SlotTerminalInputAuditSink;
  streamRecorder: SlotTerminalStreamRecorderDependency | null;
  activeIntervalMs: number;
  idleIntervalMs: number;
  inputMaxBytes: number;
  target: SlotTerminalWebSocketTarget;
  role: SlotTerminalRole;
}): void {
  let pump: SlotTerminalFramePump | null = null;
  let streamSubscription: SlotTerminalStreamSubscription | null = null;
  let subscription: SlotTerminalSubscription | null = null;
  let currentHint: SlotTerminalPollingHint | null = null;
  let pendingHint: SlotTerminalPollingHint | null = null;
  let inputQueue = Promise.resolve();
  let closed = false;
  const closeConnection = () => {
    if (closed) {
      return;
    }
    closed = true;
    pump?.stop();
    void streamSubscription?.release();
  };

  void (async () => {
    try {
      const resolvedSubscription = await resolveSlotTerminalSubscription({
        store: input.store,
        service: input.service,
        target: input.target,
        role: input.role
      });
      subscription = resolvedSubscription;

      if (closed) {
        return;
      }

      sendJson(input.socket, {
        type: "ready",
        descriptor: buildReadyDescriptor({
          target: input.target,
          subscription: resolvedSubscription,
          activeIntervalMs: input.activeIntervalMs,
          idleIntervalMs: input.idleIntervalMs
        })
      });
      if (input.streamRecorder) {
        streamSubscription = await startSlotTerminalStreamMode({
          capture: input.capture,
          streamRecorder: input.streamRecorder,
          socket: input.socket,
          subscription: resolvedSubscription,
          activeIntervalMs: input.activeIntervalMs,
          idleIntervalMs: input.idleIntervalMs,
          pendingHint,
          getCurrentHint: () => currentHint,
          isClosed: () => closed,
          setPump: (nextPump) => {
            pump?.stop();
            pump = nextPump;
          },
          setStreamSubscription: (nextSubscription) => {
            streamSubscription = nextSubscription;
          }
        });
        pendingHint = null;
      } else {
        pump = createSlotTerminalSnapshotPump({
          capture: input.capture,
          socket: input.socket,
          subscription: resolvedSubscription,
          activeIntervalMs: input.activeIntervalMs,
          idleIntervalMs: input.idleIntervalMs,
          mode: undefined,
          onError: (error) => {
            sendErrorAndClose(input.socket, "CAPTURE_FAILED", errorMessage(error), 1011);
          }
        });
        if (pendingHint) {
          pump.configureHint(pendingHint);
          pendingHint = null;
        }
        await pump.start();
      }
    } catch (error) {
      sendErrorAndClose(input.socket, errorCode(error), errorMessage(error), closeCode(error));
    }
  })();

  input.socket.on("message", (raw: Buffer | string) => {
    const action = evaluateSlotTerminalClientFrame(raw);
    if (action.type === "send") {
      sendJson(input.socket, action.payload);
    } else if (action.type === "close") {
      closeConnection();
      try {
        input.socket.close(1000, "client requested close");
      } catch {
        // ignore
      }
    } else if (action.type === "hint") {
      currentHint = mergeSlotTerminalHint(currentHint, action);
      if (pump || streamSubscription) {
        void applySlotTerminalConnectionHint({ pump, streamSubscription }, action);
      } else {
        pendingHint = currentHint;
      }
    } else if (action.type === "input" || action.type === "paste") {
      const activeSubscription = subscription;
      if (!activeSubscription) {
        sendJson(input.socket, { type: "error", code: "NOT_READY", message: "slot terminal websocket is not ready" });
        return;
      }
      const mode = action.type;
      const data = action.data;
      inputQueue = inputQueue
        .then(async () => {
          await applySlotTerminalInput({
            service: input.service,
            inputWriter: input.inputWriter,
            auditSink: input.auditSink,
            wsTarget: input.target,
            subscription: activeSubscription,
            data,
            remoteAddr: input.request.ip || input.request.socket.remoteAddress || "unknown",
            inputMaxBytes: input.inputMaxBytes,
            mode
          });
        })
        .catch((error) => {
          sendJson(input.socket, { type: "error", code: errorCode(error), message: errorMessage(error) });
        });
    }
  });

  input.socket.on("close", closeConnection);
}

async function startSlotTerminalStreamMode(input: {
  capture: SlotTerminalFrameCaptureBackend;
  streamRecorder: SlotTerminalStreamRecorderDependency;
  socket: { send: (data: string) => void; close: (code?: number, reason?: string) => void };
  subscription: SlotTerminalSubscription;
  activeIntervalMs: number;
  idleIntervalMs: number;
  pendingHint: SlotTerminalPollingHint | null;
  getCurrentHint: () => SlotTerminalPollingHint | null;
  isClosed: () => boolean;
  setPump: (pump: SlotTerminalFramePump | null) => void;
  setStreamSubscription: (subscription: SlotTerminalStreamSubscription | null) => void;
}): Promise<SlotTerminalStreamSubscription | null> {
  let mode = "stream" as SlotTerminalStreamMode;
  let initialSnapshotSent = false;
  let fallbackStarted = false;
  let generation = 0;
  let lastDimensions: SlotTerminalPaneDimensions | null = null;
  let bufferedChunks: SlotTerminalStreamChunk[] = [];
  let streamQueue = Promise.resolve();
  let streamSubscription: SlotTerminalStreamSubscription | null = null;

  const targetInput = {
    target: input.subscription.target,
    socketPath: input.subscription.socketPath
  };
  const sendFrame = (payload: unknown) => {
    if (!input.isClosed()) {
      sendJson(input.socket, payload);
    }
  };
  const ensureFallbackPumpStarted = () => {
    if (fallbackStarted || input.isClosed()) {
      return;
    }
    const pump = createSlotTerminalSnapshotPump({
      capture: input.capture,
      socket: input.socket,
      subscription: input.subscription,
      activeIntervalMs: input.activeIntervalMs,
      idleIntervalMs: input.idleIntervalMs,
      mode: "snapshot-fallback",
      onError: (error) => {
        sendErrorAndClose(input.socket, "CAPTURE_FAILED", errorMessage(error), 1011);
      }
    });
    const currentHint = input.getCurrentHint();
    if (currentHint) {
      pump.configureHint(currentHint);
    }
    input.setPump(pump);
    fallbackStarted = true;
    void pump.start();
  };
  const captureStructuralFrame = async (initial: boolean) => {
    const data = await input.capture.capturePane({ ...targetInput, initial });
    const dimensions = (await input.capture.getPaneDimensions?.(targetInput)) ?? inferFrameDimensions(data);
    lastDimensions = dimensions;
    return {
      data,
      cols: dimensions.cols,
      rows: dimensions.rows,
      generation: ++generation
    };
  };
  const sendReset = async (reason: "resize" | "gap" | "error" | "reconcile") => {
    const frame = await captureStructuralFrame(true);
    sendFrame({
      type: "frame",
      kind: "reset",
      reason,
      ...frame,
      initial: true,
      mode
    });
  };
  const checkResizeAndReset = async (): Promise<boolean> => {
    if (!lastDimensions || !input.capture.getPaneDimensions) {
      return false;
    }
    const dimensions = await input.capture.getPaneDimensions(targetInput);
    if (dimensions.cols === lastDimensions.cols && dimensions.rows === lastDimensions.rows) {
      return false;
    }
    lastDimensions = dimensions;
    await sendReset("resize");
    return true;
  };
  const enqueueReset = (reason: "resize" | "gap" | "error" | "reconcile") => {
    streamQueue = streamQueue
      .then(async () => {
        if (!input.isClosed()) {
          await sendReset(reason);
        }
      })
      .catch(() => {
        mode = "snapshot-fallback";
        ensureFallbackPumpStarted();
      });
  };
  const enqueueStreamChunk = (chunk: SlotTerminalStreamChunk) => {
    streamQueue = streamQueue
      .then(async () => {
        if (input.isClosed() || mode !== "stream") {
          return;
        }
        const resized = await checkResizeAndReset();
        if (resized) {
          return;
        }
        sendFrame({
          type: "frame",
          kind: "stream",
          data: chunk.data,
          seq: chunk.seq,
          mode: "stream"
        });
      })
      .catch(() => {
        mode = "snapshot-fallback";
        ensureFallbackPumpStarted();
      });
  };

  streamSubscription = await input.streamRecorder.subscribe({
    target: input.subscription.target,
    socketPath: input.subscription.socketPath,
    callbacks: {
      onChunk: (chunk) => {
        if (!initialSnapshotSent) {
          bufferedChunks.push(chunk);
          return;
        }
        enqueueStreamChunk(chunk);
      },
      onGap: () => {
        if (!initialSnapshotSent) {
          return;
        }
        enqueueReset("gap");
      },
      onMode: (event) => {
        mode = event.mode;
        if (event.mode === "snapshot-fallback") {
          bufferedChunks = [];
          if (initialSnapshotSent) {
            ensureFallbackPumpStarted();
          }
          return;
        }
        fallbackStarted = false;
        input.setPump(null);
      },
      onError: () => {
        mode = "snapshot-fallback";
        bufferedChunks = [];
        if (initialSnapshotSent) {
          enqueueReset("error");
          ensureFallbackPumpStarted();
        }
      }
    }
  });

  if (input.isClosed()) {
    await streamSubscription.release();
    input.setStreamSubscription(null);
    return null;
  }
  input.setStreamSubscription(streamSubscription);
  if (input.pendingHint) {
    await applySlotTerminalConnectionHint({ pump: null, streamSubscription }, input.pendingHint);
  }
  if (mode === "snapshot-fallback") {
    ensureFallbackPumpStarted();
    return streamSubscription;
  }

  const initialFrame = await captureStructuralFrame(true);
  initialSnapshotSent = true;
  sendFrame({
    type: "frame",
    data: initialFrame.data,
    cols: initialFrame.cols,
    rows: initialFrame.rows,
    generation: initialFrame.generation,
    initial: true,
    mode
  });
  for (const chunk of bufferedChunks) {
    enqueueStreamChunk(chunk);
  }
  bufferedChunks = [];
  return streamSubscription;
}

function createSlotTerminalSnapshotPump(input: {
  capture: SlotTerminalFrameCaptureBackend;
  socket: { send: (data: string) => void };
  subscription: SlotTerminalSubscription;
  activeIntervalMs: number;
  idleIntervalMs: number;
  mode?: SlotTerminalStreamMode;
  onError: (error: unknown) => void;
}): SlotTerminalFramePump {
  return new SlotTerminalFramePump({
    capture: input.capture,
    target: input.subscription.target,
    socketPath: input.subscription.socketPath,
    activeIntervalMs: input.activeIntervalMs,
    idleIntervalMs: input.idleIntervalMs,
    onFrame: (frame) => {
      sendJson(input.socket, {
        type: "frame",
        data: frame.data,
        cols: frame.cols,
        rows: frame.rows,
        generation: frame.generation,
        initial: frame.initial,
        ...(input.mode ? { mode: input.mode } : {})
      });
    },
    onError: input.onError
  });
}

export function evaluateSlotTerminalClientFrame(raw: Buffer | string): SlotTerminalClientFrameAction {
  const parsed = parseFrame(raw);
  if (!parsed || typeof parsed.type !== "string") {
    return { type: "send", payload: { type: "error", code: "BAD_FRAME", message: "invalid JSON frame" } };
  }
  switch (parsed.type) {
    case "ping":
      return { type: "send", payload: { type: "pong" } };
    case "close":
      return { type: "close" };
    case "visibility":
    case "active":
    case "viewport":
    case "hint":
      return parseHintAction(parsed);
    case "in":
    case "input":
    case "write":
      return parseInputAction(parsed);
    case "paste":
      return parsePasteAction(parsed);
    case "resize":
    case "request_write":
    case "release_write":
      return {
        type: "send",
        payload: {
          type: "error",
          code: "READ_ONLY",
          message: "slot terminal websocket is read-only"
        }
      };
    default:
      return { type: "ignore" };
  }
}

async function applySlotTerminalHint(pump: SlotTerminalFramePump, hint: SlotTerminalPollingHint): Promise<void> {
  if (hint.visibility === "hidden") {
    await pump.setVisibility("hidden");
  }
  if (typeof hint.active === "boolean") {
    await pump.setActive(hint.active);
  }
  if (hint.visibility === "visible") {
    await pump.setVisibility("visible");
  }
}

async function applySlotTerminalConnectionHint(
  channels: { pump: SlotTerminalFramePump | null; streamSubscription: SlotTerminalStreamSubscription | null },
  hint: SlotTerminalPollingHint
): Promise<void> {
  if (hint.visibility === "hidden") {
    channels.streamSubscription?.pause();
  }
  if (channels.pump) {
    await applySlotTerminalHint(channels.pump, hint);
  }
  if (hint.visibility === "visible") {
    channels.streamSubscription?.resume();
  }
}

function mergeSlotTerminalHint(
  previous: SlotTerminalPollingHint | null,
  next: SlotTerminalPollingHint
): SlotTerminalPollingHint {
  return {
    visibility: next.visibility ?? previous?.visibility,
    active: typeof next.active === "boolean" ? next.active : previous?.active
  };
}

async function applySlotTerminalInput(input: {
  service: SlotTerminalWebSocketService;
  inputWriter: SlotTerminalInputWriterBackend;
  auditSink: SlotTerminalInputAuditSink;
  wsTarget: SlotTerminalWebSocketTarget;
  subscription: SlotTerminalSubscription;
  data: string;
  remoteAddr: string;
  inputMaxBytes: number;
  mode?: "input" | "paste";
}): Promise<void> {
  if (!input.data) {
    return;
  }
  const auditContext = auditContextForTarget(input.wsTarget);
  const bytes = Buffer.byteLength(input.data, "utf8");
  if (bytes > input.inputMaxBytes) {
    await input.auditSink.recordInput({
      projectId: input.wsTarget.projectId,
      ...auditContext,
      slotId: input.subscription.slotId,
      pane: input.subscription.role,
      target: input.subscription.target,
      remoteAddr: input.remoteAddr,
      data: input.data,
      commandCount: 0,
      outcome: "rejected",
      rejectionCode: "INPUT_TOO_LARGE",
      rejectionReason: `input.data exceeds ${input.inputMaxBytes} bytes`
    });
    throw new SlotTerminalInputTooLargeError(`input.data exceeds ${input.inputMaxBytes} bytes`);
  }
  let checked;
  try {
    checked = await assertSlotTerminalTarget({
      service: input.service,
      wsTarget: input.wsTarget,
      subscription: input.subscription
    });
  } catch (error) {
    if (isSlotTerminalTargetForbiddenError(error)) {
      await input.auditSink.recordInput({
        projectId: input.wsTarget.projectId,
        ...auditContext,
        slotId: input.subscription.slotId,
        pane: input.subscription.role,
        target: input.subscription.target,
        remoteAddr: input.remoteAddr,
        data: input.data,
        commandCount: 0,
        outcome: "forbidden",
        rejectionCode: "FORBIDDEN",
        rejectionReason: errorMessage(error)
      });
    }
    throw error;
  }
  const write = { target: checked.target, socketPath: input.subscription.socketPath, data: input.data };
  const result =
    input.mode === "paste"
      ? await input.inputWriter.sendPaste(write)
      : await input.inputWriter.sendInput(write);
  await input.auditSink.recordInput({
    projectId: input.wsTarget.projectId,
    ...auditContext,
    slotId: input.subscription.slotId,
    pane: input.subscription.role,
    target: checked.target,
    remoteAddr: input.remoteAddr,
    data: input.data,
    commandCount: result.commandCount,
    outcome: "accepted"
  });
}

async function resolveSlotTerminalSubscription(input: {
  store: Pick<SlotTerminalStore, "findProject">;
  service: SlotTerminalWebSocketService;
  target: SlotTerminalWebSocketTarget;
  role: SlotTerminalRole;
}): Promise<SlotTerminalSubscription> {
  const [project, descriptor] = await Promise.all([
    input.store.findProject(input.target.projectId),
    resolveTerminalDescriptor(input.service, input.target)
  ]);
  if (!project) {
    throw new Error(`${input.target.kind === "requirement" ? "slot" : "agent"} terminal project not found`);
  }

  const pane = descriptor.panes.find((candidate) => candidate.role === input.role);
  if (!pane) {
    throw new Error("slot terminal pane not found");
  }

  const socketPath = buildSlotTerminalTmuxSocketPath(project.localPath);
  const checked = await assertSlotTerminalTarget({
    service: input.service,
    wsTarget: input.target,
    subscription: {
      slotId: descriptor.slotId,
      role: input.role,
      target: pane.target,
      socketPath
    }
  });

  return {
    slotId: descriptor.slotId,
    role: input.role,
    target: checked.target,
    socketPath
  };
}

async function resolveTerminalDescriptor(
  service: SlotTerminalWebSocketService,
  target: SlotTerminalWebSocketTarget
): Promise<SlotTerminalDescriptor> {
  if (target.kind === "requirement") {
    return await service.resolveRequirementTerminal({
      projectId: target.projectId,
      requirementId: target.requirementId
    });
  }
  return await service.resolveAgentGroupTerminal({
    projectId: target.projectId,
    group: target.group
  });
}

async function assertSlotTerminalTarget(input: {
  service: SlotTerminalWebSocketService;
  wsTarget: SlotTerminalWebSocketTarget;
  subscription: SlotTerminalSubscription;
}): Promise<SlotTerminalPaneTarget> {
  if (input.wsTarget.kind === "requirement") {
    return await assertTargetBelongsTo(
      input.wsTarget.requirementId,
      input.subscription.slotId,
      input.subscription.role,
      input.subscription.target,
      { service: input.service }
    );
  }

  return await input.service.assertTargetBelongsToAgentGroup({
    projectId: input.wsTarget.projectId,
    group: input.wsTarget.group,
    role: input.subscription.role,
    target: input.subscription.target
  });
}

function auditContextForTarget(target: SlotTerminalWebSocketTarget): SlotTerminalAuditContext {
  if (target.kind === "requirement") {
    return {
      contextKind: "requirement",
      contextId: target.requirementId,
      requirementId: target.requirementId
    };
  }
  return {
    contextKind: "agent-group",
    contextId: target.group
  };
}

function buildReadyDescriptor(input: {
  target: SlotTerminalWebSocketTarget;
  subscription: SlotTerminalSubscription;
  activeIntervalMs: number;
  idleIntervalMs: number;
}): Record<string, unknown> {
  const base = {
    slotId: input.subscription.slotId,
    pane: input.subscription.role,
    target: input.subscription.target,
    source: "slot-terminal",
    readonly: false,
    polling: {
      activeMs: input.activeIntervalMs,
      idleMs: input.idleIntervalMs,
      hidden: "paused"
    }
  };

  if (input.target.kind === "requirement") {
    return {
      projectId: input.target.projectId,
      requirementId: input.target.requirementId,
      ...base
    };
  }

  return {
    projectId: input.target.projectId,
    group: input.target.group,
    ...base
  };
}

function parseInputAction(frame: { data?: unknown }): SlotTerminalClientFrameAction {
  if (typeof frame.data !== "string") {
    return { type: "send", payload: { type: "error", code: "BAD_FRAME", message: "input.data must be a string" } };
  }
  return {
    type: "input",
    data: frame.data
  };
}

function parsePasteAction(frame: { data?: unknown }): SlotTerminalClientFrameAction {
  if (typeof frame.data !== "string") {
    return { type: "send", payload: { type: "error", code: "BAD_FRAME", message: "paste.data must be a string" } };
  }
  return {
    type: "paste",
    data: frame.data
  };
}

function parseHintAction(frame: {
  type?: unknown;
  visibility?: unknown;
  state?: unknown;
  hidden?: unknown;
  visible?: unknown;
  active?: unknown;
}): SlotTerminalClientFrameAction {
  const visibility = normalizeVisibility(frame.visibility ?? frame.state, frame.hidden, frame.visible);
  const active = typeof frame.active === "boolean" ? frame.active : undefined;
  if (!visibility && typeof active !== "boolean") {
    return { type: "ignore" };
  }
  return {
    type: "hint",
    visibility,
    active
  };
}

function normalizeVisibility(
  value: unknown,
  hidden: unknown,
  visible: unknown
): SlotTerminalVisibility | undefined {
  if (value === "hidden" || value === "visible") {
    return value;
  }
  if (typeof hidden === "boolean") {
    return hidden ? "hidden" : "visible";
  }
  if (typeof visible === "boolean") {
    return visible ? "visible" : "hidden";
  }
  return undefined;
}

function parseFrame(raw: Buffer | string): {
  type?: unknown;
  visibility?: unknown;
  state?: unknown;
  hidden?: unknown;
  visible?: unknown;
  active?: unknown;
  data?: unknown;
} | null {
  try {
    const parsed = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8")) as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as {
          type?: unknown;
          visibility?: unknown;
          state?: unknown;
          hidden?: unknown;
          visible?: unknown;
          active?: unknown;
          data?: unknown;
        })
      : null;
  } catch {
    return null;
  }
}

function sendJson(socket: { send: (data: string) => void }, payload: unknown): void {
  try {
    socket.send(JSON.stringify(payload));
  } catch {
    // socket already closed
  }
}

function sendErrorAndClose(
  socket: { send: (data: string) => void; close: (code?: number, reason?: string) => void },
  code: string,
  message: string,
  closeCode: number
): void {
  try {
    socket.send(JSON.stringify({ type: "error", code, message }));
    socket.close(closeCode, message.slice(0, 120));
  } catch {
    // ignore
  }
}

function errorCode(error: unknown): string {
  if (error instanceof SlotTerminalInputTooLargeError) {
    return "INPUT_TOO_LARGE";
  }
  if (isSlotTerminalTargetForbiddenError(error)) {
    return "FORBIDDEN";
  }
  if (isSlotTerminalNotFoundError(error)) {
    return "NOT_FOUND";
  }
  return "INTERNAL";
}

function closeCode(error: unknown): number {
  if (isSlotTerminalTargetForbiddenError(error) || isSlotTerminalNotFoundError(error)) {
    return 1008;
  }
  return 1011;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

export function isSlotTerminalOriginAllowed(origin: unknown, allowedOrigins: readonly string[]): boolean {
  if (typeof origin !== "string") {
    return false;
  }
  const normalizedOrigin = origin.trim();
  if (!normalizedOrigin) {
    return false;
  }
  return allowedOrigins.some((allowed) => allowed.trim() === normalizedOrigin);
}

function getDefaultAllowedOrigins(): string[] {
  return (process.env.CCB_CORS_ALLOWED_ORIGINS ?? "http://localhost:5173,http://127.0.0.1:5173")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

class SlotTerminalInputTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SlotTerminalInputTooLargeError";
  }
}
