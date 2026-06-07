import type {
  SlotTerminalFrame,
  SlotTerminalResetFrame,
  SlotTerminalSnapshotFrame
} from "../../types/slot-terminal.js";

export const SLOT_TERMINAL_FULL_FRAME_CLEAR = "\x1b[H\x1b[2J";

export interface SlotTerminalWritableTerminal {
  buffer?: {
    active: {
      baseY: number;
      viewportY: number;
    };
  };
  reset(): void;
  scrollToBottom?(): void;
  resize(cols: number, rows: number): void;
  write(data: string, callback?: () => void): void;
}

type SlotTerminalStructuralFrame = SlotTerminalSnapshotFrame | SlotTerminalResetFrame;

interface TerminalWriteOperation {
  data: string;
  prepare?: () => boolean;
}

export class SlotTerminalFrameRenderer {
  private readonly terminal: SlotTerminalWritableTerminal;
  private readonly scrollHost: HTMLElement | null;
  private pendingFrame: SlotTerminalStructuralFrame | null = null;
  private animationFrame: number | null = null;
  private writeQueue: TerminalWriteOperation[] = [];
  private writeActive = false;
  private disposed = false;
  private lastGeneration = 0;
  private lastFrameKey: string | null = null;
  private lastSizeKey: string | null = null;

  constructor(terminal: SlotTerminalWritableTerminal, scrollHost: HTMLElement | null = null) {
    this.terminal = terminal;
    this.scrollHost = scrollHost;
  }

  applyFrame(frame: SlotTerminalFrame): void {
    if (this.disposed) {
      return;
    }
    if (frame.kind === "stream") {
      this.flushPendingFrame();
      this.enqueueWrite({ data: frame.data });
      return;
    }
    this.scheduleStructuralFrame(frame);
  }

  dispose(): void {
    this.disposed = true;
    if (this.animationFrame !== null) {
      cancelRenderFrame(this.animationFrame);
      this.animationFrame = null;
    }
    this.pendingFrame = null;
    this.writeQueue = [];
  }

  private scheduleStructuralFrame(frame: SlotTerminalStructuralFrame): void {
    if (frame.generation <= this.lastGeneration) {
      return;
    }
    if (this.pendingFrame && isResetFrame(this.pendingFrame) && !isResetFrame(frame)) {
      this.flushPendingFrame();
    }
    const frameKey = `${frame.cols}x${frame.rows}\u0000${frame.data}`;
    if (!isResetFrame(frame) && frameKey === this.lastFrameKey) {
      this.lastGeneration = frame.generation;
      return;
    }
    this.pendingFrame = frame;
    this.lastGeneration = frame.generation;
    if (this.animationFrame !== null) {
      return;
    }
    this.animationFrame = requestRenderFrame(() => {
      this.animationFrame = null;
      this.flush();
    });
  }

  private flushPendingFrame(): void {
    if (this.animationFrame !== null) {
      cancelRenderFrame(this.animationFrame);
      this.animationFrame = null;
    }
    this.flush();
  }

  private flush(): void {
    const frame = this.pendingFrame;
    if (!frame) {
      return;
    }
    this.pendingFrame = null;
    this.lastFrameKey = `${frame.cols}x${frame.rows}\u0000${frame.data}`;
    const cols = normalizeTerminalDimension(frame.cols);
    const rows = normalizeTerminalDimension(frame.rows);
    const sizeKey = `${cols}x${rows}`;
    const data = stripTrailingFrameNewline(frame.data);
    const shouldReset = isResetFrame(frame) || frame.initial;
    const payload = shouldReset ? data : `${SLOT_TERMINAL_FULL_FRAME_CLEAR}${data}`;
    this.enqueueWrite({
      data: payload,
      prepare: () => {
        // 跟随判定必须在 reset/resize 之前测：resize 会改变 xterm 行数与 host.scrollHeight，
        // 之后再测会把"原本贴底"误判成"已离底"。双底部 = xterm 历史在底 且 host 外滚在底。
        const shouldFollow = this.shouldFollow();
        if (shouldReset) {
          this.terminal.reset();
          this.lastSizeKey = null;
        }
        if (sizeKey !== this.lastSizeKey) {
          this.terminal.resize(cols, rows);
          this.lastSizeKey = sizeKey;
        }
        return shouldFollow;
      }
    });
  }

  private enqueueWrite(operation: TerminalWriteOperation): void {
    this.writeQueue.push(operation);
    this.drainWriteQueue();
  }

  private drainWriteQueue(): void {
    if (this.writeActive || this.disposed) {
      return;
    }
    const operation = this.writeQueue.shift();
    if (!operation) {
      return;
    }
    this.writeActive = true;
    const shouldFollow = operation.prepare?.() ?? this.shouldFollow();
    this.terminal.write(operation.data, () => {
      if (!this.disposed && shouldFollow) {
        this.followToBottom();
      }
      this.writeActive = false;
      this.drainWriteQueue();
    });
  }

  private shouldFollow(): boolean {
    return isTerminalAtBottom(this.terminal) && isHostAtBottom(this.scrollHost);
  }

  private followToBottom(): void {
    this.terminal.scrollToBottom?.();
    if (this.scrollHost) {
      this.scrollHost.scrollTop = this.scrollHost.scrollHeight;
    }
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

function isResetFrame(frame: SlotTerminalStructuralFrame): frame is SlotTerminalResetFrame {
  return frame.kind === "reset";
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
