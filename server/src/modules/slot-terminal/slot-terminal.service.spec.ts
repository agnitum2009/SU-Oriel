import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Fastify from "fastify";
import { test, vi } from "vitest";

import { assertTargetBelongsTo } from "./slot-terminal.guard.js";
import { SlotTerminalNotFoundError, SlotTerminalTargetForbiddenError } from "./slot-terminal.errors.js";
import { registerSlotTerminalRoutes } from "./slot-terminal.routes.js";
import {
  SlotTerminalService,
  TmuxSlotTerminalRuntimeResolver,
  type SlotTerminalBinding,
  type SlotTerminalExecFileProcess,
  type SlotTerminalProject,
  type SlotTerminalStore
} from "./slot-terminal.service.js";

class FakeSlotTerminalStore implements SlotTerminalStore {
  constructor(
    private readonly projects: Map<string, SlotTerminalProject>,
    private readonly requirementProjects: Map<string, string>,
    private readonly bindings: SlotTerminalBinding[]
  ) {}

  async findProject(projectId: string): Promise<SlotTerminalProject | null> {
    return this.projects.get(projectId) ?? null;
  }

  async findProjectIdForRequirement(requirementId: string): Promise<string | null> {
    return this.requirementProjects.get(requirementId) ?? null;
  }

  async findBindingForRequirement(projectId: string, requirementId: string): Promise<SlotTerminalBinding | null> {
    return (
      this.bindings.find((binding) => binding.projectId === projectId && binding.requirementId === requirementId) ?? null
    );
  }
}

type FixtureOptions = {
  projectId?: string;
  requirementId?: string;
  slotId?: string;
  slotCount?: number;
  bindingState?: SlotTerminalBinding["state"];
  includeBinding?: boolean;
};

async function createFixture(options: FixtureOptions = {}) {
  const projectId = options.projectId ?? `project-${randomUUID()}`;
  const requirementId = options.requirementId ?? `req-${randomUUID()}`;
  const slotId = options.slotId ?? "slot-2";
  const slotAgentPrefix = slotId.replace("slot-", "slot");
  const projectRoot = join(tmpdir(), `slot-terminal-${randomUUID()}`);
  await writeRuntime(projectRoot, `${slotAgentPrefix}_claude`, {
    provider: "claude",
    tmux_window_name: slotId,
    pane_id: "%7",
    pane_title_marker: "unstable-title-that-must-not-be-used"
  });
  await writeRuntime(projectRoot, `${slotAgentPrefix}_codex`, {
    provider: "codex",
    tmux_window_name: slotId,
    pane_id: "%8",
    pane_title_marker: "another-unstable-title"
  });
  await writeRuntime(projectRoot, "slot2_sidebar", {
    provider: "sidebar",
    tmux_window_name: slotId,
    pane_id: "%9"
  });

  const binding = {
    projectId,
    requirementId,
    slotId,
    state: options.bindingState ?? "bound"
  } as SlotTerminalBinding;
  const store = new FakeSlotTerminalStore(
    new Map([[projectId, { id: projectId, localPath: projectRoot, slotCount: options.slotCount ?? 3 }]]),
    new Map([[requirementId, projectId]]),
    options.includeBinding === false ? [] : [binding]
  );
  const execFile = createTmuxExecFile({
    sessionName: "ccb-su-ccb-test-session",
    slotId,
    panes: [
      { windowName: slotId, paneId: "%9", paneIndex: 0 },
      { windowName: slotId, paneId: "%8", paneIndex: 3 },
      { windowName: slotId, paneId: "%7", paneIndex: 2 }
    ]
  });
  const runtime = new TmuxSlotTerminalRuntimeResolver({ execFileProcess: execFile });
  const service = new SlotTerminalService({ store, runtime });

  return { projectId, requirementId, slotId, service, execFile };
}

test("GET slot-terminal returns bound claude/codex tmux targets only", async () => {
  const fixture = await createFixture();
  const app = Fastify();
  await app.register(registerSlotTerminalRoutes, { service: fixture.service });

  try {
    const response = await app.inject({
      method: "GET",
      url: `/api/projects/${fixture.projectId}/requirements/${fixture.requirementId}/slot-terminal`
    });

    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json(), {
      slotId: fixture.slotId,
      sessionName: "ccb-su-ccb-test-session",
      panes: [
        { role: "claude", target: "%7", paneIndex: 2 },
        { role: "codex", target: "%8", paneIndex: 3 }
      ]
    });
  } finally {
    await app.close();
  }
});

