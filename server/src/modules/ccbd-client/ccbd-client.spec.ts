import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, test, vi } from "vitest";

import { CcbdUnavailableError } from "./ccbd-client.errors.js";
import { CcbdClientService, computeCcbProjectId, resolveCcbdSocketPath } from "./ccbd-client.service.js";

const cleanupPaths: string[] = [];

afterEach(async () => {
  for (const path of cleanupPaths.splice(0)) {
    await rm(path, { recursive: true, force: true });
  }
});

test("resolveCcbdSocketPath reads the mounted socket path from lifecycle metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "ccb-socket-root-"));
  cleanupPaths.push(root);
  const ccbdDir = join(root, ".ccb", "ccbd");
  await mkdir(ccbdDir, { recursive: true });
  await writeFile(join(ccbdDir, "lifecycle.json"), JSON.stringify({ socket_path: "/tmp/custom-ccbd.sock" }));

  assert.equal(resolveCcbdSocketPath(root), "/tmp/custom-ccbd.sock");
});

test("CcbdClientService sends newline-delimited JSON-RPC over a Unix socket", async () => {
  const seen: unknown[] = [];
  const socketPath = `/tmp/ccbd-${randomUUID()}.sock`;
  const fakeSocket = new EventEmitter() as net.Socket;
  fakeSocket.setTimeout = vi.fn() as unknown as net.Socket["setTimeout"];
  fakeSocket.destroy = vi.fn() as unknown as net.Socket["destroy"];
  fakeSocket.write = vi.fn((payload: string | Buffer) => {
    const line = payload.toString().split("\n")[0];
    seen.push(JSON.parse(line));
    queueMicrotask(() => {
      fakeSocket.emit(
        "data",
        Buffer.from(JSON.stringify({ api_version: 2, ok: true, job_id: "job_test", agent_name: "task_auto_cc_1", status: "queued" }) + "\n")
      );
    });
    return true;
  }) as unknown as net.Socket["write"];
  const createConnection = vi.spyOn(net, "createConnection").mockImplementation((options, onConnect?: () => void) => {
    assert.deepEqual(options, { path: socketPath });
    queueMicrotask(() => onConnect?.());
    return fakeSocket;
  });

  try {
    const client = new CcbdClientService({ socketPath });
    const result = await client.submit({
      toAgent: "task_auto_cc_1",
      taskId: "task-key",
      body: "/ccb:su-flow"
    });

    assert.equal(result.jobId, "job_test");
    assert.deepEqual(seen, [
      {
        api_version: 2,
        op: "submit",
        request: {
          project_id: client.projectId,
          to_agent: "task_auto_cc_1",
          from_actor: "user",
          body: "/ccb:su-flow",
          task_id: "task-key",
          reply_to: null,
          message_type: "ask",
          delivery_scope: "single",
          silence_on_success: false
        }
      }
    ]);
  } finally {
    createConnection.mockRestore();
  }
});

test("CcbdClientService uses anchor resolver metadata without a default project fallback", async () => {
  const root = await mkdtemp(join(tmpdir(), "ccb-anchor-root-"));
  cleanupPaths.push(root);
  const socketPath = `/tmp/ccbd-anchor-${randomUUID()}.sock`;
  const seen: unknown[] = [];
  const fakeSocket = new EventEmitter() as net.Socket;
  fakeSocket.setTimeout = vi.fn() as unknown as net.Socket["setTimeout"];
  fakeSocket.destroy = vi.fn() as unknown as net.Socket["destroy"];
  fakeSocket.write = vi.fn((payload: string | Buffer) => {
    const line = payload.toString().split("\n")[0];
    seen.push(JSON.parse(line));
    queueMicrotask(() => {
      fakeSocket.emit(
        "data",
        Buffer.from(JSON.stringify({ api_version: 2, ok: true, job_id: "job_anchor", status: "queued" }) + "\n")
      );
    });
    return true;
  }) as unknown as net.Socket["write"];
  const createConnection = vi.spyOn(net, "createConnection").mockImplementation((options, onConnect?: () => void) => {
    assert.deepEqual(options, { path: socketPath });
    queueMicrotask(() => onConnect?.());
    return fakeSocket;
  });

  try {
    const client = new CcbdClientService({
      anchorSocketResolver: async (anchorId) => {
        assert.equal(anchorId, "slot-1");
        return {
          socketPath,
          anchorPath: root
        };
      }
    });

    await assert.rejects(() => client.ping(), CcbdUnavailableError);

    const result = await client.submit({
      anchorId: "slot-1",
      toAgent: "task_auto_cc_1",
      taskId: "task-key",
      body: "/ccb:su-flow"
    });

    assert.equal(result.jobId, "job_anchor");
    assert.deepEqual(seen, [
      {
        api_version: 2,
        op: "submit",
        request: {
          project_id: computeCcbProjectId(root),
          to_agent: "task_auto_cc_1",
          from_actor: "user",
          body: "/ccb:su-flow",
          task_id: "task-key",
          reply_to: null,
          message_type: "ask",
          delivery_scope: "single",
          silence_on_success: false
        }
      }
    ]);
  } finally {
    createConnection.mockRestore();
  }
});
