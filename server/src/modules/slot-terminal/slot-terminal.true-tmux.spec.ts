import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import { TmuxSlotTerminalFrameCapture } from "./slot-terminal.frame-stream.js";
import { registerSlotTerminalWebSocketRoutes } from "./slot-terminal.ws.js";
import {
  SLOT_TERMINAL_STREAM_FIFO_PREFIX,
  SlotTerminalStreamRecorderRegistry,
  TmuxSlotTerminalStreamBackend,
  type SlotTerminalPaneStreamTarget,
  type SlotTerminalStreamChunk,
  type SlotTerminalStreamGapEvent,
  type SlotTerminalStreamModeEvent,
  type SlotTerminalStreamTmuxBackend
} from "./slot-terminal-stream-recorder.js";
import { TmuxSlotTerminalRuntimeResolver } from "./slot-terminal.service.js";
import type {
  SlotTerminalBinding,
  SlotTerminalDescriptor,
  SlotTerminalPaneTarget,
  SlotTerminalProject,
  SlotTerminalStore
} from "./slot-terminal.service.js";

const execFileAsync = promisify(execFile);
const tmuxAvailable = await isTmuxAvailable();
const itWithTmux = tmuxAvailable ? it : it.skip;
const ALLOWED_ORIGIN = "http://localhost:5173";
const SCROLLBACK_CAP = 2_500;
const RECONCILED_TAIL_LINES = 2_000;

class TrueTmuxHarness {
  readonly sessionName =
    "ccb-realtime_translator-" + process.pid + "-" + Date.now() + "-" + Math.random().toString(36).slice(2);
  readonly socketPath: string;
  paneId = "";

  private constructor(readonly projectRoot: string) {
    this.socketPath = join(projectRoot, ".ccb", "ccbd", "tmux.sock");
  }

  static async start(): Promise<TrueTmuxHarness> {
    const projectRoot = await mkdtemp(join(tmpdir(), "slot-terminal-true-tmux-"));
    const harness = new TrueTmuxHarness(projectRoot);
    await mkdir(dirname(harness.socketPath), { recursive: true });
    await harness.tmux([
      "new-session",
      "-d",
      "-s",
      harness.sessionName,
      "-x",
      "100",
      "-y",
      "30",
      "bash -lc 'stty -echo; while IFS= read -r line; do printf \"%s\\n\" \"$line\"; done'"
    ]);
    await harness.tmux(["set-option", "-w", "-t", harness.sessionName, "history-limit", "6000"]);
    await harness.tmux(["rename-window", "-t", harness.sessionName, "slot-1"]);
    harness.paneId = await harness.resolvePaneId();
    return harness;
  }

  async close(): Promise<void> {
    await this.tmux(["kill-server"]).catch(() => undefined);
    await rm(this.projectRoot, { recursive: true, force: true });
  }

  async tmux(args: string[]): Promise<string> {
    const { stdout } = await execFileAsync("tmux", ["-S", this.socketPath, ...args], {
      maxBuffer: 8 * 1024 * 1024
    });
    return String(stdout);
  }

  async sendLines(lines: string[]): Promise<void> {
    const bufferName = "slot-test-" + Date.now() + "-" + Math.random().toString(36).slice(2);
    const bufferPath = join(this.projectRoot, bufferName + ".txt");
    await writeFile(bufferPath, lines.join("\n") + "\n", "utf8");
    try {
      await this.tmux(["load-buffer", "-b", bufferName, bufferPath]);
      await this.tmux(["paste-buffer", "-p", "-b", bufferName, "-t", this.paneId]);
    } finally {
      await this.tmux(["delete-buffer", "-b", bufferName]).catch(() => undefined);
      await rm(bufferPath, { force: true }).catch(() => undefined);
    }
  }

  async capturePane(start = 3000): Promise<string> {
    return await this.tmux([
      "capture-pane",
      "-p",
      "-e",
      "-S",
      "-" + String(start),
      "-t",
      this.paneId
    ]);
  }

  async panePipe(): Promise<string> {
    return (await this.tmux(["display-message", "-p", "-t", this.paneId, "#{pane_pipe}"])).trim();
  }

  async panePipeState(): Promise<string> {
    return await this.tmux(["display-message", "-p", "-t", this.paneId, "#{pane_pipe}\t#{@slot_terminal_pipe}"]);
  }

  async pipeOwner(): Promise<string> {
    const state = await this.panePipeState();
    return state.replace(/\r?\n$/, "").split("\t")[1] ?? "";
  }

  async waitForPaneLine(line: string): Promise<void> {
    await waitFor(async () => (await this.capturePane()).includes(line), "tmux pane did not contain " + line);
  }