test("GET slot-terminal returns 404 for missing or recycled binding", async () => {
  for (const options of [{ includeBinding: false }, { bindingState: "idle" as const }]) {
    const fixture = await createFixture(options);
    const app = Fastify();
    await app.register(registerSlotTerminalRoutes, { service: fixture.service });

    try {
      const response = await app.inject({
        method: "GET",
        url: `/api/projects/${fixture.projectId}/requirements/${fixture.requirementId}/slot-terminal`
      });

      assert.equal(response.statusCode, 404, response.body);
    } finally {
      await app.close();
    }
  }
});

test("pane role resolution uses runtime window and provider metadata, not pane titles or fixed indexes", async () => {
  const fixture = await createFixture();

  const descriptor = await fixture.service.resolveRequirementTerminal({
    projectId: fixture.projectId,
    requirementId: fixture.requirementId
  });

  assert.deepEqual(descriptor.panes, [
    { role: "claude", target: "%7", paneIndex: 2 },
    { role: "codex", target: "%8", paneIndex: 3 }
  ]);
  const listPanesCall = fixture.execFile.mock.calls.find(([, args]) => args.includes("list-panes"));
  assert.ok(listPanesCall);
  assert.equal(listPanesCall[1].some((arg) => arg.includes("pane_title")), false);
  assert.equal(listPanesCall[1].some((arg) => arg.includes("pane_current_command")), false);
});

test("resolveRequirementTerminal accepts slot-4 when the project topology has four slots", async () => {
  const fixture = await createFixture({ slotId: "slot-4", slotCount: 4 });

  const descriptor = await fixture.service.resolveRequirementTerminal({
    projectId: fixture.projectId,
    requirementId: fixture.requirementId
  });

  assert.equal(descriptor.slotId, "slot-4");
  assert.deepEqual(descriptor.panes, [
    { role: "claude", target: "%7", paneIndex: 2 },
    { role: "codex", target: "%8", paneIndex: 3 }
  ]);
});

test("assertTargetBelongsTo rejects cross-slot, cross-project, cross-pane, and non-whitelist role targets", async () => {
  const fixture = await createFixture();

  await assert.doesNotReject(() =>
    assertTargetBelongsTo(fixture.requirementId, fixture.slotId, "claude", "%7", { service: fixture.service })
  );

  await assert.rejects(
    () => assertTargetBelongsTo(fixture.requirementId, "slot-3", "claude", "%7", { service: fixture.service }),
    SlotTerminalTargetForbiddenError
  );
  await assert.rejects(
    () => assertTargetBelongsTo(fixture.requirementId, fixture.slotId, "claude", "%21", { service: fixture.service }),
    SlotTerminalTargetForbiddenError
  );
  await assert.rejects(
    () => assertTargetBelongsTo(fixture.requirementId, fixture.slotId, "codex", "%7", { service: fixture.service }),
    SlotTerminalTargetForbiddenError
  );
  await assert.rejects(
    () => assertTargetBelongsTo(fixture.requirementId, fixture.slotId, "sidebar", "%9", { service: fixture.service }),
    SlotTerminalTargetForbiddenError
  );
});

test("GET agent-terminal main returns strict claude/codex tmux targets", async () => {
  const fixture = await createAgentGroupFixture();
  const app = Fastify();
  await app.register(registerSlotTerminalRoutes, { service: fixture.service });

  try {
    const response = await app.inject({
      method: "GET",
      url: `/api/projects/${fixture.projectId}/agent-terminal/main`
    });

    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json(), {
      slotId: "main",
      sessionName: "ccb-su-ccb-test-session",
      panes: [
        { role: "claude", target: "%1", paneIndex: 1 },
        { role: "codex", target: "%2", paneIndex: 2 }
      ]
    });
  } finally {
    await app.close();
  }
});

test("resolveAgentGroupTerminal rejects non-main groups and duplicate role candidates before first-pick", async () => {
  const fixture = await createAgentGroupFixture();

  await assert.rejects(
    () => fixture.service.resolveAgentGroupTerminal({ projectId: fixture.projectId, group: "slot-2" }),
    SlotTerminalTargetForbiddenError
  );

  const duplicate = await createAgentGroupFixture({
    runtimes: [
      { agentName: "main_claude", provider: "claude", paneId: "%1" },
      { agentName: "main_claude_duplicate", provider: "claude", paneId: "%3" },
      { agentName: "main_codex", provider: "codex", paneId: "%2" }
    ],
    panes: [
      { windowName: "main", paneId: "%1", paneIndex: 1 },
      { windowName: "main", paneId: "%2", paneIndex: 2 },
      { windowName: "main", paneId: "%3", paneIndex: 3 }
    ]
  });

  await assert.rejects(
    () => duplicate.service.resolveAgentGroupTerminal({ projectId: duplicate.projectId, group: "main" }),
    SlotTerminalNotFoundError
  );
});

