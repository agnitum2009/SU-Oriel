import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { test } from "vitest";

import {
  ProviderActivitySource,
  parseCcbConfigAgentBindings,
  type ProviderActivityDispatchRow,
  type ProviderActivitySlotBinding
} from "./provider-activity.source.js";

const NOW = new Date("2026-06-06T12:00:00.000Z");

const CONFIG = [
  "version = 2",
  'entry_window = "main"',
  "",
  "[windows]",
  'main = "main_claude:claude; main_codex:codex"',
  'slot-1 = "slot1_claude:claude; slot1_codex:codex"',
  'slot-2 = "slot2_claude:claude; slot2_codex:codex"',
  'slot-4 = "slot4_codex:codex"',
  "",
  "[agents.main_claude]",
  'provider = "claude"',
  "",
  "[agents.main_codex]",
  'provider = "codex"',
  "",
  "[agents.slot1_claude]",
  'provider = "claude"',
  "",
  "[agents.slot1_codex]",
  'provider = "codex"',
  "",
  "[agents.slot2_codex]",
  'provider = "codex"',
  "",
  "[agents.slot4_codex]",
  'provider = "codex"',
  ""
].join("\n");

test("parseCcbConfigAgentBindings parses real managed ccb.config windows and agents", () => {
  const bindings = parseCcbConfigAgentBindings(CONFIG);
  assert.deepEqual(
    bindings.filter((binding) => ["main", "slot-1"].includes(binding.windowName)),
    [
      { windowName: "main", agentName: "main_claude", provider: "claude" },
      { windowName: "main", agentName: "main_codex", provider: "codex" },
      { windowName: "slot-1", agentName: "slot1_claude", provider: "claude" },
      { windowName: "slot-1", agentName: "slot1_codex", provider: "codex" }
    ]
  );
});

test("provider activity matrix covers permission/question/plan/input/failed positives and negatives", async () => {
  const root = await createProjectRoot();
  const source = new ProviderActivitySource();
  const slot = slotBinding("slot-1", "bound");

  await writeActivity(root, "slot1_codex", "codex", {
    state: "pending",
    event_name: "PermissionRequest",
    updated_at: NOW.toISOString(),
    provider_session_id: "session-permission",
    diagnostics: { tool_name: "PermissionRequest" }
  });
  let items = await source.collect(baseInput(root, NOW, [slot]));
  assert.equal(items[0]?.kind, "agent_waiting");
  assert.equal(items[0]?.severity, "attention");
  assert.equal(items[0]?.metadata?.reason, "permission");

  await writeActivity(root, "slot1_codex", "codex", {
    state: "active",
    event_name: "PostToolUse",
    updated_at: NOW.toISOString(),
    provider_session_id: "session-question-negative",
    diagnostics: { tool_name: "AskUserQuestion" }
  });
  items = await source.collect(baseInput(root, NOW, [slot]));
  assert.equal(items.some((item) => item.metadata?.reason === "question"), false);

  await writeActivity(root, "slot1_codex", "codex", {
    state: "active",
    event_name: "PreToolUse",
    updated_at: NOW.toISOString(),
    provider_session_id: "session-question",
    diagnostics: { tool_name: "AskUserQuestion" }
  });
  items = await source.collect(baseInput(root, NOW, [slot]));
  assert.equal(items[0]?.metadata?.reason, "question");

  await writeActivity(root, "slot1_codex", "codex", {
    state: "active",
    event_name: "PreToolUse",
    updated_at: NOW.toISOString(),
    provider_session_id: "session-plan-negative",
    diagnostics: { tool_name: "Bash" }
  });
  items = await source.collect(baseInput(root, NOW, [slot]));
  assert.equal(items.some((item) => item.metadata?.reason === "plan"), false);

  await writeActivity(root, "slot1_codex", "codex", {
    state: "active",
    event_name: "PreToolUse",
    updated_at: NOW.toISOString(),
    provider_session_id: "session-plan",
    diagnostics: { tool_name: "ExitPlanMode" }
  });
  items = await source.collect(baseInput(root, NOW, [slot]));
  assert.equal(items[0]?.metadata?.reason, "plan");

  await writeActivity(root, "slot1_codex", "codex", {
    state: "pending",
    event_name: "Notification",
    updated_at: "2026-06-06T11:58:50.000Z",
    provider_session_id: "session-input",
    diagnostics: {}
  });
  items = await source.collect(baseInput(root, NOW, [slot]));
  assert.equal(items.some((item) => item.metadata?.reason === "input"), false);
  items = await source.collect(baseInput(root, new Date("2026-06-06T12:00:10.000Z"), [slot]));
  assert.equal(items[0]?.metadata?.reason, "input");

  await writeActivity(root, "slot1_codex", "codex", {
    state: "failed",
    event_name: "ProviderPaneError",
    updated_at: NOW.toISOString(),
    provider_session_id: "session-failed",
    diagnostics: { reason: "provider_terminal_error" }
  });
  items = await source.collect(baseInput(root, NOW, [slot]));
  assert.equal(items[0]?.kind, "agent_failed");

  items = await source.collect(baseInput(root, NOW, [slotBinding("slot-1", "idle", null)]));
  assert.equal(items.some((item) => item.kind === "agent_failed"), false);
});

