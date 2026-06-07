import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, test, vi } from "vitest";

import { prisma } from "../../db/prisma.js";
import type { CcbdLauncherService } from "../anchor-lifecycle/ccbd-launcher.service.js";
import { defaultSlotTipsPeriodicSyncService } from "../slot-binding/slot-tips-projection.service.js";
import { ProjectCcbdConfigDriftError, ProjectCcbdManager } from "./project-ccbd-manager.js";

const tmpRoots: string[] = [];

async function resetDatabase(): Promise<void> {
  await prisma.anchorDispatchQueue.deleteMany();
  await prisma.eventJournal.deleteMany();
  await prisma.slotBinding.deleteMany();
  await prisma.task.deleteMany();
  await prisma.requirement.deleteMany();
  await prisma.anchorAllocation.deleteMany();
  await prisma.project.deleteMany();
}

async function createProjectWithRoot(): Promise<{ projectId: string; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "ccb-project-ccbd-"));
  tmpRoots.push(root);
  const project = await prisma.project.create({
    data: {
      name: `project-ccbd-${randomUUID()}`,
      localPath: root
    }
  });
  return { projectId: project.id, root };
}

function launcher(start = vi.fn(async (projectRoot: string) => ({ pid: 123, socketPath: join(projectRoot, ".ccb", "ccbd", "ccbd.sock") }))) {
  return {
    start,
    kill: vi.fn(async () => ({ stdout: "", stderr: "" }))
  } as unknown as CcbdLauncherService;
}

beforeEach(async () => {
  await resetDatabase();
});

afterEach(async () => {
  defaultSlotTipsPeriodicSyncService.dispose();
  await resetDatabase();
  await Promise.all(tmpRoots.map((root) => rm(root, { recursive: true, force: true })));
  tmpRoots.length = 0;
});

test("ProjectCcbdManager creates missing managed config and starts one ccbd at the project root", async () => {
  const { projectId, root } = await createProjectWithRoot();
  const start = vi.fn(async (projectRoot: string) => ({ pid: 123, socketPath: join(projectRoot, ".ccb", "ccbd", "ccbd.sock") }));
  const manager = new ProjectCcbdManager(prisma, launcher(start));

  const runtime = await manager.ensureStarted(projectId);

  assert.equal(start.mock.calls.length, 1);
  assert.equal(start.mock.calls[0]?.[0], root);
  assert.equal(runtime.projectRoot, root);
  assert.equal(runtime.status, "ready");
  const config = await readFile(join(root, ".ccb", "ccb.config"), "utf8");
  assert.match(config, /^main = "main_claude:claude; main_codex:codex"$/m);
  assert.match(config, /^slot-3 = "slot3_claude:claude; slot3_codex:codex"$/m);
});

test("ProjectCcbdManager renders managed config from the project slotCount", async () => {
  const { projectId, root } = await createProjectWithRoot();
  await prisma.project.update({
    where: { id: projectId },
    data: { slotCount: 4 }
  });
  const manager = new ProjectCcbdManager(prisma, launcher());

  const runtime = await manager.ensureStarted(projectId);

  const config = await readFile(join(root, ".ccb", "ccb.config"), "utf8");
  assert.match(config, /^slot-4 = "slot4_claude:claude; slot4_codex:codex"$/m);
  assert.match(config, /^\[agents\.slot4_codex]$/m);
  assert.equal(runtime.status, "ready");
  const status = await manager.getStatus(projectId);
  assert.equal(status.config.drift, null);
});

