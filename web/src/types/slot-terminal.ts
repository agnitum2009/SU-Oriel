export type SlotTerminalPaneRole = "claude" | "codex";

export const SLOT_TERMINAL_ROLES: SlotTerminalPaneRole[] = ["claude", "codex"];

export type SlotTerminalTarget =
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

interface SlotTerminalReadyDescriptorBase {
  projectId: string;
  slotId: string;
  pane: SlotTerminalPaneRole;
  target: string;
  source: "slot-terminal";
  readonly: false;
  polling: {
    activeMs: number;
    idleMs: number;
    hidden: "paused";
  };
}

export type SlotTerminalReadyDescriptor =
  | (SlotTerminalReadyDescriptorBase & {
      requirementId: string;
    })
  | (SlotTerminalReadyDescriptorBase & {
      group: string;
    });

export interface SlotTerminalPaneTarget {
  role: SlotTerminalPaneRole;
  target: string;
  paneIndex: number;
}

export interface SlotTerminalDescriptor {
  slotId: string;
  sessionName: string;
  panes: SlotTerminalPaneTarget[];
}

export interface SlotTerminalReadyFrame {
  type: "ready";
  descriptor: SlotTerminalReadyDescriptor;
}

export type SlotTerminalFrameMode = "stream" | "snapshot-fallback";

export interface SlotTerminalSnapshotFrame {
  type: "frame";
  kind?: "snapshot";
  data: string;
  cols: number;
  rows: number;
  generation: number;
  initial: boolean;
  mode?: SlotTerminalFrameMode;
}

export interface SlotTerminalStreamFrame {
  type: "frame";
  kind: "stream";
  data: string;
  seq?: number;
  mode?: SlotTerminalFrameMode;
}

export type SlotTerminalResetReason = "resize" | "gap" | "error" | "reconcile";

export interface SlotTerminalResetFrame {
  type: "frame";
  kind: "reset";
  reason: SlotTerminalResetReason;
  data: string;
  cols: number;
  rows: number;
  generation: number;
  initial?: boolean;
  mode?: SlotTerminalFrameMode;
}

export interface SlotTerminalErrorFrame {
  type: "error";
  code: string;
  message: string;
}

export interface SlotTerminalPongFrame {
  type: "pong";
}

export type SlotTerminalFrame =
  | SlotTerminalSnapshotFrame
  | SlotTerminalStreamFrame
  | SlotTerminalResetFrame;

export type SlotTerminalServerFrame =
  | SlotTerminalReadyFrame
  | SlotTerminalFrame
  | SlotTerminalErrorFrame
  | SlotTerminalPongFrame;

export type SlotTerminalClientFrame =
  | { type: "visibility"; state: "hidden" | "visible" }
  | { type: "active"; active: boolean }
  | { type: "hint"; visible?: boolean; active?: boolean }
  | { type: "viewport"; active?: boolean }
  | { type: "input"; data: string }
  | { type: "paste"; data: string }
  | { type: "ping" }
  | { type: "close" };

export const SLOT_TERMINAL_SERVER_FRAME_TYPES = ["ready", "frame", "error", "pong"] as const;
export const SLOT_TERMINAL_CLIENT_FRAME_TYPES = [
  "visibility",
  "active",
  "hint",
  "viewport",
  "input",
  "paste",
  "ping",
  "close"
] as const;

export function parseSlotTerminalServerFrame(raw: string | ArrayBuffer | Blob): SlotTerminalServerFrame | null {
  if (raw instanceof Blob) {
    return null;
  }
  const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") {
    return null;
  }
  const frame = parsed as Record<string, unknown>;
  switch (frame.type) {
    case "ready":
      return parseReadyFrame(frame);
    case "frame":
      return parseFrame(frame);
    case "error":
      return typeof frame.code === "string" && typeof frame.message === "string"
        ? { type: "error", code: frame.code, message: frame.message }
        : null;
    case "pong":
      return { type: "pong" };
    default:
      return null;
  }
}

function parseFrame(frame: Record<string, unknown>): SlotTerminalFrame | null {
  switch (frame.kind) {
    case "stream":
      return parseStreamFrame(frame);
    case "reset":
      return parseResetFrame(frame);
    case "snapshot":
    case undefined:
      return parseSnapshotFrame(frame);
    default:
      return null;
  }
}

