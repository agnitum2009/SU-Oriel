import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  NodeSlotTerminalFifoBackend,
  SLOT_TERMINAL_STREAM_FIFO_PREFIX,
  SlotTerminalFifoError,
  SlotTerminalStreamRecorderRegistry,
  TmuxSlotTerminalStreamBackend,
  type SlotTerminalFifoBackend,
  type SlotTerminalFifoSource,
  type SlotTerminalPaneStreamTarget,
  type SlotTerminalStreamChunk,
  type SlotTerminalStreamErrorEvent,
  type SlotTerminalStreamGapEvent,
  type SlotTerminalStreamModeEvent,
  type SlotTerminalStreamTmuxBackend
} from "./slot-terminal-stream-recorder.js";

class ControlledFifoSource implements SlotTerminalFifoSource {
  readonly stream = new PassThrough();
  closed = false;

  constructor(public readonly path: string) {}

  async close(): Promise<void> {
    this.closed = true;
    this.stream.destroy();
  }

  push(chunk: Buffer | string): void {
    this.stream.emit("data", chunk);
  }

  fail(error: Error): void {
    this.stream.emit("error", error);
  }
}

class FakeFifoBackend implements SlotTerminalFifoBackend {
  readonly calls: string[];
  readonly sources: ControlledFifoSource[] = [];
  failNextOpen: Error | null = null;

  constructor(calls: string[]) {
    this.calls = calls;
  }

  async open(): Promise<SlotTerminalFifoSource> {
    this.calls.push("fifo:open");
    if (this.failNextOpen) {
      const error = this.failNextOpen;
      this.failNextOpen = null;
      throw error;
    }
    const source = new ControlledFifoSource(`/tmp/${SLOT_TERMINAL_STREAM_FIFO_PREFIX}${this.sources.length}/pipe`);
    this.sources.push(source);
    return source;
  }
}

class FakeTmuxBackend implements SlotTerminalStreamTmuxBackend {
  panePipes: string[] = [""];

  constructor(readonly calls: string[]) {}

  async getPanePipe(input: SlotTerminalPaneStreamTarget): Promise<string> {
    this.calls.push(`tmux:get:${input.socketPath ?? ""}:${input.target}`);
    return this.panePipes.length > 0 ? this.panePipes.shift() ?? "" : "";
  }

  async stopPipe(input: SlotTerminalPaneStreamTarget): Promise<void> {
    this.calls.push(`tmux:stop:${input.socketPath ?? ""}:${input.target}`);
  }

