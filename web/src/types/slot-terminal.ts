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

export interface SlotTerminalSnapshotFrame {
  type: "frame";
  data: string;
  cols: number;
  rows: number;
  generation: number;
  initial: boolean;
}

export interface SlotTerminalErrorFrame {
  type: "error";
  code: string;
  message: string;
}

export interface SlotTerminalPongFrame {
  type: "pong";
}

export type SlotTerminalServerFrame =
  | SlotTerminalReadyFrame
  | SlotTerminalSnapshotFrame
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
      return parseSnapshotFrame(frame);
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
    initial: frame.initial
  };
}

function isSlotTerminalPaneRole(value: unknown): value is SlotTerminalPaneRole {
  return value === "claude" || value === "codex";
}