test("provider activity skips missing and corrupted files without throwing", async () => {
  const root = await createProjectRoot();
  const source = new ProviderActivitySource();
  let items = await source.collect(baseInput(root, NOW, [slotBinding("slot-1", "bound")]));
  assert.equal(items.length, 0);

  await mkdir(join(root, ".ccb", "agents", "slot1_codex", "provider-runtime", "codex"), { recursive: true });
  await writeFile(join(root, ".ccb", "agents", "slot1_codex", "provider-runtime", "codex", "activity.json"), "{bad", "utf8");
  items = await source.collect(baseInput(root, NOW, [slotBinding("slot-1", "bound")]));
  assert.equal(items.length, 0);
});

test("provider activity keeps session refs stable and TTL-buckets fallback refs", async () => {
  const root = await createProjectRoot();
  const source = new ProviderActivitySource();
  const slot = slotBinding("slot-1", "bound");

  await writeActivity(root, "slot1_codex", "codex", {
    state: "pending",
    event_name: "PermissionRequest",
    updated_at: NOW.toISOString(),
    provider_session_id: "stable-session",
    diagnostics: { tool_name: "PermissionRequest" }
  });
  const first = await source.collect(baseInput(root, NOW, [slot]));
  const second = await source.collect(baseInput(root, NOW, [slot]));
  assert.equal(first[0]?.ref, second[0]?.ref);

  await writeActivity(root, "slot1_codex", "codex", {
    state: "pending",
    event_name: "PermissionRequest",
    updated_at: NOW.toISOString(),
    provider_session_id: null,
    provider_turn_id: null,
    ccb_session_id: null,
    diagnostics: { tool_name: "PermissionRequest" }
  });
  const fallbackA = await source.collect(baseInput(root, NOW, [slot]));
  const fallbackB = await source.collect(baseInput(root, new Date("2026-06-06T12:05:00.000Z"), [slot]));
  const fallbackC = await source.collect(baseInput(root, new Date("2026-06-06T12:11:00.000Z"), [slot]));
  assert.equal(fallbackA[0]?.ref, fallbackB[0]?.ref);
  assert.notEqual(fallbackA[0]?.ref, fallbackC[0]?.ref);
});

test("provider activity suppresses slot waiting for unhealthy/recovering/draining/released and skips unbound window", async () => {
  const root = await createProjectRoot();
  const source = new ProviderActivitySource();
  await writeActivity(root, "slot1_codex", "codex", {
    state: "active",
    event_name: "PreToolUse",
    updated_at: NOW.toISOString(),
    provider_session_id: "session-question",
    diagnostics: { tool_name: "AskUserQuestion" }
  });
  for (const state of ["unhealthy", "recovering", "draining", "released"]) {
    const items = await source.collect(baseInput(root, NOW, [slotBinding("slot-1", state)]));
    assert.equal(items.some((item) => item.kind === "agent_waiting"), false, state);
  }

  await writeActivity(root, "slot4_codex", "codex", {
    state: "active",
    event_name: "PreToolUse",
    updated_at: NOW.toISOString(),
    provider_session_id: "session-slot4",
    diagnostics: { tool_name: "AskUserQuestion" }
  });
  const items = await source.collect(baseInput(root, NOW, [slotBinding("slot-1", "bound")]));
  assert.equal(items.some((item) => item.metadata?.agentName === "slot4_codex"), false);
});

