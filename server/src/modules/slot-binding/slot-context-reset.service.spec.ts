import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { test, vi } from "vitest";

import type { CcbdProjectView } from "../ccbd-client/ccbd-client.types.js";
import {
  SlotContextResetService,
  type SlotContextResetClientFactory,
  type SlotContextResetStore,
  type SlotContextResetTrigger
} from "./slot-context-reset.service.js";

test("SlotContextResetService routes bind and release /new to the input project root only", async () => {
  const targetRoot = projectRoot("realtime-translator");
  const otherRoot = projectRoot("su-ccb");
  const store = storeFor({
    "project-new": targetRoot,
    "project-ccb": otherRoot
  });
  const tmuxCalls: Array<{ socketPath: string; args: string[] }> = [];
  const clientFactory = vi.fn<SlotContextResetClientFactory>((projectRoot) => ({
    projectView: async () => slotProjectView(projectRoot, `/tmp/${projectRoot.split("/").at(-1)}.sock`)
  }));
  const service = new SlotContextResetService({
    store,
    clientFactory,
    runTmux: async (socketPath, args) => {
      tmuxCalls.push({ socketPath, args });
    }
  });

  const triggers: SlotContextResetTrigger[] = ["bind", "release"];
  for (const trigger of triggers) {
    const result = await service.resetSlotContext({
      projectId: "project-new",
      slotId: "slot-1",
      requirementId: "req-1",
      trigger
    });
    assert.equal(result.status, "ok");
    assert.equal(result.sent, 2);
    assert.deepEqual(result.agentNames, ["slot1_claude", "slot1_codex"]);
  }

  assert.deepEqual(clientFactory.mock.calls.map(([root]) => root), [targetRoot, targetRoot]);
  assert.equal(clientFactory.mock.calls.some(([root]) => root === otherRoot), false);
  assert.equal(tmuxCalls.every((call) => call.socketPath.includes("realtime-translator")), true);
  assert.deepEqual(
    tmuxCalls.filter((call) => call.args.includes("-l")).map((call) => call.args),
    [
      ["send-keys", "-t", "%1", "-l", "/new"],
      ["send-keys", "-t", "%2", "-l", "/new"],
      ["send-keys", "-t", "%1", "-l", "/new"],
      ["send-keys", "-t", "%2", "-l", "/new"]
    ]
  );
});

test("SlotContextResetService fails closed when project localPath is missing", async () => {
  const clientFactory = vi.fn<SlotContextResetClientFactory>();
  const service = new SlotContextResetService({
    store: storeFor({}),
    clientFactory
  });

  const result = await service.resetSlotContext({
    projectId: "project-missing",
    slotId: "slot-1",
    trigger: "bind"
  });

  assert.equal(result.status, "failed");
  assert.equal(result.failed, 1);
  assert.equal(result.results[0]?.reason, "project_local_path_missing");
  assert.equal(clientFactory.mock.calls.length, 0);
});

test("SlotContextResetService fails closed on project root mismatch before tmux writes", async () => {
  const targetRoot = projectRoot("realtime-translator");
  const ccbRoot = projectRoot("su-ccb");
  const runTmux = vi.fn(async () => undefined);
  const service = new SlotContextResetService({
    store: storeFor({ "project-new": targetRoot }),
    clientFactory: () => ({
      projectView: async () => slotProjectView(ccbRoot, "/tmp/ccb-global.sock")
    }),
    runTmux
  });

  const result = await service.resetSlotContext({
    projectId: "project-new",
    slotId: "slot-1",
    trigger: "bind"
  });

  assert.equal(result.status, "failed");
  assert.equal(result.results[0]?.reason, "project_root_mismatch");
  assert.equal(runTmux.mock.calls.length, 0);
});

test("SlotContextResetService reports project_view failures without sending tmux input", async () => {
  const runTmux = vi.fn(async () => undefined);
  const service = new SlotContextResetService({
    store: storeFor({ "project-new": projectRoot("realtime-translator") }),
    clientFactory: () => ({
      projectView: async () => {
        throw new Error("ccbd unavailable");
      }
    }),
    runTmux
  });

  const result = await service.resetSlotContext({
    projectId: "project-new",
    slotId: "slot-1",
    trigger: "release"
  });

  assert.equal(result.status, "failed");
  assert.match(result.results[0]?.reason ?? "", /^project_view_failed: ccbd unavailable/);
  assert.equal(runTmux.mock.calls.length, 0);
});

test("SlotContextResetService skips when the slot window has no agents", async () => {
  const root = projectRoot("realtime-translator");
  const service = new SlotContextResetService({
    store: storeFor({ "project-new": root }),
    clientFactory: () => ({
      projectView: async () => ({
        project: { root },
        namespace: { socket_path: "/tmp/realtime.sock" },
        windows: [{ name: "slot-1", agents: [] }],
        agents: []
      })
    })
  });

  const result = await service.resetSlotContext({
    projectId: "project-new",
    slotId: "slot-1",
    trigger: "bind"
  });

  assert.equal(result.status, "skipped");
  assert.equal(result.results[0]?.reason, "slot_window_agents_missing");
});

test("SlotContextResetService records per-agent delivery failures and keeps sending", async () => {
  const root = projectRoot("realtime-translator");
  const service = new SlotContextResetService({
    store: storeFor({ "project-new": root }),
    clientFactory: () => ({
      projectView: async () => slotProjectView(root, "/tmp/realtime.sock")
    }),
    runTmux: async (_socketPath, args) => {
      if (args.includes("%1") && args.includes("C-u")) {
        throw new Error("pane unavailable");
      }
    }
  });

  const result = await service.resetSlotContext({
    projectId: "project-new",
    slotId: "slot-1",
    trigger: "release"
  });

  assert.equal(result.status, "partial");
  assert.equal(result.sent, 1);
  assert.equal(result.failed, 1);
  assert.deepEqual(result.results.map((item) => [item.agent, item.status]), [
    ["slot1_claude", "failed"],
    ["slot1_codex", "sent"]
  ]);
});

function storeFor(paths: Record<string, string>): SlotContextResetStore {
  return {
    findProjectLocalPath: vi.fn(async (projectId) => paths[projectId] ?? null)
  };
}

function slotProjectView(projectRoot: string, socketPath: string): CcbdProjectView {
  return {
    project: {
      root: projectRoot
    },
    namespace: {
      socket_path: socketPath
    },
    windows: [
      {
        name: "slot-1",
        agents: ["slot1_claude", "slot1_codex"]
      }
    ],
    agents: [
      {
        name: "slot1_claude",
        pane_id: "%1"
      },
      {
        name: "slot1_codex",
        pane_id: "%2"
      }
    ]
  };
}

function projectRoot(label: string): string {
  return join(tmpdir(), `ccb-${label}-${randomUUID()}`);
}
