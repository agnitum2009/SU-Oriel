import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, test, vi } from "vitest";

import { prisma } from "../../db/prisma.js";
import {
  projectSlotTopology,
  renderManagedCcbConfig
} from "../project-ccbd/managed-config.service.js";
import { ManagedConfigMutationLock } from "../project-ccbd/managed-config-mutation-lock.js";
import type {
  SlotContextResetResult,
  SlotContextResetter
} from "../slot-binding/slot-context-reset.service.js";
import type { CcbReloadResult } from "./reload-cli.js";
import {
  SlotResizeService,
  type SlotResizeReloadRunner,
  type SlotResizeResult,
  type SlotResizeRuntime,
  type SlotResizeSuccess
} from "./slot-resize.service.js";

const tmpRoots: string[] = [];

async function resetDatabase(): Promise<void> {
  await prisma.anchorDispatchQueue.deleteMany();
  await prisma.eventJournal.deleteMany();
  await prisma.slotBinding.deleteMany();
  await prisma.anchorAllocation.deleteMany();
  await prisma.task.deleteMany();
  await prisma.requirement.deleteMany();
  await prisma.project.deleteMany();
}

beforeEach(async () => {
  await resetDatabase();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await resetDatabase();
  await Promise.all(tmpRoots.map((root) => rm(root, { recursive: true, force: true })));
  tmpRoots.length = 0;
});

async function createProject(options: {
  slotCount?: number;
  slotAgentOverridesJson?: string | null;
  configOverridesJson?: string | null;
} = {}): Promise<{ projectId: string; root: string; configText: string }> {
  const slotCount = options.slotCount ?? 3;
  const root = await mkdtemp(join(tmpdir(), "ccb-slot-resize-"));
  tmpRoots.push(root);
  const project = await prisma.project.create({
    data: {
      name: `slot-resize-${randomUUID()}`,
      localPath: root,
      slotCount,
      slotAgentOverridesJson: options.slotAgentOverridesJson ?? null
    }
  });
  const configText = renderManagedCcbConfig({
    projectId: project.id,
    projectRoot: root,
    topology: projectSlotTopology(slotCount),
    slotAgentOverridesJson: options.configOverridesJson ?? options.slotAgentOverridesJson ?? null
  }).configText;
  await writeConfig(root, configText);
  return { projectId: project.id, root, configText };
}

async function writeConfig(root: string, configText: string): Promise<void> {
  await mkdir(join(root, ".ccb"), { recursive: true });
  await writeFile(configPath(root), configText, "utf8");
}

async function readConfig(root: string): Promise<string> {
  return await readFile(configPath(root), "utf8");
}

function configPath(root: string): string {
  return join(root, ".ccb", "ccb.config");
}

function publishedReload(): CcbReloadResult {
  return {
    ok: true,
    status: "published",
    dryRun: false,
    mutationEnabled: true,
    planClass: "add_window",
    safeToApply: true,
    futureSafeToApply: true,
    operations: [],
    blocked: [],
    reasons: [],
    diagnostics: [],
    rawStdout: "reload_status: published\n",
    rawStderr: "",
    exitCode: 0,
    errorMessage: null
  };
}

function rejectedReload(): CcbReloadResult {
  return {
    ...publishedReload(),
    ok: false,
    status: "blocked",
    safeToApply: false,
    blocked: ["unsafe"],
    errorMessage: "ccb reload status=blocked exitCode=0"
  };
}

function mockRuntime(overrides: Partial<SlotResizeRuntime> = {}): SlotResizeRuntime {
  return {
    isOnline: async () => true,
    waitForSlotActive: async () => true,
    hasActiveSlotJob: async () => false,
    ...overrides
  };
}

function contextResetResult(input: Parameters<SlotContextResetter["resetSlotContext"]>[0]): SlotContextResetResult {
  return {
    projectId: input.projectId,
    slotId: input.slotId,
    trigger: input.trigger,
    command: input.command ?? "/new",
    agentNames: ["slot4_claude", "slot4_codex"],
    results: [],
    sent: 0,
    skipped: 0,
    failed: 0,
    status: "ok"
  };
}