test("main agent completion requires active >=60s, ignores cold idle and restart idle-only", async () => {
  const root = await createProjectRoot();
  const source = new ProviderActivitySource();

  await writeActivity(root, "main_codex", "codex", {
    state: "idle",
    event_name: "Stop",
    updated_at: NOW.toISOString(),
    provider_session_id: "main-session",
    diagnostics: {}
  });
  assert.equal((await source.collect(baseInput(root, NOW, []))).some((item) => item.kind === "agent_completed"), false);

  await writeActivity(root, "main_codex", "codex", {
    state: "active",
    event_name: "PreToolUse",
    updated_at: "2026-06-06T11:59:30.000Z",
    provider_session_id: "main-short",
    diagnostics: { tool_name: "Bash" }
  });
  await source.collect(baseInput(root, new Date("2026-06-06T11:59:30.000Z"), []));
  await writeActivity(root, "main_codex", "codex", {
    state: "idle",
    event_name: "Stop",
    updated_at: NOW.toISOString(),
    provider_session_id: "main-short",
    diagnostics: {}
  });
  assert.equal((await source.collect(baseInput(root, NOW, []))).some((item) => item.kind === "agent_completed"), false);

  await writeActivity(root, "main_codex", "codex", {
    state: "active",
    event_name: "PreToolUse",
    updated_at: "2026-06-06T11:58:50.000Z",
    provider_session_id: "main-long",
    diagnostics: { tool_name: "Bash" }
  });
  await source.collect(baseInput(root, new Date("2026-06-06T11:58:50.000Z"), []));
  await writeActivity(root, "main_codex", "codex", {
    state: "idle",
    event_name: "Stop",
    updated_at: NOW.toISOString(),
    provider_session_id: "main-long",
    diagnostics: {}
  });
  const completed = await source.collect(baseInput(root, NOW, []));
  assert.equal(completed.filter((item) => item.kind === "agent_completed").length, 1);
  assert.equal((await source.collect(baseInput(root, NOW, []))).filter((item) => item.kind === "agent_completed").length, 1);

  const restarted = new ProviderActivitySource();
  assert.equal((await restarted.collect(baseInput(root, NOW, []))).some((item) => item.kind === "agent_completed"), false);
});

test("main agent completed item is removed after ack and does not revive", async () => {
  const root = await createProjectRoot();
  const source = new ProviderActivitySource();

  await writeActivity(root, "main_codex", "codex", {
    state: "active",
    event_name: "PreToolUse",
    updated_at: "2026-06-06T11:58:50.000Z",
    provider_session_id: "main-ack",
    diagnostics: { tool_name: "Bash" }
  });
  await source.collect(baseInput(root, new Date("2026-06-06T11:58:50.000Z"), []));
  await writeActivity(root, "main_codex", "codex", {
    state: "idle",
    event_name: "Stop",
    updated_at: NOW.toISOString(),
    provider_session_id: "main-ack",
    diagnostics: {}
  });

  const completed = await source.collect(baseInput(root, NOW, []));
  const completedRef = completed.find((item) => item.kind === "agent_completed")?.ref;
  assert.ok(completedRef);
  assert.equal((await source.collect(baseInput(root, NOW, []))).some((item) => item.ref === completedRef), true);

  const afterAck = await source.collect({
    ...baseInput(root, NOW, []),
    ackedRefs: new Set([completedRef])
  });
  assert.equal(afterAck.some((item) => item.ref === completedRef), false);
  assert.equal((await source.collect(baseInput(root, NOW, []))).some((item) => item.ref === completedRef), false);
});