  private async resolvePaneId(): Promise<string> {
    const stdout = await this.tmux(["list-panes", "-t", this.sessionName, "-F", "#{pane_id}"]);
    const paneId = stdout.trim().split(/\r?\n/)[0];
    if (!paneId?.startsWith("%")) {
      throw new Error("expected tmux pane id, got " + stdout);
    }
    return paneId;
  }
}

class RecordingTmuxBackend implements SlotTerminalStreamTmuxBackend {
  readonly calls: string[] = [];
  private readonly delegate = new TmuxSlotTerminalStreamBackend();

  async getPanePipe(input: SlotTerminalPaneStreamTarget): Promise<string> {
    this.calls.push("getPanePipe");
    return await this.delegate.getPanePipe(input);
  }

  async stopPipe(input: SlotTerminalPaneStreamTarget): Promise<void> {
    this.calls.push("stopPipe");
    await this.delegate.stopPipe(input);
  }

  async startPipe(input: SlotTerminalPaneStreamTarget & { fifoPath: string }): Promise<void> {
    this.calls.push("startPipe");
    await this.delegate.startPipe(input);
  }

  async setPipeOwner(input: SlotTerminalPaneStreamTarget & { fifoPath: string }): Promise<void> {
    this.calls.push("setPipeOwner");
    await this.delegate.setPipeOwner(input);
  }

  async clearPipeOwner(input: SlotTerminalPaneStreamTarget): Promise<void> {
    this.calls.push("clearPipeOwner");
    await this.delegate.clearPipeOwner(input);
  }
}

class FakeSlotTerminalStore implements SlotTerminalStore {
  constructor(
    private readonly projectRoot: string,
    private readonly pane: SlotTerminalPaneTarget,
    private readonly sessionName: string
  ) {}

  async findProject(projectId: string): Promise<SlotTerminalProject | null> {
    return projectId === "project-1" ? { id: projectId, localPath: this.projectRoot } : null;
  }

  async findProjectIdForRequirement(requirementId: string): Promise<string | null> {
    return requirementId === "req-1" ? "project-1" : null;
  }

  async findBindingForRequirement(): Promise<SlotTerminalBinding | null> {
    return { projectId: "project-1", requirementId: "req-1", slotId: "slot-1", state: "bound" } as SlotTerminalBinding;
  }

  descriptor(): SlotTerminalDescriptor {
    return {
      slotId: "slot-1",
      sessionName: this.sessionName,
      panes: [this.pane]
    };
  }
}

function buildTrueTmuxWebSocketApp(input: {
  harness: TrueTmuxHarness;
  streamRecorder: SlotTerminalStreamRecorderRegistry;
}) {
  const pane: SlotTerminalPaneTarget = { role: "claude", target: input.harness.paneId, paneIndex: 0 };
  const store = new FakeSlotTerminalStore(input.harness.projectRoot, pane, input.harness.sessionName);
  const descriptor = store.descriptor();
  const service = {
    resolveRequirementTerminal: async () => descriptor,
    assertTargetBelongsTo: async () => pane,
    resolveAgentGroupTerminal: async () => descriptor,
    assertTargetBelongsToAgentGroup: async () => pane
  };
  const app = Fastify();
  void app.register(websocket);
  void app.register(registerSlotTerminalWebSocketRoutes, {
    store,
    service,
    capture: new TmuxSlotTerminalFrameCapture(),
    streamRecorder: input.streamRecorder,
    activeIntervalMs: 10_000,
    idleIntervalMs: 10_000,
    allowedOrigins: [ALLOWED_ORIGIN]
  });
  return app;
}

async function writeRuntime(projectRoot: string, agentName: string, record: Record<string, unknown>): Promise<void> {
  const agentDir = join(projectRoot, ".ccb", "agents", agentName);
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "runtime.json"), JSON.stringify(record, null, 2), "utf8");
}