function createService(options: {
  reload?: SlotResizeReloadRunner;
  runtime?: SlotResizeRuntime;
  lock?: ManagedConfigMutationLock;
} = {}): {
  service: SlotResizeService;
  reload: SlotResizeReloadRunner;
  resetSlotContext: SlotContextResetter["resetSlotContext"];
} {
  const reload = options.reload ?? vi.fn<SlotResizeReloadRunner>(async () => publishedReload());
  const resetSlotContext = vi.fn<SlotContextResetter["resetSlotContext"]>(async (input) => contextResetResult(input));
  const service = new SlotResizeService({
    client: prisma,
    lock: options.lock ?? new ManagedConfigMutationLock(),
    reload,
    runtime: options.runtime ?? mockRuntime(),
    contextResetterFactory: () => ({ resetSlotContext }),
    activeWaitTimeoutMs: 10
  });
  return { service, reload, resetSlotContext };
}

function assertSuccess(result: SlotResizeResult): asserts result is SlotResizeSuccess {
  assert.equal(result.ok, true, result.ok ? undefined : result.reason);
}

function assertFailure(result: SlotResizeResult, reason: string): void {
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, reason);
  }
}

async function createRequirement(projectId: string): Promise<string> {
  const requirement = await prisma.requirement.create({
    data: {
      projectId,
      title: `Requirement ${randomUUID()}`,
      description: "slot resize fixture",
      status: "planning"
    }
  });
  return requirement.id;
}

test("grow writes expanded config, reloads, updates DB, waits for active slot, and resets context", async () => {
  const overridesJson = JSON.stringify({
    slot4_codex: { profile: "\"reviewer\"" }
  });
  const { projectId, root } = await createProject({ slotCount: 3, slotAgentOverridesJson: overridesJson });
  const { service, reload, resetSlotContext } = createService();

  const result = await service.grow(projectId);

  assertSuccess(result);
  assert.equal(result.direction, "grow");
  assert.equal(result.mode, "reloaded");
  assert.equal(result.previousSlotCount, 3);
  assert.equal(result.nextSlotCount, 4);
  assert.equal(vi.mocked(reload).mock.calls[0]?.[0].projectRoot, root);
  assert.deepEqual(vi.mocked(resetSlotContext).mock.calls[0]?.[0], {
    projectId,
    slotId: "slot-4",
    trigger: "bind"
  });
  const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
  assert.equal(project.slotCount, 4);
  const config = await readConfig(root);
  assert.match(config, /^slot-4 = "slot4_claude:claude; slot4_codex:codex"$/m);
  assert.match(config, /^\[agents\.slot4_codex]$/m);
  assert.match(config, /^profile = "reviewer"$/m);
});

test("grow rolls back config when reload is rejected and leaves DB unchanged", async () => {
  const { projectId, root, configText } = await createProject({ slotCount: 3 });
  const reload = vi.fn<SlotResizeReloadRunner>(async () => rejectedReload());
  const { service } = createService({ reload });

  const result = await service.grow(projectId);

  assertFailure(result, "reload_rejected");
  const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
  assert.equal(project.slotCount, 3);
  assert.equal(await readConfig(root), configText);
});

test("grow records offline desired state without invoking reload", async () => {
  const { projectId, root } = await createProject({ slotCount: 3 });
  const reload = vi.fn<SlotResizeReloadRunner>(async () => publishedReload());
  const { service } = createService({
    reload,
    runtime: mockRuntime({ isOnline: async () => false })
  });

  const result = await service.grow(projectId);

  assertSuccess(result);
  assert.equal(result.mode, "offline_desired");
  assert.equal(vi.mocked(reload).mock.calls.length, 0);
  const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
  assert.equal(project.slotCount, 4);
  assert.match(await readConfig(root), /^slot-4 = "slot4_claude:claude; slot4_codex:codex"$/m);
});

test("grow rolls back config when reload throws", async () => {
  const { projectId, root, configText } = await createProject({ slotCount: 3 });
  const reload = vi.fn<SlotResizeReloadRunner>(async () => {
    throw new Error("reload crashed");
  });
  const { service } = createService({ reload });

  const result = await service.grow(projectId);

  assertFailure(result, "reload_failed");
  const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
  assert.equal(project.slotCount, 3);
  assert.equal(await readConfig(root), configText);
});