test("resolveAgentGroupTerminal rejects candidates with unexpected main agent identity", async () => {
  const fixture = await createAgentGroupFixture({
    runtimes: [
      { agentName: "slot1_claude", provider: "claude", paneId: "%1" },
      { agentName: "main_codex", provider: "codex", paneId: "%2" }
    ]
  });

  await assert.rejects(
    () => fixture.service.resolveAgentGroupTerminal({ projectId: fixture.projectId, group: "main" }),
    SlotTerminalNotFoundError
  );
});

test("assertTargetBelongsToAgentGroup rejects cross-pane targets and accepts main pane targets", async () => {
  const fixture = await createAgentGroupFixture();

  await assert.deepEqual(
    await fixture.service.assertTargetBelongsToAgentGroup({
      projectId: fixture.projectId,
      group: "main",
      role: "claude",
      target: "%1"
    }),
    { role: "claude", target: "%1", paneIndex: 1 }
  );

  await assert.rejects(
    () =>
      fixture.service.assertTargetBelongsToAgentGroup({
        projectId: fixture.projectId,
        group: "main",
        role: "claude",
        target: "%2"
      }),
    SlotTerminalTargetForbiddenError
  );
});

test("GET agent-terminal rejects non-main groups", async () => {
  const fixture = await createAgentGroupFixture();
  const app = Fastify();
  await app.register(registerSlotTerminalRoutes, { service: fixture.service });

  try {
    const response = await app.inject({
      method: "GET",
      url: `/api/projects/${fixture.projectId}/agent-terminal/slot-2`
    });

    assert.equal(response.statusCode, 403, response.body);
  } finally {
    await app.close();
  }
});

async function writeRuntime(projectRoot: string, agentName: string, record: Record<string, unknown>): Promise<void> {
  const agentDir = join(projectRoot, ".ccb", "agents", agentName);
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "runtime.json"), JSON.stringify(record, null, 2), "utf8");
}

function createTmuxExecFile(input: {
  sessionName: string;
  slotId: string;
  panes: Array<{ windowName: string; paneId: string; paneIndex: number }>;
}) {
  return vi.fn<SlotTerminalExecFileProcess>(async (_command, args) => {
    if (args.includes("list-sessions")) {
      return { stdout: `other-session\n${input.sessionName}\n`, stderr: "" };
    }
    if (args.includes("list-panes")) {
      assert.equal(args[args.indexOf("-t") + 1], `${input.sessionName}:${input.slotId}`);
      return {
        stdout: input.panes
          .map((pane) => `${input.sessionName}\t${pane.windowName}\t${pane.paneId}\t${pane.paneIndex}`)
          .join("\n"),
        stderr: ""
      };
    }
    return { stdout: "", stderr: "" };
  });
}

type AgentGroupRuntimeFixture = {
  agentName: string;
  provider: "claude" | "codex";
  paneId: string;
};

async function createAgentGroupFixture(options: {
  runtimes?: AgentGroupRuntimeFixture[];
  panes?: Array<{ windowName: string; paneId: string; paneIndex: number }>;
} = {}) {
  const projectId = `project-${randomUUID()}`;
  const projectRoot = join(tmpdir(), `slot-terminal-main-${randomUUID()}`);
  const runtimes = options.runtimes ?? [
    { agentName: "main_claude", provider: "claude", paneId: "%1" },
    { agentName: "main_codex", provider: "codex", paneId: "%2" }
  ];

  await writeRuntime(projectRoot, "main_sidebar", {
    agent_name: "main_sidebar",
    provider: "sidebar",
    tmux_window_name: "main",
    pane_id: "%0"
  });
  for (const runtime of runtimes) {
    await writeRuntime(projectRoot, runtime.agentName, {
      agent_name: runtime.agentName,
      provider: runtime.provider,
      tmux_window_name: "main",
      pane_id: runtime.paneId
    });
  }

  const store = new FakeSlotTerminalStore(
    new Map([[projectId, { id: projectId, localPath: projectRoot, slotCount: 3 }]]),
    new Map(),
    []
  );
  const execFile = createTmuxExecFile({
    sessionName: "ccb-su-ccb-test-session",
    slotId: "main",
    panes:
      options.panes ?? [
        { windowName: "main", paneId: "%0", paneIndex: 0 },
        { windowName: "main", paneId: "%2", paneIndex: 2 },
        { windowName: "main", paneId: "%1", paneIndex: 1 }
      ]
  });
  const runtime = new TmuxSlotTerminalRuntimeResolver({ execFileProcess: execFile });
  const service = new SlotTerminalService({ store, runtime });

  return { projectId, service, execFile };
}