describe("slot-terminal true tmux integration", () => {
  itWithTmux("resolves runtime pane metadata from a non-SU-CCB tmux session", async () => {
    await withHarness(async (harness) => {
      await writeRuntime(harness.projectRoot, "slot1_claude", {
        agent_name: "slot1_claude",
        provider: "claude",
        tmux_window_name: "slot-1",
        pane_id: harness.paneId
      });
      const resolver = new TmuxSlotTerminalRuntimeResolver();

      const resolved = await resolver.resolveSlotPanes({
        projectRoot: harness.projectRoot,
        slotId: "slot-1"
      });

      expect(resolved.sessionName).toBe(harness.sessionName);
      expect(resolved.panes).toHaveLength(1);
      expect(resolved.panes[0]).toMatchObject({ role: "claude", target: harness.paneId });
      expect(Number.isInteger(resolved.panes[0]?.paneIndex)).toBe(true);
    });
  }, 15_000);

  itWithTmux("streams all lines emitted after connection from a real tmux pane", async () => {
    await withHarness(async (harness) => {
      const registry = new SlotTerminalStreamRecorderRegistry();
      const chunks: SlotTerminalStreamChunk[] = [];
      const subscription = await registry.subscribe({
        target: harness.paneId,
        socketPath: harness.socketPath,
        callbacks: { onChunk: (chunk) => chunks.push(chunk) }
      });
      const lines = numberedLines("runtime-history", 40);

      await harness.sendLines(lines);
      await waitForLines(chunks, "runtime-history-", lines.length);

      expect(linesWithPrefix(chunks.map((chunk) => chunk.data).join(""), "runtime-history-")).toEqual(lines);
      await subscription.release();
      await registry.closeAll();
    });
  }, 15_000);

  itWithTmux("eventually aligns the client tail with tmux after cap-sized burst output", async () => {
    await withHarness(async (harness) => {
      const registry = new SlotTerminalStreamRecorderRegistry();
      const app = buildTrueTmuxWebSocketApp({ harness, streamRecorder: registry });
      const lines = numberedLines("cap-tail", SCROLLBACK_CAP + 25);

      try {
        await app.ready();
        const { socket, messages } = await observeInjectedMessages(
          app,
          "/api/slot-terminal/ws?projectId=project-1&requirementId=req-1&pane=claude"
        );
        await waitFor(() => messages.length >= 2, "initial websocket snapshot was not received");

        await harness.sendLines(lines);
        await harness.waitForPaneLine(lines.at(-1) ?? "");
        const tmuxTail = linesWithPrefix(await harness.capturePane(SCROLLBACK_CAP + 100), "cap-tail-").slice(
          -SCROLLBACK_CAP
        );

        await waitFor(
          () => {
            const clientTail = clientModelLines(messages, "cap-tail-");
            const compareCount = Math.min(tmuxTail.length, RECONCILED_TAIL_LINES);
            return (
              clientTail.length >= compareCount &&
              lastLines(clientTail, compareCount).join("\n") === lastLines(tmuxTail, compareCount).join("\n")
            );
          },
          "client tail did not align with tmux after burst output and reconcile",
          15_000
        );

        const finalClientTail = clientModelLines(messages, "cap-tail-");
        const compareCount = Math.min(tmuxTail.length, RECONCILED_TAIL_LINES);
        expect(compareCount).toBeGreaterThan(0);
        expect(finalClientTail.length).toBeGreaterThanOrEqual(compareCount);
        expect(lastLines(finalClientTail, compareCount)).toEqual(lastLines(tmuxTail, compareCount));
        expect(tmuxTail).not.toContain(lines[0]);
        socket.terminate();
      } finally {
        await app.close();
        await registry.closeAll();
      }
    });
  }, 30_000);

  itWithTmux("replays hidden output from the ring and reports a gap after the ring is exceeded", async () => {
    await withHarness(async (harness) => {
      const replayRegistry = new SlotTerminalStreamRecorderRegistry({ ringBytes: 4096 });
      const replayChunks: SlotTerminalStreamChunk[] = [];
      const replay = await replayRegistry.subscribe({
        target: harness.paneId,
        socketPath: harness.socketPath,
        callbacks: { onChunk: (chunk) => replayChunks.push(chunk) }
      });
      const replayLines = numberedLines("hidden-replay", 12);
      replay.pause();
      await harness.sendLines(replayLines);
      await harness.waitForPaneLine(replayLines.at(-1) ?? "");
      await waitForRingBytes(replayRegistry, harness, replayLines.join("").length);
      expect(replayChunks).toEqual([]);
      replay.resume();
      await waitForLines(replayChunks, "hidden-replay-", replayLines.length);
      expect(linesWithPrefix(replayChunks.map((chunk) => chunk.data).join(""), "hidden-replay-")).toEqual(replayLines);
      await replay.release();
      await replayRegistry.closeAll();

      const gapRegistry = new SlotTerminalStreamRecorderRegistry({ ringBytes: 80 });
      const gapChunks: SlotTerminalStreamChunk[] = [];
      const gaps: SlotTerminalStreamGapEvent[] = [];
      const gap = await gapRegistry.subscribe({
        target: harness.paneId,
        socketPath: harness.socketPath,
        callbacks: {
          onChunk: (chunk) => gapChunks.push(chunk),
          onGap: (event) => gaps.push(event)
        }
      });
      const gapLines = numberedLines("hidden-gap", 30);
      gap.pause();
      await sendLinesAsDistinctChunks(harness, gapRegistry, gapLines);
      gap.resume();
      await waitFor(() => gaps.length === 1, "hidden overflow did not report a ring gap");
      expect(gaps[0]).toMatchObject({ reason: "ring-gap" });
      expect(linesWithPrefix(gapChunks.map((chunk) => chunk.data).join(""), "hidden-gap-")).toEqual([]);
      await gap.release();
      await gapRegistry.closeAll();
    });
  }, 20_000);

  itWithTmux("falls back when pane pipe is occupied and upgrades to reset plus stream after release", async () => {
    await withHarness(async (harness) => {
      const occupiedPath = join(harness.projectRoot, "occupied-pipe.log");
      await harness.tmux(["pipe-pane", "-o", "-t", harness.paneId, "cat > " + shellQuote(occupiedPath)]);
      const registry = new SlotTerminalStreamRecorderRegistry({ retryMs: 100 });
      const app = buildTrueTmuxWebSocketApp({ harness, streamRecorder: registry });

      try {
        await app.ready();
        const { socket, messages } = await collectInjectedMessages(
          app,
          "/api/slot-terminal/ws?projectId=project-1&requirementId=req-1&pane=claude",
          2
        );
        expect(messages[1]).toMatchObject({
          type: "frame",
          mode: "snapshot-fallback",
          initial: true
        });

        const resetPromise = collectWebSocketMessages(socket, 1);
        await harness.tmux(["pipe-pane", "-t", harness.paneId]);
        const [reset] = await resetPromise;
        expect(reset).toMatchObject({
          type: "frame",
          kind: "reset",
          reason: "reconcile",
          mode: "stream",
          initial: true
        });

        const streamPromise = collectWebSocketMessages(socket, 1);
        await harness.sendLines(["fallback-upgrade-0001"]);
        const [stream] = await streamPromise;
        expect(stream).toMatchObject({
          type: "frame",
          kind: "stream",
          mode: "stream"
        });
        expect(String(stream.data)).toContain("fallback-upgrade-0001");
        socket.terminate();
      } finally {
        await app.close();
        await registry.closeAll();
      }
    });
  }, 20_000);

  itWithTmux("recovers a stale slot-terminal pipe when a new registry instance starts", async () => {
    await withHarness(async (harness) => {
      const firstRegistry = new SlotTerminalStreamRecorderRegistry({ idleCloseMs: 5 * 60 * 1000 });
      const first = await firstRegistry.subscribe({ target: harness.paneId, socketPath: harness.socketPath });
      await waitFor(
        async () => (await harness.panePipe()) === "1" && (await harness.pipeOwner()).includes(SLOT_TERMINAL_STREAM_FIFO_PREFIX),
        "initial pipe did not start"
      );
      await first.release();
      const staleOwner = await harness.pipeOwner();
      expect(await harness.panePipe()).toBe("1");
      expect(staleOwner).toContain(SLOT_TERMINAL_STREAM_FIFO_PREFIX);

      const tmux = new RecordingTmuxBackend();
      const secondRegistry = new SlotTerminalStreamRecorderRegistry({ tmux });
      const chunks: SlotTerminalStreamChunk[] = [];
      const second = await secondRegistry.subscribe({
        target: harness.paneId,
        socketPath: harness.socketPath,
        callbacks: { onChunk: (chunk) => chunks.push(chunk) }
      });
      expect(tmux.calls.slice(0, 5)).toEqual([
        "getPanePipe",
        "stopPipe",
        "clearPipeOwner",
        "startPipe",
        "setPipeOwner"
      ]);
      const recoveredOwner = await harness.pipeOwner();
      expect(recoveredOwner).toContain(SLOT_TERMINAL_STREAM_FIFO_PREFIX);
      expect(recoveredOwner).not.toBe(staleOwner);

      await harness.sendLines(["restart-recovery-0001"]);
      await waitForLines(chunks, "restart-recovery-", 1);
      expect(linesWithPrefix(chunks.map((chunk) => chunk.data).join(""), "restart-recovery-")).toEqual([
        "restart-recovery-0001"
      ]);
      await second.release();
      await secondRegistry.closeAll();
      await firstRegistry.closeAll();
    });
  }, 20_000);
});