test("shrink blocks when the tail slot binding is not idle", async () => {
  const { projectId } = await createProject({ slotCount: 4 });
  const requirementId = await createRequirement(projectId);
  await prisma.slotBinding.create({
    data: {
      projectId,
      slotId: "slot-4",
      requirementId,
      state: "bound"
    }
  });
  const { service } = createService();

  const result = await service.shrink(projectId);

  assertFailure(result, "slot_not_idle");
});

test.each([
  ["pending", "/ccb:su-flow --payload {}"],
  ["submitted", "/ccb:su-flow --payload {}"],
  ["pending", "/ccb:su-cancel job_123"]
])("shrink blocks %s queue row: %s", async (status, command) => {
  const { projectId } = await createProject({ slotCount: 4 });
  const requirementId = await createRequirement(projectId);
  await prisma.anchorDispatchQueue.create({
    data: {
      projectId,
      jobId: `job_${randomUUID()}`,
      anchorId: "slot-4",
      subjectType: "requirement",
      subjectId: requirementId,
      command,
      status
    }
  });
  const { service } = createService();

  const result = await service.shrink(projectId);

  assertFailure(result, "queue_not_empty");
});

test("shrink blocks when runtime still has an active tail slot job", async () => {
  const { projectId } = await createProject({ slotCount: 4 });
  const { service } = createService({
    runtime: mockRuntime({ hasActiveSlotJob: async () => true })
  });

  const result = await service.shrink(projectId);

  assertFailure(result, "runtime_job_active");
});

test("shrink harvests tail slot overrides, updates DB and config, then reloads", async () => {
  const slot4OverridesJson = JSON.stringify({
    slot4_claude: {
      model: "\"sonnet\"",
      startup_args: "[\"--permission-mode\", \"acceptEdits\"]"
    },
    slot4_codex: { profile: "\"reviewer\"" }
  });
  const { projectId, root } = await createProject({
    slotCount: 4,
    configOverridesJson: slot4OverridesJson
  });
  const { service, reload } = createService();

  const result = await service.shrink(projectId);

  assertSuccess(result);
  assert.equal(result.direction, "shrink");
  assert.equal(result.mode, "reloaded");
  assert.equal(result.previousSlotCount, 4);
  assert.equal(result.nextSlotCount, 3);
  assert.equal(vi.mocked(reload).mock.calls[0]?.[0].projectRoot, root);
  const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
  assert.equal(project.slotCount, 3);
  assert.deepEqual(JSON.parse(project.slotAgentOverridesJson ?? "{}"), {
    slot4_claude: {
      model: "\"sonnet\"",
      startup_args: "[\"--permission-mode\", \"acceptEdits\"]"
    },
    slot4_codex: { profile: "\"reviewer\"" }
  });
  const config = await readConfig(root);
  assert.doesNotMatch(config, /^slot-4 = /m);
  assert.doesNotMatch(config, /^\[agents\.slot4_/m);
});

test("shrink restores DB and config when reload is rejected", async () => {
  const { projectId, root, configText } = await createProject({ slotCount: 4 });
  const reload = vi.fn<SlotResizeReloadRunner>(async () => rejectedReload());
  const { service } = createService({ reload });

  const result = await service.shrink(projectId);

  assertFailure(result, "reload_rejected");
  const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
  assert.equal(project.slotCount, 4);
  assert.equal(project.slotAgentOverridesJson, null);
  assert.equal(await readConfig(root), configText);
});

test("resize operations for the same project are serialized by the mutation lock", async () => {
  const { projectId } = await createProject({ slotCount: 3 });
  let activeReloads = 0;
  let maxActiveReloads = 0;
  const reload = vi.fn<SlotResizeReloadRunner>(async () => {
    activeReloads += 1;
    maxActiveReloads = Math.max(maxActiveReloads, activeReloads);
    await new Promise((resolve) => setTimeout(resolve, 20));
    activeReloads -= 1;
    return publishedReload();
  });
  const { service } = createService({
    reload,
    lock: new ManagedConfigMutationLock()
  });

  const [first, second] = await Promise.all([
    service.grow(projectId),
    service.grow(projectId)
  ]);

  assertSuccess(first);
  assertSuccess(second);
  assert.equal(maxActiveReloads, 1);
  const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
  assert.equal(project.slotCount, 5);
});