function parseReadyFrame(frame: Record<string, unknown>): SlotTerminalReadyFrame | null {
  const descriptor = frame.descriptor;
  if (!descriptor || typeof descriptor !== "object") {
    return null;
  }
  const value = descriptor as Record<string, unknown>;
  const polling = value.polling;
  if (!polling || typeof polling !== "object") {
    return null;
  }
  const pollingValue = polling as Record<string, unknown>;
  if (
    typeof value.projectId !== "string" ||
    typeof value.slotId !== "string" ||
    !isSlotTerminalPaneRole(value.pane) ||
    typeof value.target !== "string" ||
    value.source !== "slot-terminal" ||
    value.readonly !== false ||
    typeof pollingValue.activeMs !== "number" ||
    typeof pollingValue.idleMs !== "number" ||
    pollingValue.hidden !== "paused"
  ) {
    return null;
  }

  const descriptorBase = {
    projectId: value.projectId,
    slotId: value.slotId,
    pane: value.pane,
    target: value.target,
    source: "slot-terminal" as const,
    readonly: false as const,
    polling: {
      activeMs: pollingValue.activeMs,
      idleMs: pollingValue.idleMs,
      hidden: "paused" as const
    }
  };

  if (typeof value.requirementId === "string") {
    return {
      type: "ready",
      descriptor: {
        ...descriptorBase,
        requirementId: value.requirementId
      }
    };
  }
  if (typeof value.group === "string") {
    return {
      type: "ready",
      descriptor: {
        ...descriptorBase,
        group: value.group
      }
    };
  }
  return null;
}

function parseSnapshotFrame(frame: Record<string, unknown>): SlotTerminalSnapshotFrame | null {
  if (
    (frame.kind !== undefined && frame.kind !== "snapshot") ||
    typeof frame.data !== "string" ||
    typeof frame.cols !== "number" ||
    typeof frame.rows !== "number" ||
    typeof frame.generation !== "number" ||
    typeof frame.initial !== "boolean"
  ) {
    return null;
  }
  return {
    type: "frame",
    data: frame.data,
    cols: frame.cols,
    rows: frame.rows,
    generation: frame.generation,
    initial: frame.initial,
    ...(frame.kind === "snapshot" ? { kind: "snapshot" as const } : {}),
    ...(isSlotTerminalFrameMode(frame.mode) ? { mode: frame.mode } : {})
  };
}

function parseStreamFrame(frame: Record<string, unknown>): SlotTerminalStreamFrame | null {
  if (typeof frame.data !== "string") {
    return null;
  }
  if (frame.seq !== undefined && typeof frame.seq !== "number") {
    return null;
  }
  return {
    type: "frame",
    kind: "stream",
    data: frame.data,
    ...(typeof frame.seq === "number" ? { seq: frame.seq } : {}),
    ...(isSlotTerminalFrameMode(frame.mode) ? { mode: frame.mode } : {})
  };
}

function parseResetFrame(frame: Record<string, unknown>): SlotTerminalResetFrame | null {
  if (
    !isSlotTerminalResetReason(frame.reason) ||
    typeof frame.data !== "string" ||
    typeof frame.cols !== "number" ||
    typeof frame.rows !== "number" ||
    typeof frame.generation !== "number"
  ) {
    return null;
  }
  if (frame.initial !== undefined && typeof frame.initial !== "boolean") {
    return null;
  }
  return {
    type: "frame",
    kind: "reset",
    reason: frame.reason,
    data: frame.data,
    cols: frame.cols,
    rows: frame.rows,
    generation: frame.generation,
    ...(typeof frame.initial === "boolean" ? { initial: frame.initial } : {}),
    ...(isSlotTerminalFrameMode(frame.mode) ? { mode: frame.mode } : {})
  };
}

function isSlotTerminalPaneRole(value: unknown): value is SlotTerminalPaneRole {
  return value === "claude" || value === "codex";
}

function isSlotTerminalFrameMode(value: unknown): value is SlotTerminalFrameMode {
  return value === "stream" || value === "snapshot-fallback";
}

function isSlotTerminalResetReason(value: unknown): value is SlotTerminalResetReason {
  return value === "resize" || value === "gap" || value === "error" || value === "reconcile";
}
