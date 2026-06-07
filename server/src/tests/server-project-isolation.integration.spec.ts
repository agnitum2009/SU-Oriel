import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Fastify from "fastify";
import { afterEach, beforeEach, test, vi } from "vitest";

import { buildApp } from "../app.js";
import { prisma } from "../db/prisma.js";
import { registerAnchorTerminalRoutes } from "../modules/anchor-terminal/anchor-terminal.routes.js";
import type { AnchorTerminalManager } from "../modules/anchor-terminal/terminal-manager.js";
import { CcbdClientService } from "../modules/ccbd-client/ccbd-client.service.js";
import { JobSlotRouter } from "../modules/slot-binding/job-slot-router.js";
import { SlotBindingService } from "../modules/slot-binding/slot-binding.service.js";
import { SlotContextResetService } from "../modules/slot-binding/slot-context-reset.service.js";
import {
  projectSlotTopology,
  renderManagedCcbConfig
} from "../modules/project-ccbd/managed-config.service.js";
import type { CcbReloadResult } from "../modules/slot-resize/reload-cli.js";
import { SlotResizeService, type SlotResizeRuntime } from "../modules/slot-resize/slot-resize.service.js";
import {
  createFakeProjectCcbd,
  createFakeTmuxRunner,
  type FakeProjectCcbd
} from "./fixtures/per-project-ccbd-sockets.js";

const tmpRoots: string[] = [];
const fakeProjects: FakeProjectCcbd[] = [];