  async startPipe(input: SlotTerminalPaneStreamTarget & { fifoPath: string }): Promise<void> {
    this.calls.push(`tmux:start:${input.socketPath ?? ""}:${input.target}:${input.fifoPath}`);
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("slot-terminal stream recorder tmux backend", () => {
  it("uses display-message pane_pipe and pipe-pane commands against the slot tmux socket", async () => {
    const execFile = vi.fn(async () => ({ stdout: "cat > /tmp/existing\n", stderr: "" }));
    const backend = new TmuxSlotTerminalStreamBackend({ execFileProcess: execFile });

    await expect(backend.getPanePipe({ target: "%7", socketPath: "/tmp/tmux.sock" })).resolves.toBe("cat > /tmp/existing");
    await backend.stopPipe({ target: "%7", socketPath: "/tmp/tmux.sock" });
    await backend.startPipe({ target: "%7", socketPath: "/tmp/tmux.sock", fifoPath: "/tmp/pipe path/pipe" });

    expect(execFile).toHaveBeenNthCalledWith(1, "tmux", [
      "-S",
      "/tmp/tmux.sock",
      "display-message",
      "-p",
      "-t",
      "%7",
      "#{pane_pipe}"
    ]);
    expect(execFile).toHaveBeenNthCalledWith(2, "tmux", [
      "-S",
      "/tmp/tmux.sock",
      "pipe-pane",
      "-t",
      "%7"
    ]);
    expect(execFile).toHaveBeenNthCalledWith(3, "tmux", [
      "-S",
      "/tmp/tmux.sock",
      "pipe-pane",
      "-o",
      "-t",
      "%7",
      "cat > '/tmp/pipe path/pipe'"
    ]);
  });
});

describe("slot-terminal stream recorder registry", () => {
  it("shares one per-pane recorder, fans out chunks, and idle-closes after the final release", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const tmux = new FakeTmuxBackend(calls);
    const fifo = new FakeFifoBackend(calls);
    const firstChunks: SlotTerminalStreamChunk[] = [];
    const secondChunks: SlotTerminalStreamChunk[] = [];
    const registry = new SlotTerminalStreamRecorderRegistry({
      tmux,
      fifo,
      idleCloseMs: 100,
      retryMs: 100
    });

    const first = await registry.subscribe({
      target: "%7",
      socketPath: "/tmp/tmux.sock",
      callbacks: { onChunk: (chunk) => firstChunks.push(chunk) }
    });
    const second = await registry.subscribe({
      target: "%7",
      socketPath: "/tmp/tmux.sock",
      callbacks: { onChunk: (chunk) => secondChunks.push(chunk) }
    });

    fifo.sources[0].push("hello");

    expect(firstChunks).toEqual([{ kind: "stream", mode: "stream", seq: 1, data: "hello" }]);
    expect(secondChunks).toEqual(firstChunks);
    expect(registry.getDebugState({ target: "%7", socketPath: "/tmp/tmux.sock" })).toMatchObject({
      state: "streaming",
      refCount: 2,
      nextSeq: 2
    });
    expect(calls).toEqual([
      "tmux:get:/tmp/tmux.sock:%7",
      "tmux:stop:/tmp/tmux.sock:%7",
      "fifo:open",
      `tmux:start:/tmp/tmux.sock:%7:${fifo.sources[0].path}`
    ]);

    await first.release();
    await vi.advanceTimersByTimeAsync(100);
    expect(fifo.sources[0].closed).toBe(false);

    await second.release();
    await vi.advanceTimersByTimeAsync(100);

    expect(fifo.sources[0].closed).toBe(true);
    expect(calls.at(-1)).toBe("tmux:stop:/tmp/tmux.sock:%7");
    expect(registry.getDebugState({ target: "%7", socketPath: "/tmp/tmux.sock" })).toBeNull();
  });

  it("does not steal an occupied pane pipe and retries into stream mode after it is released", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const tmux = new FakeTmuxBackend(calls);
    tmux.panePipes = ["cat > /tmp/anchor-recording", ""];
    const fifo = new FakeFifoBackend(calls);
    const modes: SlotTerminalStreamModeEvent[] = [];
    const registry = new SlotTerminalStreamRecorderRegistry({
      tmux,
      fifo,
      retryMs: 50
    });

    const subscription = await registry.subscribe({
      target: "%7",
      callbacks: { onMode: (event) => modes.push(event) }
    });

    expect(modes).toEqual([
      {
        mode: "snapshot-fallback",
        reason: "pane-pipe-occupied",
        message: "tmux pane pipe is already occupied"
      }
    ]);
    expect(calls).toEqual(["tmux:get::%7"]);

    await vi.advanceTimersByTimeAsync(50);

    expect(modes.at(-1)).toEqual({ mode: "stream" });
    expect(calls).toEqual([
      "tmux:get::%7",
      "tmux:get::%7",
      "tmux:stop::%7",
      "fifo:open",
      `tmux:start::%7:${fifo.sources[0].path}`
    ]);
    await subscription.release();
    await registry.closeAll();
  });

  it("replays paused subscriptions from ring and reports a gap after the ring cap is exceeded", async () => {
    const calls: string[] = [];
    const tmux = new FakeTmuxBackend(calls);
    const fifo = new FakeFifoBackend(calls);
    const chunks: SlotTerminalStreamChunk[] = [];
    const gaps: SlotTerminalStreamGapEvent[] = [];
    const registry = new SlotTerminalStreamRecorderRegistry({
      tmux,
      fifo,
      ringBytes: 6
    });

    const subscription = await registry.subscribe({
      target: "%7",
      callbacks: {
        onChunk: (chunk) => chunks.push(chunk),
        onGap: (gap) => gaps.push(gap)
      }
    });
    subscription.pause();
    fifo.sources[0].push("abc");
    fifo.sources[0].push("def");
    subscription.resume();

    expect(chunks).toEqual([
      { kind: "stream", mode: "stream", seq: 1, data: "abc" },
      { kind: "stream", mode: "stream", seq: 2, data: "def" }
    ]);
    expect(gaps).toEqual([]);

    subscription.pause();
    fifo.sources[0].push("ghi");
    fifo.sources[0].push("jkl");
    fifo.sources[0].push("mno");
    subscription.resume();

    expect(gaps).toEqual([
      {
        reason: "ring-gap",
        fromSeq: 3,
        nextSeq: 6,
        message: "slot terminal stream ring no longer contains the requested cursor"
      }
    ]);
    expect(registry.getDebugState({ target: "%7" })).toMatchObject({
      ringOldestSeq: 4,
      ringNewestSeq: 5,
      ringBytes: 6
    });
    await subscription.release();
    await registry.closeAll();
  });

  it("decodes UTF-8 safely across source chunk boundaries", async () => {
    const calls: string[] = [];
    const tmux = new FakeTmuxBackend(calls);
    const fifo = new FakeFifoBackend(calls);
    const chunks: SlotTerminalStreamChunk[] = [];
    const registry = new SlotTerminalStreamRecorderRegistry({ tmux, fifo });
    const subscription = await registry.subscribe({
      target: "%7",
      callbacks: { onChunk: (chunk) => chunks.push(chunk) }
    });
    const encoded = Buffer.from("中文", "utf8");

    fifo.sources[0].push(encoded.subarray(0, 2));
    expect(chunks).toEqual([]);
    fifo.sources[0].push(encoded.subarray(2));

    expect(chunks).toEqual([{ kind: "stream", mode: "stream", seq: 1, data: "中文" }]);
    await subscription.release();
    await registry.closeAll();
  });

  it("clears a stale slot-terminal pipe before reopening during restart recovery", async () => {
    const calls: string[] = [];
    const tmux = new FakeTmuxBackend(calls);
    tmux.panePipes = [`cat > '/tmp/${SLOT_TERMINAL_STREAM_FIFO_PREFIX}old/pipe'`];
    const fifo = new FakeFifoBackend(calls);
    const registry = new SlotTerminalStreamRecorderRegistry({ tmux, fifo });
    const subscription = await registry.subscribe({ target: "%7", socketPath: "/tmp/tmux.sock" });

    expect(calls).toEqual([
      "tmux:get:/tmp/tmux.sock:%7",
      "tmux:stop:/tmp/tmux.sock:%7",
      "fifo:open",
      `tmux:start:/tmp/tmux.sock:%7:${fifo.sources[0].path}`
    ]);
    await subscription.release();
    await registry.closeAll();
  });

  it("emits errors, downgrades, and retries after FIFO setup or read failures", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const tmux = new FakeTmuxBackend(calls);
    tmux.panePipes = ["", ""];
    const fifo = new FakeFifoBackend(calls);
    fifo.failNextOpen = new SlotTerminalFifoError("mkfifo failed");
    const modes: SlotTerminalStreamModeEvent[] = [];
    const errors: SlotTerminalStreamErrorEvent[] = [];
    const registry = new SlotTerminalStreamRecorderRegistry({
      tmux,
      fifo,
      retryMs: 50
    });
    const subscription = await registry.subscribe({
      target: "%7",
      callbacks: {
        onMode: (event) => modes.push(event),
        onError: (event) => errors.push(event)
      }
    });

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ reason: "fifo-error" });
    expect(modes[0]).toMatchObject({ mode: "snapshot-fallback", reason: "fifo-error" });

