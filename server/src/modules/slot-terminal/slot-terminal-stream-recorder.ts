import { execFile } from "node:child_process";
import { createReadStream, type ReadStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { promisify } from "node:util";
import type { Readable } from "node:stream";

const execFileAsync = promisify(execFile);

export const SLOT_TERMINAL_STREAM_RING_BYTES = 256 * 1024;
export const SLOT_TERMINAL_STREAM_IDLE_CLOSE_MS = 5 * 60 * 1000;
export const SLOT_TERMINAL_STREAM_RETRY_MS = 5_000;
export const SLOT_TERMINAL_STREAM_FIFO_PREFIX = "su-oriel-slot-terminal-stream-";

export type SlotTerminalStreamMode = "stream" | "snapshot-fallback";

export type SlotTerminalStreamDegradedReason =
  | "pane-pipe-occupied"
  | "fifo-error"
  | "tmux-error"
  | "stream-error"
  | "stream-closed";

export type SlotTerminalStreamGapReason = "ring-gap" | "degraded" | "closed";

export interface SlotTerminalStreamChunk {
  kind: "stream";
  mode: "stream";
  seq: number;
  data: string;
}

export interface SlotTerminalStreamModeEvent {
  mode: SlotTerminalStreamMode;
  reason?: SlotTerminalStreamDegradedReason;
  message?: string;
}

export interface SlotTerminalStreamGapEvent {
  reason: SlotTerminalStreamGapReason;
  fromSeq: number;
  nextSeq: number;
  message: string;
}

export interface SlotTerminalStreamErrorEvent {
  reason: SlotTerminalStreamDegradedReason;
  error: Error;
}

export interface SlotTerminalStreamCallbacks {
  onChunk?: (chunk: SlotTerminalStreamChunk) => void;
  onMode?: (event: SlotTerminalStreamModeEvent) => void;
  onGap?: (event: SlotTerminalStreamGapEvent) => void;
  onError?: (event: SlotTerminalStreamErrorEvent) => void;
}

export interface SlotTerminalPaneStreamTarget {
  target: string;
  socketPath?: string;
}

export interface SlotTerminalStreamSubscribeInput extends SlotTerminalPaneStreamTarget {
  callbacks?: SlotTerminalStreamCallbacks;
}

export interface SlotTerminalStreamTmuxBackend {
  getPanePipe(input: SlotTerminalPaneStreamTarget): Promise<string>;
  stopPipe(input: SlotTerminalPaneStreamTarget): Promise<void>;
  startPipe(input: SlotTerminalPaneStreamTarget & { fifoPath: string }): Promise<void>;
}

export interface SlotTerminalFifoSource {
  path: string;
  stream: Readable;
  close(): Promise<void>;
}

export interface SlotTerminalFifoBackend {
  open(): Promise<SlotTerminalFifoSource>;
}

export type SlotTerminalExecFileProcess = (
  command: string,
  args: string[]
) => Promise<{ stdout: string | Buffer; stderr: string | Buffer }>;

export class TmuxSlotTerminalStreamBackend implements SlotTerminalStreamTmuxBackend {
  private readonly tmuxCommand: string;
  private readonly execFileProcess: SlotTerminalExecFileProcess;

  constructor(options: { tmuxCommand?: string; execFileProcess?: SlotTerminalExecFileProcess } = {}) {
    this.tmuxCommand = options.tmuxCommand ?? "tmux";
    this.execFileProcess =
      options.execFileProcess ??
      (async (command, args) => {
        const result = await execFileAsync(command, args);
        return {
          stdout: result.stdout,
          stderr: result.stderr
        };
      });
  }

  async getPanePipe(input: SlotTerminalPaneStreamTarget): Promise<string> {
    const { stdout } = await this.execFileProcess(this.tmuxCommand, [
      ...socketArgs(input.socketPath),
      "display-message",
      "-p",
      "-t",
      input.target,
      "#{pane_pipe}"
    ]);
    return String(stdout).trim();
  }

  async stopPipe(input: SlotTerminalPaneStreamTarget): Promise<void> {
    await this.execFileProcess(this.tmuxCommand, [
      ...socketArgs(input.socketPath),
      "pipe-pane",
      "-t",
      input.target
    ]);
  }

  async startPipe(input: SlotTerminalPaneStreamTarget & { fifoPath: string }): Promise<void> {
    await this.execFileProcess(this.tmuxCommand, [
      ...socketArgs(input.socketPath),
      "pipe-pane",
      "-o",
      "-t",
      input.target,
      `cat > ${shellQuote(input.fifoPath)}`
    ]);
  }
}

export class NodeSlotTerminalFifoBackend implements SlotTerminalFifoBackend {
  constructor(private readonly baseDir: string = tmpdir()) {}

  async open(): Promise<SlotTerminalFifoSource> {
    const directory = await mkdtemp(join(this.baseDir, SLOT_TERMINAL_STREAM_FIFO_PREFIX));
    const fifoPath = join(directory, "pipe");
    try {
      await execFileAsync("mkfifo", [fifoPath]);
      const stream = createReadStream(fifoPath);
      return new NodeSlotTerminalFifoSource(fifoPath, directory, stream);
    } catch (error) {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
      throw new SlotTerminalFifoError(error instanceof Error ? error.message : String(error));
    }
  }
}

class NodeSlotTerminalFifoSource implements SlotTerminalFifoSource {
  constructor(
    public readonly path: string,
    private readonly directory: string,
    public readonly stream: ReadStream
  ) {}

  async close(): Promise<void> {
    this.stream.destroy();
    await rm(this.directory, { recursive: true, force: true });
  }
}

export interface SlotTerminalStreamRecorderRegistryOptions {
  tmux?: SlotTerminalStreamTmuxBackend;
  fifo?: SlotTerminalFifoBackend;
  ringBytes?: number;
  idleCloseMs?: number;
  retryMs?: number;
}

export interface SlotTerminalStreamRecorderDebugState {
  key: string;
  state: SlotTerminalStreamRecorderState;
  refCount: number;
  nextSeq: number;
  ringOldestSeq: number;
  ringNewestSeq: number;
  ringBytes: number;
  degradedReason?: SlotTerminalStreamDegradedReason;
}

export class SlotTerminalStreamRecorderRegistry {
  private readonly tmux: SlotTerminalStreamTmuxBackend;
  private readonly fifo: SlotTerminalFifoBackend;
  private readonly ringBytes: number;
  private readonly idleCloseMs: number;
  private readonly retryMs: number;
  private readonly recorders = new Map<string, SlotTerminalStreamRecorder>();

  constructor(options: SlotTerminalStreamRecorderRegistryOptions = {}) {
    this.tmux = options.tmux ?? new TmuxSlotTerminalStreamBackend();
    this.fifo = options.fifo ?? new NodeSlotTerminalFifoBackend();
    this.ringBytes = normalizePositiveInteger(options.ringBytes, SLOT_TERMINAL_STREAM_RING_BYTES);
    this.idleCloseMs = normalizePositiveInteger(options.idleCloseMs, SLOT_TERMINAL_STREAM_IDLE_CLOSE_MS);
    this.retryMs = normalizePositiveInteger(options.retryMs, SLOT_TERMINAL_STREAM_RETRY_MS);
  }

  async subscribe(input: SlotTerminalStreamSubscribeInput): Promise<SlotTerminalStreamSubscription> {
    const key = recorderKey(input);
    let recorder = this.recorders.get(key);
    if (!recorder || recorder.isClosed()) {
      recorder = new SlotTerminalStreamRecorder({
        key,
        target: input.target,
        socketPath: input.socketPath,
        tmux: this.tmux,
        fifo: this.fifo,
        ringBytes: this.ringBytes,
        idleCloseMs: this.idleCloseMs,
        retryMs: this.retryMs,
        onIdleClosed: (closedKey) => {
          if (this.recorders.get(closedKey) === recorder) {
            this.recorders.delete(closedKey);
          }
        }
      });
      this.recorders.set(key, recorder);
    }
    return await recorder.subscribe(input.callbacks ?? {});
  }

  getDebugState(input: SlotTerminalPaneStreamTarget): SlotTerminalStreamRecorderDebugState | null {
    return this.recorders.get(recorderKey(input))?.debugState() ?? null;
  }

  async closeAll(): Promise<void> {
    const recorders = [...this.recorders.values()];
    this.recorders.clear();
    await Promise.all(recorders.map((recorder) => recorder.close("registry close")));
  }
}

export class SlotTerminalStreamSubscription {
  private released = false;

  constructor(
    public readonly id: number,
    private readonly recorder: SlotTerminalStreamRecorder,
    private readonly callbacks: SlotTerminalStreamCallbacks,
    public cursor: number
  ) {}

  pause(): void {
    if (!this.released) {
      this.recorder.pause(this);
    }
  }

  resume(): void {
    if (!this.released) {
      this.recorder.resume(this);
    }
  }

  async release(): Promise<void> {
    if (this.released) {
      return;
    }
    this.released = true;
    await this.recorder.release(this);
  }

  emitChunk(chunk: SlotTerminalStreamChunk): void {
    this.callbacks.onChunk?.(chunk);
  }

  emitMode(event: SlotTerminalStreamModeEvent): void {
    this.callbacks.onMode?.(event);
  }

  emitGap(event: SlotTerminalStreamGapEvent): void {
    this.callbacks.onGap?.(event);
  }

  emitError(event: SlotTerminalStreamErrorEvent): void {
    this.callbacks.onError?.(event);
  }
}

type SlotTerminalStreamRecorderState = "idle" | "starting" | "streaming" | "degraded" | "closed";

interface RingChunk {
  seq: number;
  data: string;
  bytes: number;
}

interface SlotTerminalStreamRecorderOptions {
  key: string;
  target: string;
  socketPath?: string;
  tmux: SlotTerminalStreamTmuxBackend;
  fifo: SlotTerminalFifoBackend;
  ringBytes: number;
  idleCloseMs: number;
  retryMs: number;
  onIdleClosed: (key: string) => void;
}

class SlotTerminalStreamRecorder {
  private readonly key: string;
  private readonly target: string;
  private readonly socketPath: string | undefined;
  private readonly tmux: SlotTerminalStreamTmuxBackend;
  private readonly fifo: SlotTerminalFifoBackend;
  private readonly ringLimitBytes: number;
  private readonly idleCloseMs: number;
  private readonly retryMs: number;
  private readonly onIdleClosed: (key: string) => void;
  private readonly decoder = new StringDecoder("utf8");
  private readonly subscriptions = new Map<number, { subscription: SlotTerminalStreamSubscription; paused: boolean }>();
  private readonly ring: RingChunk[] = [];
  private ringTotalBytes = 0;
  private nextSubscriptionId = 1;
  private nextSeq = 1;
  private state: SlotTerminalStreamRecorderState = "idle";
  private degradedReason: SlotTerminalStreamDegradedReason | undefined;
  private startPromise: Promise<void> | null = null;
  private fifoSource: SlotTerminalFifoSource | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;

  constructor(options: SlotTerminalStreamRecorderOptions) {
    this.key = options.key;
    this.target = options.target;
    this.socketPath = options.socketPath;
    this.tmux = options.tmux;
    this.fifo = options.fifo;
    this.ringLimitBytes = options.ringBytes;
    this.idleCloseMs = options.idleCloseMs;
    this.retryMs = options.retryMs;
    this.onIdleClosed = options.onIdleClosed;
  }

  async subscribe(callbacks: SlotTerminalStreamCallbacks): Promise<SlotTerminalStreamSubscription> {
    this.cancelIdleClose();
    const currentMode = this.currentModeEvent();
    const subscription = new SlotTerminalStreamSubscription(
      this.nextSubscriptionId++,
      this,
      callbacks,
      this.nextSeq
    );
    this.subscriptions.set(subscription.id, { subscription, paused: false });
    if (currentMode) {
      subscription.emitMode(currentMode);
    }
    await this.ensureStarted();
    return subscription;
  }

  pause(subscription: SlotTerminalStreamSubscription): void {
    const record = this.subscriptions.get(subscription.id);
    if (record) {
      record.paused = true;
    }
  }

  resume(subscription: SlotTerminalStreamSubscription): void {
    const record = this.subscriptions.get(subscription.id);
    if (!record) {
      return;
    }
    if (this.state === "closed") {
      subscription.emitGap({
        reason: "closed",
        fromSeq: subscription.cursor,
        nextSeq: this.nextSeq,
        message: "slot terminal stream recorder is closed"
      });
      return;
    }
    if (this.state === "degraded") {
      subscription.emitGap({
        reason: "degraded",
        fromSeq: subscription.cursor,
        nextSeq: this.nextSeq,
        message: "slot terminal stream is degraded; caller should reset from snapshot"
      });
      subscription.cursor = this.nextSeq;
      record.paused = false;
      return;
    }
    const replay = this.replayFrom(subscription.cursor);
    if (replay.kind === "gap") {
      subscription.emitGap(replay.event);
      subscription.cursor = this.nextSeq;
      record.paused = false;
      return;
    }
    for (const chunk of replay.chunks) {
      subscription.emitChunk(toStreamChunk(chunk));
      subscription.cursor = chunk.seq + 1;
    }
    record.paused = false;
  }

  async release(subscription: SlotTerminalStreamSubscription): Promise<void> {
    this.subscriptions.delete(subscription.id);
    if (this.subscriptions.size === 0) {
      this.scheduleIdleClose();
    }
  }

  isClosed(): boolean {
    return this.state === "closed";
  }

  async close(_reason: string): Promise<void> {
    if (this.state === "closed") {
      return;
    }
    this.state = "closed";
    this.cancelIdleClose();
    this.cancelRetry();
    this.subscriptions.clear();
    await this.closePipeResources({ stopTmuxPipe: true });
  }

  debugState(): SlotTerminalStreamRecorderDebugState {
    return {
      key: this.key,
      state: this.state,
      refCount: this.subscriptions.size,
      nextSeq: this.nextSeq,
      ringOldestSeq: this.ring[0]?.seq ?? this.nextSeq,
      ringNewestSeq: this.ring.at(-1)?.seq ?? this.nextSeq - 1,
      ringBytes: this.ringTotalBytes,
      ...(this.degradedReason ? { degradedReason: this.degradedReason } : {})
    };
  }

  private async ensureStarted(): Promise<void> {
    if (this.state === "streaming" || this.state === "closed") {
      return;
    }
    if (this.startPromise) {
      await this.startPromise;
      return;
    }
    this.startPromise = this.startAttempt().finally(() => {
      this.startPromise = null;
    });
    await this.startPromise;
  }

  private async startAttempt(): Promise<void> {
    if (this.state === "closed" || this.subscriptions.size === 0) {
      return;
    }
    this.cancelRetry();
    this.state = "starting";
    this.degradedReason = undefined;
    await this.closePipeResources({ stopTmuxPipe: false });
    try {
      const panePipe = await this.tmux.getPanePipe(this.targetInput());
      if (panePipe && !isRecoverableSlotTerminalPipe(panePipe)) {
        this.enterDegraded("pane-pipe-occupied");
        return;
      }
      await this.tmux.stopPipe(this.targetInput());
      const source = await this.fifo.open();
      this.fifoSource = source;
      this.attachSource(source.stream);
      await this.tmux.startPipe({ ...this.targetInput(), fifoPath: source.path });
      this.state = "streaming";
      this.emitMode({ mode: "stream" });
    } catch (error) {
      const reason = isFifoError(error) ? "fifo-error" : "tmux-error";
      await this.closePipeResources({ stopTmuxPipe: true });
      this.enterDegraded(reason, error);
    }
  }

  private attachSource(stream: Readable): void {
    stream.on("data", (chunk: Buffer | string) => {
      const buffer = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      const decoded = this.decoder.write(buffer);
      if (decoded) {
        this.emitData(decoded);
      }
    });
    stream.once("error", (error: Error) => {
      void this.degradeFromStream("stream-error", error);
    });
    stream.once("close", () => {
      if (this.state === "streaming") {
        void this.degradeFromStream("stream-closed", new Error("slot terminal FIFO reader closed"));
      }
    });
    stream.once("end", () => {
      if (this.state === "streaming") {
        void this.degradeFromStream("stream-closed", new Error("slot terminal FIFO reader ended"));
      }
    });
  }

  private emitData(data: string): void {
    if (this.state !== "streaming" || !data) {
      return;
    }
    const chunk: RingChunk = {
      seq: this.nextSeq++,
      data,
      bytes: Buffer.byteLength(data, "utf8")
    };
    this.pushRing(chunk);
    for (const record of this.subscriptions.values()) {
      if (record.paused || record.subscription.cursor > chunk.seq) {
        continue;
      }
      record.subscription.emitChunk(toStreamChunk(chunk));
      record.subscription.cursor = chunk.seq + 1;
    }
  }

  private pushRing(chunk: RingChunk): void {
    this.ring.push(chunk);
    this.ringTotalBytes += chunk.bytes;
    while (this.ring.length > 1 && this.ringTotalBytes > this.ringLimitBytes) {
      const removed = this.ring.shift();
      if (removed) {
        this.ringTotalBytes -= removed.bytes;
      }
    }
  }

  private replayFrom(cursor: number): { kind: "chunks"; chunks: RingChunk[] } | { kind: "gap"; event: SlotTerminalStreamGapEvent } {
    if (cursor >= this.nextSeq) {
      return { kind: "chunks", chunks: [] };
    }
    const oldestSeq = this.ring[0]?.seq ?? this.nextSeq;
    if (cursor < oldestSeq) {
      return {
        kind: "gap",
        event: {
          reason: "ring-gap",
          fromSeq: cursor,
          nextSeq: this.nextSeq,
          message: "slot terminal stream ring no longer contains the requested cursor"
        }
      };
    }
    return {
      kind: "chunks",
      chunks: this.ring.filter((chunk) => chunk.seq >= cursor)
    };
  }

  private async degradeFromStream(reason: SlotTerminalStreamDegradedReason, error: Error): Promise<void> {
    if (this.state !== "streaming") {
      return;
    }
    await this.closePipeResources({ stopTmuxPipe: true });
    this.enterDegraded(reason, error);
  }

  private enterDegraded(reason: SlotTerminalStreamDegradedReason, error?: unknown): void {
    if (this.state === "closed") {
      return;
    }
    this.state = "degraded";
    this.degradedReason = reason;
    const normalizedError = errorToError(error ?? new Error(degradedMessage(reason)));
    if (error) {
      this.emitError({ reason, error: normalizedError });
    }
    this.emitMode({
      mode: "snapshot-fallback",
      reason,
      message: normalizedError.message
    });
    this.scheduleRetry();
  }

  private emitMode(event: SlotTerminalStreamModeEvent): void {
    for (const { subscription } of this.subscriptions.values()) {
      subscription.emitMode(event);
    }
  }

  private currentModeEvent(): SlotTerminalStreamModeEvent | null {
    if (this.state === "streaming") {
      return { mode: "stream" };
    }
    if (this.state === "degraded") {
      return {
        mode: "snapshot-fallback",
        reason: this.degradedReason,
        message: this.degradedReason ? degradedMessage(this.degradedReason) : "slot terminal stream is degraded"
      };
    }
    return null;
  }

  private emitError(event: SlotTerminalStreamErrorEvent): void {
    for (const { subscription } of this.subscriptions.values()) {
      subscription.emitError(event);
    }
  }

  private async closePipeResources(options: { stopTmuxPipe: boolean }): Promise<void> {
    const source = this.fifoSource;
    this.fifoSource = null;
    if (source) {
      source.stream.removeAllListeners("data");
      source.stream.removeAllListeners("error");
      source.stream.removeAllListeners("close");
      source.stream.removeAllListeners("end");
      await source.close().catch(() => undefined);
      this.decoder.end();
    }
    if (options.stopTmuxPipe) {
      await this.tmux.stopPipe(this.targetInput()).catch(() => undefined);
    }
  }

  private scheduleIdleClose(): void {
    this.cancelIdleClose();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      void this.close("idle timeout").then(() => this.onIdleClosed(this.key));
    }, this.idleCloseMs);
    this.idleTimer.unref?.();
  }

  private cancelIdleClose(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private scheduleRetry(): void {
    if (this.retryTimer || this.state === "closed" || this.subscriptions.size === 0) {
      return;
    }
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.ensureStarted();
    }, this.retryMs);
    this.retryTimer.unref?.();
  }

  private cancelRetry(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private targetInput(): SlotTerminalPaneStreamTarget {
    return {
      target: this.target,
      ...(this.socketPath ? { socketPath: this.socketPath } : {})
    };
  }
}