async function resetDatabase(): Promise<void> {
  await prisma.anchorDispatchQueue.deleteMany();
  await prisma.eventJournal.deleteMany();
  await prisma.userIntent.deleteMany();
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
  await Promise.all(fakeProjects.splice(0).map((project) => project.close()));
  await Promise.all(tmpRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createProjectFixture(slotCount = 3): Promise<{
  project: { id: string; localPath: string; slotCount: number };
  fake: FakeProjectCcbd;
}> {
  const root = await mkdtemp(join(tmpdir(), "server-isolation-project-"));
  tmpRoots.push(root);
  const project = await prisma.project.create({
    data: {
      name: `server-isolation-${randomUUID()}`,
      localPath: root,
      slotCount
    },
    select: {
      id: true,
      localPath: true,
      slotCount: true
    }
  });
  await writeManagedConfig(project);
  const fake = await createFakeProjectCcbd({
    projectId: project.id,
    projectRoot: root,
    maxSlotCount: 4
  });
  fakeProjects.push(fake);
  return { project, fake };
}

async function writeManagedConfig(project: { id: string; localPath: string; slotCount: number }): Promise<void> {
  await mkdir(join(project.localPath, ".ccb"), { recursive: true });
  await writeFile(
    join(project.localPath, ".ccb", "ccb.config"),
    renderManagedCcbConfig({
      projectId: project.id,
      projectRoot: project.localPath,
      topology: projectSlotTopology(project.slotCount)
    }).configText,
    "utf8"
  );
}

async function createRequirement(projectId: string, title = `Requirement ${randomUUID()}`) {
  return await prisma.requirement.create({
    data: {
      projectId,
      title,
      description: "server isolation fixture",
      status: "planning"
    }
  });
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

function slotContextResetter(projects: FakeProjectCcbd[]): SlotContextResetService {
  return new SlotContextResetService({
    runTmux: createFakeTmuxRunner(projects)
  });
}

function slotResizeService(projects: FakeProjectCcbd[]): SlotResizeService {
  const runtime: SlotResizeRuntime = {
    isOnline: async (projectRoot) => {
      await new CcbdClientService({ projectRoot }).ping("ccbd");
      return true;
    },
    waitForSlotActive: async ({ projectRoot }) => {
      await new CcbdClientService({ projectRoot }).projectView();
      return true;
    },
    hasActiveSlotJob: async () => false
  };
  return new SlotResizeService({
    client: prisma,
    runtime,
    reload: vi.fn(async () => publishedReload()),
    contextResetterFactory: () => slotContextResetter(projects),
    activeWaitTimeoutMs: 10
  });
}

function resetSocketRecords(projects: FakeProjectCcbd[]): void {
  for (const project of projects) {
    project.resetRecords();
  }
}

function assertOnlyProjectWrote(input: {
  target: FakeProjectCcbd;
  other: FakeProjectCcbd;
  minCcbdRequests?: number;
  minTmuxCommands?: number;
  expectedCcbdOps?: string[];
  expectedTmuxLiteral?: string;
}): void {
  assert.equal(input.other.requests.length, 0, `unexpected ccbd writes to ${input.other.projectId}`);
  assert.equal(input.other.tmuxCommands.length, 0, `unexpected tmux writes to ${input.other.projectId}`);
  assert.equal(input.target.requests.length >= (input.minCcbdRequests ?? 0), true);
  assert.equal(input.target.tmuxCommands.length >= (input.minTmuxCommands ?? 0), true);
  for (const op of input.expectedCcbdOps ?? []) {
    assert.equal(input.target.requests.some((request) => request.op === op), true, `missing ccbd op ${op}`);
  }
  if (input.expectedTmuxLiteral) {
    assert.equal(
      input.target.tmuxCommands.some((command) => command.args.includes("-l") && command.args.includes(input.expectedTmuxLiteral ?? "")),
      true,
      `missing tmux literal ${input.expectedTmuxLiteral}`
    );
  }
}

test("bind, release, resize, and cancel-current-job write only to the target project runtime", async () => {
  const first = await createProjectFixture(3);
  const second = await createProjectFixture(3);
  const projects = [first.fake, second.fake];
  const app = buildApp({
    enableFileWatcher: false,
    slots: {
      slotContextResetter: slotContextResetter(projects),
      slotResizeService: slotResizeService(projects)
    }
  });

  try {
    const bindRequirement = await createRequirement(first.project.id, "Bind target requirement");
    resetSocketRecords(projects);
    const bound = await app.inject({
      method: "POST",
      url: `/api/projects/${first.project.id}/requirements/${bindRequirement.id}/bind-slot`
    });
    assert.equal(bound.statusCode, 200, bound.body);
    assertOnlyProjectWrote({
      target: first.fake,
      other: second.fake,
      minCcbdRequests: 1,
      minTmuxCommands: 8,
      expectedCcbdOps: ["project_view"],
      expectedTmuxLiteral: "/new"
    });

    resetSocketRecords(projects);
    const released = await app.inject({
      method: "POST",
      url: `/api/projects/${first.project.id}/slots/slot-1/release`,
      payload: { confirm: true }
    });
    assert.equal(released.statusCode, 200, released.body);
    assertOnlyProjectWrote({
      target: first.fake,
      other: second.fake,
      minCcbdRequests: 1,
      minTmuxCommands: 8,
      expectedCcbdOps: ["project_view"],
      expectedTmuxLiteral: "/new"
    });

    resetSocketRecords(projects);
    const resized = await app.inject({
      method: "POST",
      url: `/api/projects/${first.project.id}/slots/resize`,
      payload: { direction: "grow" }
    });
    assert.equal(resized.statusCode, 200, resized.body);
    assert.equal(resized.json().resize.direction, "grow");
    assertOnlyProjectWrote({
      target: first.fake,
      other: second.fake,
      minCcbdRequests: 2,
      minTmuxCommands: 8,
      expectedCcbdOps: ["ping", "project_view"],
      expectedTmuxLiteral: "/new"
    });

    const cancelRequirement = await createRequirement(first.project.id, "Cancel target requirement");
    await prisma.slotBinding.create({
      data: {
        projectId: first.project.id,
        slotId: "slot-2",
        requirementId: cancelRequirement.id,
        state: "busy",
        busySince: new Date("2026-06-01T00:00:00.000Z")
      }
    });
    await prisma.anchorDispatchQueue.create({
      data: {
        projectId: first.project.id,
        jobId: "job-target-cancel",
        anchorId: "slot-2",
        subjectType: "requirement",
        subjectId: cancelRequirement.id,
        command: "/ccb:su-flow --payload {}",
        status: "submitted",
        submittedAt: new Date("2026-06-01T00:00:00.000Z")
      }
    });
    const otherRequirement = await createRequirement(second.project.id, "Other project cancel requirement");
    await prisma.slotBinding.create({
      data: {
        projectId: second.project.id,
        slotId: "slot-2",
        requirementId: otherRequirement.id,
        state: "busy",
        busySince: new Date("2026-06-01T00:00:00.000Z")
      }
    });
    await prisma.anchorDispatchQueue.create({
      data: {
        projectId: second.project.id,
        jobId: "job-other-cancel",
        anchorId: "slot-2",
        subjectType: "requirement",
        subjectId: otherRequirement.id,
        command: "/ccb:su-flow --payload {}",
        status: "submitted",
        submittedAt: new Date("2026-06-01T00:00:00.000Z")
      }
    });

    resetSocketRecords(projects);
    const cancelled = await app.inject({
      method: "POST",
      url: `/api/projects/${first.project.id}/slots/slot-2/cancel-current-job`,
      payload: { confirm: true }
    });
    assert.equal(cancelled.statusCode, 200, cancelled.body);
    assert.equal(cancelled.json().cancelledJobId, "job-target-cancel");
    assertOnlyProjectWrote({
      target: first.fake,
      other: second.fake,
      minCcbdRequests: 1,
      expectedCcbdOps: ["cancel"]
    });
    assert.equal(first.fake.requests.find((request) => request.op === "cancel")?.request.job_id, "job-target-cancel");
  } finally {
    await app.close();
  }
});

test("JobSlotRouter tick drains only the requested project's queue", async () => {
  const first = await createProjectFixture(3);
  const second = await createProjectFixture(3);
  const slotBinding = new SlotBindingService(prisma, {
    onSlotBound: null,
    onSlotReleased: null
  });
  const firstRequirements = [
    await createRequirement(first.project.id, "First bound 1"),
    await createRequirement(first.project.id, "First bound 2"),
    await createRequirement(first.project.id, "First bound 3"),
    await createRequirement(first.project.id, "First queued")
  ];
  const secondRequirements = [
    await createRequirement(second.project.id, "Second bound 1"),
    await createRequirement(second.project.id, "Second bound 2"),
    await createRequirement(second.project.id, "Second bound 3"),
    await createRequirement(second.project.id, "Second queued")
  ];
  for (const requirement of firstRequirements.slice(0, 3)) {
    await slotBinding.bindRequirement({ projectId: first.project.id, requirementId: requirement.id });
  }
  for (const requirement of secondRequirements.slice(0, 3)) {
    await slotBinding.bindRequirement({ projectId: second.project.id, requirementId: requirement.id });
  }
  const router = new JobSlotRouter({ prismaClient: prisma, slotBinding });
  const firstQueued = await router.enqueue({
    projectId: first.project.id,
    requirementId: firstRequirements[3].id,
    subjectType: "requirement",
    subjectId: firstRequirements[3].id,
    command: "/ccb:su-flow --payload {}"
  });
  const secondQueued = await router.enqueue({
    projectId: second.project.id,
    requirementId: secondRequirements[3].id,
    subjectType: "requirement",
    subjectId: secondRequirements[3].id,
    command: "/ccb:su-flow --payload {}"
  });
  await slotBinding.releaseSlot({
    projectId: first.project.id,
    slotId: "slot-1",
    reason: "manual_release",
    releasedBy: "user"
  });

  const result = await router.tick(first.project.id);

  assert.equal(result.submitted, 1);
  const drained = await prisma.anchorDispatchQueue.findUniqueOrThrow({ where: { jobId: firstQueued.jobId } });
  assert.equal(drained.projectId, first.project.id);
  assert.equal(drained.anchorId, "slot-1");
  const untouched = await prisma.anchorDispatchQueue.findUniqueOrThrow({ where: { jobId: secondQueued.jobId } });
  assert.equal(untouched.projectId, second.project.id);
  assert.equal(untouched.anchorId, "slot-unassigned");
  assert.equal(untouched.status, "pending");
});

test("anchor-terminal rejects cross-project anchor before manager attach", async () => {
  const first = await createProjectFixture(3);
  const second = await createProjectFixture(3);
  const anchor = await prisma.anchorAllocation.create({
    data: {
      projectId: first.project.id,
      anchorId: `anchor-${randomUUID()}`,
      anchorPath: join(first.project.localPath, "anchor-worktree"),
      subjectType: "subtask",
      subjectId: "task-1",
      subjectKey: "task-1",
      mode: "execution",
      socketPath: first.fake.ccbdSocketPath,
      state: "ready"
    }
  });
  const listPanes = vi.fn(async () => []);
  const app = Fastify();
  await app.register(registerAnchorTerminalRoutes, {
    manager: { listPanes } as unknown as AnchorTerminalManager
  });

  try {
    const response = await app.inject({
      method: "GET",
      url: `/api/anchor-terminal/panes?anchorId=${encodeURIComponent(anchor.anchorId)}&projectId=${encodeURIComponent(second.project.id)}`
    });

    assert.equal(response.statusCode, 403, response.body);
    assert.equal(listPanes.mock.calls.length, 0);
  } finally {
    await app.close();
  }
});