async function withHarness(run: (harness: TrueTmuxHarness) => Promise<void>): Promise<void> {
  const harness = await TrueTmuxHarness.start();
  try {
    await run(harness);
  } finally {
    await harness.close();
  }
}

function numberedLines(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => prefix + "-" + String(index + 1).padStart(4, "0"));
}

function linesWithPrefix(data: string, prefix: string): string[] {
  return data
    .split(/\n/)
    .map((line) => line.replace(/\r$/, ""))
    .filter((line) => line.startsWith(prefix));
}

async function waitForLines(
  chunks: SlotTerminalStreamChunk[],
  prefix: string,
  count: number,
  timeoutMs = 5_000
): Promise<void> {
  await waitFor(
    () => linesWithPrefix(chunks.map((chunk) => chunk.data).join(""), prefix).length >= count,
    "timed out waiting for " + count + " " + prefix + " lines",
    timeoutMs
  );
}

async function waitForNextSeq(
  registry: SlotTerminalStreamRecorderRegistry,
  harness: TrueTmuxHarness,
  nextSeq: number
): Promise<void> {
  await waitFor(
    () => (registry.getDebugState({ target: harness.paneId, socketPath: harness.socketPath })?.nextSeq ?? 0) >= nextSeq,
    "stream recorder did not reach seq " + nextSeq
  );
}

