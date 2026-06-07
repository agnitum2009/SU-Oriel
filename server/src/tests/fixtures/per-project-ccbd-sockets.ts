import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type FakeCcbdRequest = {
  op: string;
  request: Record<string, unknown>;
};

export type FakeTmuxCommand = {
  socketPath: string;
  args: string[];
};

export type FakeProjectCcbd = {
  projectId: string;
  projectRoot: string;
  ccbdSocketPath: string;
  tmuxSocketPath: string;
  requests: FakeCcbdRequest[];
  tmuxCommands: FakeTmuxCommand[];
  resetRecords(): void;
  close(): Promise<void>;
};

export type FakeProjectCcbdOptions = {
  projectId: string;
  projectRoot: string;
  maxSlotCount?: number;
};

// Reusable by Playwright backend setup: create one fake ccbd per project root,
// point the project's .ccb/ccbd/lifecycle.json at it, and pass createFakeTmuxRunner()
// into SlotContextResetService to capture per-project tmux send-keys writes.
export async function createFakeProjectCcbd(options: FakeProjectCcbdOptions): Promise<FakeProjectCcbd> {
  const ccbdSocketPath = join(tmpdir(), `ccbd-${randomUUID()}.sock`);
  const tmuxSocketPath = join(tmpdir(), `tmux-${randomUUID()}.sock`);
  const ccbdDir = join(options.projectRoot, ".ccb", "ccbd");
  await mkdir(ccbdDir, { recursive: true });
  await writeFile(join(ccbdDir, "lifecycle.json"), JSON.stringify({ socket_path: ccbdSocketPath }), "utf8");
  await rm(ccbdSocketPath, { force: true });

  const requests: FakeCcbdRequest[] = [];
  const tmuxCommands: FakeTmuxCommand[] = [];
  const server = net.createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      while (buffer.includes("\n")) {
        const newlineIndex = buffer.indexOf("\n");
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        if (!line.trim()) continue;
        const parsed = JSON.parse(line) as { op?: unknown; request?: unknown };
        const op = typeof parsed.op === "string" ? parsed.op : "unknown";
        const request = parsed.request && typeof parsed.request === "object" && !Array.isArray(parsed.request)
          ? parsed.request as Record<string, unknown>
          : {};
        requests.push({ op, request });
        socket.write(JSON.stringify(responseFor(op, request, options, tmuxSocketPath)) + "\n");
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(ccbdSocketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });

  return {
    projectId: options.projectId,
    projectRoot: options.projectRoot,
    ccbdSocketPath,
    tmuxSocketPath,
    requests,
    tmuxCommands,
    resetRecords() {
      requests.length = 0;
      tmuxCommands.length = 0;
    },
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      }).catch(() => undefined);
      await rm(ccbdSocketPath, { force: true });
      await rm(tmuxSocketPath, { force: true });
    }
  };
}

export function createFakeTmuxRunner(projects: FakeProjectCcbd[]) {
  return async (socketPath: string, args: string[]): Promise<void> => {
    const project = projects.find((candidate) => candidate.tmuxSocketPath === socketPath);
    if (!project) {
      throw new Error(`unexpected tmux socket: ${socketPath}`);
    }
    project.tmuxCommands.push({
      socketPath,
      args: [...args]
    });
  };
}

function responseFor(
  op: string,
  request: Record<string, unknown>,
  options: FakeProjectCcbdOptions,
  tmuxSocketPath: string
): Record<string, unknown> {
  if (op === "project_view") {
    return {
      api_version: 2,
      ok: true,
      view: buildProjectView(options, tmuxSocketPath)
    };
  }
  if (op === "cancel") {
    return {
      api_version: 2,
      ok: true,
      job_id: typeof request.job_id === "string" ? request.job_id : null,
      cancelled: true
    };
  }
  if (op === "submit") {
    return {
      api_version: 2,
      ok: true,
      job_id: `fake-${randomUUID()}`,
      trace_ref: `trace-${randomUUID()}`
    };
  }
  return {
    api_version: 2,
    ok: true
  };
}

function buildProjectView(options: FakeProjectCcbdOptions, tmuxSocketPath: string): Record<string, unknown> {
  const maxSlotCount = options.maxSlotCount ?? 4;
  const windows = [];
  const agents = [];
  for (let index = 1; index <= maxSlotCount; index++) {
    const slotId = `slot-${index}`;
    const claude = `slot${index}_claude`;
    const codex = `slot${index}_codex`;
    windows.push({
      name: slotId,
      agents: [claude, codex]
    });
    agents.push(
      {
        name: claude,
        provider: "claude",
        window: slotId,
        pane_id: `%${index}1`,
        active: true
      },
      {
        name: codex,
        provider: "codex",
        window: slotId,
        pane_id: `%${index}2`,
        active: true
      }
    );
  }
  return {
    schema_version: 1,
    project: {
      id: options.projectId,
      root: options.projectRoot
    },
    namespace: {
      socket_path: tmuxSocketPath,
      session_name: `fake-${options.projectId}`,
      active_window: "slot-1",
      active_pane_id: "%11"
    },
    windows,
    agents
  };
}