    await vi.advanceTimersByTimeAsync(50);
    expect(modes.at(-1)).toEqual({ mode: "stream" });

    fifo.sources[0].fail(new Error("reader failed"));
    await vi.waitFor(() => expect(errors.at(-1)).toMatchObject({ reason: "stream-error" }));

    expect(errors.at(-1)).toMatchObject({ reason: "stream-error" });
    expect(modes.at(-1)).toMatchObject({ mode: "snapshot-fallback", reason: "stream-error" });
    expect(fifo.sources[0].closed).toBe(true);
    await subscription.release();
    await registry.closeAll();
  });
});

describe("slot-terminal stream FIFO backend", () => {
  it.runIf(process.platform !== "win32")("creates a real FIFO, reads bytes, and removes it on close", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "slot-terminal-fifo-test-"));
    const backend = new NodeSlotTerminalFifoBackend(tempDir);
    const source = await backend.open();
    const received = new Promise<Buffer>((resolve) => {
      source.stream.once("data", (chunk: Buffer) => resolve(chunk));
    });

    const writer = createWriteStream(source.path);
    writer.end(Buffer.from("fifo-ok", "utf8"));

    await expect(received).resolves.toEqual(Buffer.from("fifo-ok", "utf8"));
    await source.close();
    await expect(rm(source.path, { force: false })).rejects.toThrow();
    await rm(tempDir, { recursive: true, force: true });
  });
});