async function waitForRingBytes(
  registry: SlotTerminalStreamRecorderRegistry,
  harness: TrueTmuxHarness,
  minBytes: number
): Promise<void> {
  await waitFor(
    () => (registry.getDebugState({ target: harness.paneId, socketPath: harness.socketPath })?.ringBytes ?? 0) >= minBytes,
    "stream recorder did not buffer at least " + minBytes + " bytes"
  );
}

async function sendLinesAsDistinctChunks(
  harness: TrueTmuxHarness,
  registry: SlotTerminalStreamRecorderRegistry,
  lines: string[]
): Promise<void> {
  for (const line of lines) {
    const previousSeq =
      registry.getDebugState({ target: harness.paneId, socketPath: harness.socketPath })?.nextSeq ?? 1;
    await harness.sendLines([line]);
    await waitForNextSeq(registry, harness, previousSeq + 1);
  }
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  message: string,
  timeoutMs = 5_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(message);
}

function webSocketRequest(origin = ALLOWED_ORIGIN): Partial<IncomingMessage> {
  return {
    headers: { origin },
    socket: { remoteAddress: "127.0.0.1" }
  } as Partial<IncomingMessage>;
}

function collectInjectedMessages(
  app: ReturnType<typeof buildTrueTmuxWebSocketApp>,
  url: string,
  count: number
): Promise<{ socket: { send: (data: string) => void; terminate: () => void }; messages: Array<Record<string, unknown>> }> {
  return new Promise((resolve, reject) => {
    void app
      .injectWS(url, webSocketRequest(), {
        onInit(ws) {
          collectWebSocketMessages(ws, count).then(
            (messages) => resolve({ socket: ws, messages }),
            reject
          );
        }
      })
      .catch(reject);
  });
}

function observeInjectedMessages(
  app: ReturnType<typeof buildTrueTmuxWebSocketApp>,
  url: string
): Promise<{ socket: { send: (data: string) => void; terminate: () => void }; messages: Array<Record<string, unknown>> }> {
  return new Promise((resolve, reject) => {
    void app
      .injectWS(url, webSocketRequest(), {
        onInit(ws) {
          const messages: Array<Record<string, unknown>> = [];
          ws.on("message", (data) => {
            messages.push(JSON.parse(String(data)) as Record<string, unknown>);
          });
          ws.on("error", () => reject(new Error("websocket error")));
          resolve({ socket: ws, messages });
        }
      })
      .catch(reject);
  });
}

function collectWebSocketMessages(
  socket: { on: (event: "message" | "error", handler: (...args: unknown[]) => void) => void },
  count: number
): Promise<Array<Record<string, unknown>>> {
  return new Promise((resolve, reject) => {
    const messages: Array<Record<string, unknown>> = [];
    const timeout = setTimeout(() => {
      reject(new Error("timed out waiting for " + count + " websocket messages"));
    }, 5_000);
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

function clientModelLines(messages: Array<Record<string, unknown>>, prefix: string): string[] {
  let data = "";
  for (const message of messages) {
    if (message.type !== "frame") {
      continue;
    }
    if (message.kind === "stream") {
      data += String(message.data ?? "");
      continue;
    }
    if (message.initial === true || message.kind === "reset") {
      data = String(message.data ?? "");
    }
  }
  return linesWithPrefix(data, prefix);
}

function lastLines(lines: string[], count: number): string[] {
  return lines.slice(-count);
}

async function isTmuxAvailable(): Promise<boolean> {
  try {
    await execFileAsync("tmux", ["-V"]);
    return true;
  } catch {
    return false;
  }
}

function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}