function socketArgs(socketPath: string | undefined): string[] {
  return socketPath ? ["-S", socketPath] : [];
}

function recorderKey(input: SlotTerminalPaneStreamTarget): string {
  return `${input.socketPath ?? ""}\u0000${input.target}`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.floor(value);
}

function isRecoverableSlotTerminalPipe(panePipe: string): boolean {
  return panePipe.includes(SLOT_TERMINAL_STREAM_FIFO_PREFIX);
}

function isFifoError(error: unknown): boolean {
  return error instanceof SlotTerminalFifoError || (error instanceof Error && error.name === "SlotTerminalFifoError");
}

function errorToError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function degradedMessage(reason: SlotTerminalStreamDegradedReason): string {
  switch (reason) {
    case "pane-pipe-occupied":
      return "tmux pane pipe is already occupied";
    case "fifo-error":
      return "slot terminal FIFO setup failed";
    case "tmux-error":
      return "slot terminal tmux pipe setup failed";
    case "stream-error":
      return "slot terminal FIFO stream failed";
    case "stream-closed":
      return "slot terminal FIFO stream closed";
  }
}

function toStreamChunk(chunk: RingChunk): SlotTerminalStreamChunk {
  return {
    kind: "stream",
    mode: "stream",
    seq: chunk.seq,
    data: chunk.data
  };
}

export class SlotTerminalFifoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SlotTerminalFifoError";
  }
}