test("ProjectCcbdManager reconciles sidebar tips from current slot bindings on startup", async () => {
  const { projectId, root } = await createProjectWithRoot();
  const requirement = await prisma.requirement.create({
    data: {
      projectId,
      title: "Startup Requirement",
      description: "startup tips fixture",
      status: "planning"
    }
  });
  await prisma.slotBinding.create({
    data: {
      projectId,
      slotId: "slot-1",
      requirementId: requirement.id,
      state: "bound"
    }
  });
  const manager = new ProjectCcbdManager(prisma, launcher());

  await manager.ensureStarted(projectId);

  const config = await readFile(join(root, ".ccb", "ccb.config"), "utf8");
  assert.match(config, /^\[ui\.sidebar\.view]$/m);
  assert.match(config, /"slot-1: Startup Requirement"/);
});

test("ProjectCcbdManager starts periodic slot tips sync on start and clears it on stop", async () => {
  const { projectId } = await createProjectWithRoot();
  const periodic = {
    start: vi.fn(),
    stop: vi.fn(),
    dispose: vi.fn()
  };
  const manager = new ProjectCcbdManager(prisma, launcher(), periodic);

  await manager.ensureStarted(projectId);
  await manager.stop(projectId);

  assert.equal(periodic.start.mock.calls.length, 1);
  assert.equal(periodic.start.mock.calls[0]?.[0], projectId);
  assert.equal(periodic.start.mock.calls[0]?.[1]?.client, prisma);
  assert.deepEqual(periodic.stop.mock.calls, [[projectId]]);
});

test("ProjectCcbdManager blocks startup on managed core drift and exposes drift status without rewriting config", async () => {
  const { projectId, root } = await createProjectWithRoot();
  await mkdir(join(root, ".ccb"), { recursive: true });
  const driftedConfig = [
    "version = 2",
    'entry_window = "main"',
    "",
    "[windows]",
    'main = "legacy_claude:claude"',
    ""
  ].join("\n");
  await writeFile(join(root, ".ccb", "ccb.config"), driftedConfig, "utf8");
  const start = vi.fn(async (projectRoot: string) => ({ pid: 123, socketPath: join(projectRoot, ".ccb", "ccbd", "ccbd.sock") }));
  const manager = new ProjectCcbdManager(prisma, launcher(start));

  await assert.rejects(() => manager.ensureStarted(projectId), ProjectCcbdConfigDriftError);

  assert.equal(start.mock.calls.length, 0);
  assert.equal(await readFile(join(root, ".ccb", "ccb.config"), "utf8"), driftedConfig);
  const status = await manager.getStatus(projectId);
  assert.equal(status.startupBlocked, true);
  assert.equal(status.config.drift?.requiresUserConfirmation, true);
  assert.match(status.config.drift?.diff ?? "", /\+ main = "main_claude:claude; main_codex:codex"/);
});

test("ProjectCcbdManager confirmRestore writes managed core after drift and starts project ccbd", async () => {
  const { projectId, root } = await createProjectWithRoot();
  await mkdir(join(root, ".ccb"), { recursive: true });
  await writeFile(
    join(root, ".ccb", "ccb.config"),
    [
      "version = 2",
      'entry_window = "main"',
      "",
      "[windows]",
      'main = "legacy_claude:claude"',
      "",
      "[agents.slot1_claude]",
      'provider = "claude"',
      'model = "sonnet"',
      ""
    ].join("\n"),
    "utf8"
  );
  const start = vi.fn(async (projectRoot: string) => ({ pid: 123, socketPath: join(projectRoot, ".ccb", "ccbd", "ccbd.sock") }));
  const manager = new ProjectCcbdManager(prisma, launcher(start));

  const result = await manager.confirmRestore(projectId);

  assert.equal(start.mock.calls.length, 1);
  assert.equal(start.mock.calls[0]?.[0], root);
  assert.equal(result.runtime.status, "ready");
  assert.equal(result.status.startupBlocked, false);
  assert.equal(result.status.config.drift, null);
  const config = await readFile(join(root, ".ccb", "ccb.config"), "utf8");
  assert.match(config, /^slot-3 = "slot3_claude:claude; slot3_codex:codex"$/m);
  assert.match(config, /^model = "sonnet"$/m);
});
