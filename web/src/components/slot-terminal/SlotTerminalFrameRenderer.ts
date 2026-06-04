import type { SlotTerminalSnapshotFrame } from "../../types/slot-terminal.js";

export const SLOT_TERMINAL_FULL_FRAME_CLEAR = "\x1b[H\x1b[2J";

export interface SlotTerminalWritableTerminal {
  buffer?: {
    active: {
      baseY: number;
      viewportY: number;
    };
  };
  scrollToBottom?(): void;
  resize(cols: number, rows: number): void;
  write(data: string, callback?: () => void): void;
}

export class SlotTerminalFrameRenderer {
  private readonly terminal: SlotTerminalWritableTerminal;
  private readonly scrollHost: HTMLElement | null;
  private pendingFrame: SlotTerminalSnapshotFrame | null = null;
  private animationFrame: number | null = null;
  private lastGeneration = 0;
  private lastFrameKey: string | null = null;
  private lastSizeKey: string | null = null;

  constructor(terminal: SlotTerminalWritableTerminal, scrollHost: HTMLElement | null = null) {
    this.terminal = terminal;
    this.scrollHost = scrollHost;
  }

  applyFrame(frame: SlotTerminalSnapshotFrame): void {
    if (frame.generation <= this.lastGeneration) {
      return;
    }
    const frameKey = `${frame.cols}x${frame.rows}\u0000${frame.data}`;
    if (frameKey === this.lastFrameKey) {
      this.lastGeneration = frame.generation;
      return;
    }
    this.pendingFrame = frame;
    if (this.animationFrame !== null) {
      return;
    }
    this.animationFrame = requestRenderFrame(() => {
      this.animationFrame = null;
      this.flush();
    });
  }

  dispose(): void {
    if (this.animationFrame !== null) {
      cancelRenderFrame(this.animationFrame);
      this.animationFrame = null;
    }
    this.pendingFrame = null;
  }

  private flush(): void {
    const frame = this.pendingFrame;
    if (!frame) {
      return;
    }
    this.pendingFrame = null;
    this.lastGeneration = frame.generation;
    this.lastFrameKey = `${frame.cols}x${frame.rows}\u0000${frame.data}`;
    const cols = normalizeTerminalDimension(frame.cols);
    const rows = normalizeTerminalDimension(frame.rows);
    const sizeKey = `${cols}x${rows}`;
    // 跟随判定必须在 resize 之前测：resize 会改变 xterm 行数与 host.scrollHeight，
    // 之后再测会把"原本贴底"误判成"已离底"。双底部 = xterm 历史在底 且 host 外滚在底。
    const shouldFollow = isTerminalAtBottom(this.terminal) && isHostAtBottom(this.scrollHost);
    if (sizeKey !== this.lastSizeKey) {
      this.terminal.resize(cols, rows);
      this.lastSizeKey = sizeKey;
    }
    const data = stripTrailingFrameNewline(frame.data);
    const payload = frame.initial ? data : `${SLOT_TERMINAL_FULL_FRAME_CLEAR}${data}`;
    this.terminal.write(payload, () => {
      if (shouldFollow) {
        this.terminal.scrollToBottom?.();
        if (this.scrollHost) {
          this.scrollHost.scrollTop = this.scrollHost.scrollHeight;
        }
      }
    });
  }
}

function stripTrailingFrameNewline(value: string): string {
  return value.replace(/\r?\n$/, "");
}

function isTerminalAtBottom(terminal: SlotTerminalWritableTerminal): boolean {
  const activeBuffer = terminal.buffer?.active;
  if (!activeBuffer) {
    return true;
  }
  return activeBuffer.viewportY >= activeBuffer.baseY;
}

// host 外层滚动是否在底部。无 host（旧调用 / 单测）时视为在底，保持向后兼容。
const HOST_AT_BOTTOM_EPSILON = 2;
function isHostAtBottom(host: HTMLElement | null): boolean {
  if (!host) {
    return true;
  }
  return host.scrollTop + host.clientHeight >= host.scrollHeight - HOST_AT_BOTTOM_EPSILON;
}

function normalizeTerminalDimension(value: number): number {
  return Math.max(1, Math.floor(Number.isFinite(value) ? value : 1));
}

function requestRenderFrame(callback: () => void): number {
  if (typeof requestAnimationFrame === "function") {
    return requestAnimationFrame(callback);
  }
  return window.setTimeout(callback, 16);
}

function cancelRenderFrame(handle: number): void {
  if (typeof cancelAnimationFrame === "function") {
    cancelAnimationFrame(handle);
    return;
  }
  window.clearTimeout(handle);
}