test("input debounce entries expire after TTL since last access", async () => {
  const root = await createProjectRoot();
  const source = new ProviderActivitySource();
  const slot = slotBinding("slot-1", "bound");

  await writeActivity(root, "slot1_codex", "codex", {
    state: "pending",
    event_name: "Notification",
    updated_at: "2026-06-06T11:58:50.000Z",
    provider_session_id: "session-input-ttl",
    diagnostics: {}
  });

  assert.equal((await source.collect(baseInput(root, NOW, [slot]))).some((item) => item.metadata?.reason === "input"), false);
  assert.equal(
    (await source.collect(baseInput(root, new Date("2026-06-06T12:00:10.000Z"), [slot]))).some(
      (item) => item.metadata?.reason === "input"
    ),
    true
  );
  assert.equal(
    (await source.collect(baseInput(root, new Date("2026-06-06T12:10:11.000Z"), [slot]))).some(
      (item) => item.metadata?.reason === "input"
    ),
    false
  );
  assert.equal(
    (await source.collect(baseInput(root, new Date("2026-06-06T12:10:21.000Z"), [slot]))).some(
      (item) => item.metadata?.reason === "input"
    ),
    true
  );
});

test("suspect fallback is warning-only for busy slot with submitted job and stale activity", async () => {
  const root = await createProjectRoot();
  const source = new ProviderActivitySource();
  const dispatch = dispatchRow("job-suspect", "slot-1");
  await writeActivity(root, "slot1_codex", "codex", {
    state: "active",
    event_name: "PreToolUse",
    updated_at: "2026-06-06T11:58:30.000Z",
    provider_session_id: "session-suspect",
    diagnostics: { tool_name: "Bash" }
  });

  let items = await source.collect(baseInput(root, NOW, [slotBinding("slot-1", "busy")], [dispatch]));
  assert.equal(items[0]?.kind, "agent_attention_suspect");
  assert.equal(items[0]?.severity, "warning");

  items = await source.collect(baseInput(root, NOW, [slotBinding("slot-1", "bound")], [dispatch]));
  assert.equal(items.some((item) => item.kind === "agent_attention_suspect"), false);

  items = await source.collect(baseInput(root, NOW, [slotBinding("slot-1", "busy")], []));
  assert.equal(items.some((item) => item.kind === "agent_attention_suspect"), false);

  items = await source.collect(baseInput(root, NOW, [slotBinding("slot-1", "busy")], [
    { ...dispatch, jobId: "job-other-requirement", subjectId: "req-other" }
  ]));
  assert.equal(items.some((item) => item.kind === "agent_attention_suspect"), false);
});

async function createProjectRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ccb-provider-activity-"));
  await mkdir(join(root, ".ccb"), { recursive: true });
  await writeFile(join(root, ".ccb", "ccb.config"), CONFIG, "utf8");
  return root;
}

async function writeActivity(
  root: string,
  agentName: string,
  provider: string,
  payload: Record<string, unknown>
) {
  const dir = join(root, ".ccb", "agents", agentName, "provider-runtime", provider);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "activity.json"),
    JSON.stringify({
      schema_version: 1,
      record_type: "provider_activity",
      agent_name: agentName,
      provider,
      ...payload
    }),
    "utf8"
  );
}

function baseInput(
  root: string,
  now: Date,
  slotBindings: ProviderActivitySlotBinding[],
  dispatchRows: ProviderActivityDispatchRow[] = []
) {
  return {
    projectId: "project-1",
    projectRoot: root,
    now,
    slotBindings,
    dispatchRows,
    taskRequirementByTaskId: new Map<string, string | null>(),
    requirementTitleById: new Map([["req-1", "测试需求"]])
  };
}

function slotBinding(
  slotId: string,
  state: string,
  requirementId: string | null = "req-1"
): ProviderActivitySlotBinding {
  return {
    projectId: "project-1",
    slotId,
    requirementId,
    state,
    busySince: state === "busy" ? new Date("2026-06-06T11:58:00.000Z") : null,
    lastActivityAt: new Date("2026-06-06T11:59:00.000Z"),
    updatedAt: new Date("2026-06-06T11:59:00.000Z"),
    requirement: requirementId ? { title: "测试需求" } : null
  };
}

function dispatchRow(jobId: string, anchorId: string): ProviderActivityDispatchRow {
  return {
    jobId,
    anchorId,
    subjectType: "requirement",
    subjectId: "req-1",
    status: "submitted",
    queuedAt: new Date("2026-06-06T11:57:00.000Z"),
    submittedAt: new Date("2026-06-06T11:57:10.000Z")
  };
}
