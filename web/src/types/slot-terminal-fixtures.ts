import type { SlotTerminalFrame } from "./slot-terminal.js";

export const slotTerminalProtocolFixtureFrames = {
  legacySnapshot: {
    type: "frame",
    data: "\u001b[32mlegacy snapshot\u001b[0m\n",
    cols: 80,
    rows: 24,
    generation: 1,
    initial: true,
    mode: "snapshot-fallback"
  },
  explicitSnapshot: {
    type: "frame",
    kind: "snapshot",
    data: "explicit snapshot\n",
    cols: 80,
    rows: 24,
    generation: 2,
    initial: false,
    mode: "snapshot-fallback"
  },
  streamChunkA: {
    type: "frame",
    kind: "stream",
    data: "stream-a",
    seq: 101,
    mode: "stream"
  },
  streamChunkB: {
    type: "frame",
    kind: "stream",
    data: "\r\nstream-b",
    seq: 102,
    mode: "stream"
  },
  reset: {
    type: "frame",
    kind: "reset",
    reason: "gap",
    data: "\u001b[31mreset line\u001b[0m\nwide 中文\n",
    cols: 100,
    rows: 30,
    generation: 3,
    mode: "stream"
  }
} as const satisfies Record<string, SlotTerminalFrame>;

export const slotTerminalProtocolFixtureSequence = [
  slotTerminalProtocolFixtureFrames.legacySnapshot,
  slotTerminalProtocolFixtureFrames.explicitSnapshot,
  slotTerminalProtocolFixtureFrames.streamChunkA,
  slotTerminalProtocolFixtureFrames.streamChunkB,
  slotTerminalProtocolFixtureFrames.reset
] as const satisfies readonly SlotTerminalFrame[];
