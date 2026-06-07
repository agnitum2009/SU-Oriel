import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, test, vi } from "vitest";

import { buildApp } from "../../app.js";
import { prisma } from "../../db/prisma.js";
import { renderManagedCcbConfig, projectSlotTopology } from "../project-ccbd/managed-config.service.js";
import { ManagedConfigMutationLock } from "../project-ccbd/managed-config-mutation-lock.js";
import type { CcbReloadResult } from "../slot-resize/reload-cli.js";
import { SlotResizeService, type SlotResizeRuntime } from "../slot-resize/slot-resize.service.js";
import type { SlotContextResetter } from "./slot-context-reset.service.js";

const tmpRoots: string[] = [];

async function resetDatabase(): Promise<void> {
  await prisma.anchorDispatchQueue.deleteMany();
  await prisma.eventJournal.deleteMany();
  await prisma.slotBinding.deleteMany();
  await prisma.task.deleteMany();
  await prisma.requirement.deleteMany();
  await prisma.project.deleteMany();
}

async function createProject(slotCount = 3) {
  return await prisma.project.create({
    data: {
      name: `slot-route-${randomUUID()}`,
      localPath: join(tmpdir(), `slot-route-${randomUUID()}`),
      slotCount
    }
  });
}

beforeEach(async () => {
  await resetDatabase();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tmpRoots.map((root) => rm(root, { recursive: true, force: true })));
  tmpRoots.length = 0;
});

async function createResizeProject(slotCount = 3) {
  const root = await mkdtemp(join(tmpdir(), "slot-route-resize-"));
  tmpRoots.push(root);
  const project = await prisma.project.create({
    data: {
      name: `slot-route-resize-${randomUUID()}`,
      localPath: root,
      slotCount
    }
  });
  await mkdir(join(root, ".ccb"), { recursive: true });
  await writeFile(
    join(root, ".ccb", "ccb.config"),
    renderManagedCcbConfig({
      projectId: project.id,
      projectRoot: root,
      topology: projectSlotTopology(slotCount)
    }).configText,
    "utf8"
  );
  return project;
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

function mockRuntime(overrides: Partial<SlotResizeRuntime> = {}): SlotResizeRuntime {
  return {
    isOnline: async () => true,
    waitForSlotActive: async () => true,
    hasActiveSlotJob: async () => false,
    ...overrides
  };
}

function resizeService(options: {
  runtime?: SlotResizeRuntime;
  lock?: ManagedConfigMutationLock;
  reload?: () => Promise<CcbReloadResult>;
} = {}): SlotResizeService {
  return new SlotResizeService({
    client: prisma,
    lock: options.lock ?? new ManagedConfigMutationLock(),
    runtime: options.runtime ?? mockRuntime(),
    reload: async () => options.reload ? await options.reload() : publishedReload(),
    contextResetterFactory: () => ({
      resetSlotContext: async (input) => ({
        projectId: input.projectId,
        slotId: input.slotId,
        trigger: input.trigger,
        command: input.command ?? "/new",
        agentNames: [],
        results: [],
        sent: 0,
        skipped: 0,
        failed: 0,
        status: "ok"
      })
    }),
    activeWaitTimeoutMs: 10
  });
}

test("GET /api/projects/:projectId/slots projects main lane, three slots, queue, stale, and unhealthy badges", async () => {
  const project = await createProject();
  const requirement = await prisma.requirement.create({
    data: {
      id: "req-slot-route-bound",
      projectId: project.id,
      title: "Bound Requirement",
      description: "slot route fixture",
      status: "planning"
    }
  });
  const queuedRequirement = await prisma.requirement.create({
    data: {
      id: "req-slot-route-queued",
      projectId: project.id,
      title: "Queued Requirement",
      description: "queued fixture",
      status: "planning"
    }
  });
  const otherProject = await createProject();
  const otherRequirement = await prisma.requirement.create({
    data: {
      id: "req-slot-route-other-project",
      projectId: otherProject.id,
      title: "Other Project Requirement",
      description: "other project queue fixture",
      status: "planning"
    }
  });
  await prisma.slotBinding.create({
    data: {
      projectId: project.id,
      slotId: "slot-1",
      requirementId: requirement.id,
      state: "unhealthy",
      boundAt: new Date("2026-05-20T00:00:00.000Z"),
      busySince: new Date("2026-05-21T00:00:00.000Z"),
      lastActivityAt: new Date("2026-05-10T00:00:00.000Z"),
      staleDetectedAt: new Date("2026-05-18T00:00:00.000Z"),
      staleNotifiedCount: 2
    }
  });
  await prisma.anchorDispatchQueue.create({
    data: {
      projectId: project.id,
      jobId: "job-slot-route-queued",
      anchorId: "slot-unassigned",
      subjectType: "requirement",
      subjectId: queuedRequirement.id,
      command: "/ccb:su-flow --payload {}",
      status: "pending",
      queuedAt: new Date("2026-05-22T00:00:00.000Z")
    }
  });
  await prisma.anchorDispatchQueue.create({
    data: {
      projectId: otherProject.id,
      jobId: "job-slot-route-other-project",
      anchorId: "slot-unassigned",
      subjectType: "requirement",
      subjectId: otherRequirement.id,
      command: "/ccb:su-flow --payload {}",
      status: "pending",
      queuedAt: new Date("2026-05-21T00:00:00.000Z")
    }
  });
  await prisma.eventJournal.create({
    data: {
      eventId: randomUUID(),
      eventType: "slot_runtime_degraded",
      projectId: project.id,
      subjectType: "requirement",
      subjectId: requirement.id,
      subjectKey: requirement.title,
      anchorId: "slot-1",
      payloadJson: JSON.stringify({ slotId: "slot-1", reason: "busy_timeout", severity: "error" }),
      emittedAt: new Date("2026-05-21T04:00:00.000Z"),
      sourceActor: "system",
      sourceComponent: "console"
    }
  });
  const app = buildApp({ enableFileWatcher: false });

  try {
    const response = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/slots`
    });

    assert.equal(response.statusCode, 200, response.body);
    const body = response.json() as {
      slotCount: number;
      main: { slotId: string; lane: string; canBindBusiness: boolean };
      slots: Array<{
        slotId: string;
        state: string;
        requirement: { id: string; title: string } | null;
        lastActivityAt: string | null;
        stale: { detectedAt: string; notifiedCount: number } | null;
        unhealthy: { degradedReason: string | null; severity: string | null } | null;
      }>;
      shrinkEligibility: {
        tailSlotId: string | null;
        eligible: boolean;
        checks: { slotBindingIdle: boolean; queueClear: boolean; runtimeIdle: boolean };
      };
      queue: Array<{ jobId: string; requirementId: string | null; requirementTitle: string | null }>;
    };
    assert.equal(body.slotCount, 3);
    assert.deepEqual(body.main, {
      slotId: "main",
      lane: "coordination",
      state: "available",
      canBindBusiness: false
    });
    assert.deepEqual(body.slots.map((slot) => slot.slotId), ["slot-1", "slot-2", "slot-3"]);
    assert.equal(body.slots[0].state, "unhealthy");
    assert.deepEqual(body.slots[0].requirement, { id: requirement.id, title: requirement.title });
    assert.equal(body.slots[0].lastActivityAt, "2026-05-10T00:00:00.000Z");
    assert.deepEqual(body.slots[0].stale, {
      detectedAt: "2026-05-18T00:00:00.000Z",
      notifiedCount: 2
    });
    assert.deepEqual(body.slots[0].unhealthy, {
      degradedReason: "busy_timeout",
      severity: "error",
      emittedAt: "2026-05-21T04:00:00.000Z"
    });
    assert.equal(body.slots[1].state, "idle");
    assert.equal(body.slots[1].requirement, null);
    assert.equal(body.queue.length, 1);
    assert.equal(body.queue[0].jobId, "job-slot-route-queued");
    assert.equal(body.queue[0].requirementId, queuedRequirement.id);
    assert.equal(body.queue[0].requirementTitle, queuedRequirement.title);
    assert.equal(body.shrinkEligibility.tailSlotId, "slot-3");
    assert.equal(body.shrinkEligibility.eligible, true);
    assert.deepEqual(body.shrinkEligibility.checks, {
      slotBindingIdle: true,
      queueClear: true,
      runtimeIdle: true
    });
  } finally {
    await app.close();
  }
});

test("GET /api/projects/:projectId/slots projects four lanes from project slotCount", async () => {
  const project = await createProject(4);
  const requirement = await prisma.requirement.create({
    data: {
      projectId: project.id,
      title: "Slot Four Requirement",
      description: "slot four route fixture",
      status: "planning"
    }
  });
  await prisma.slotBinding.create({
    data: {
      projectId: project.id,
      slotId: "slot-4",
      requirementId: requirement.id,
      state: "unhealthy",
      lastActivityAt: new Date("2026-05-10T00:00:00.000Z")
    }
  });
  await prisma.eventJournal.create({
    data: {
      eventId: randomUUID(),
      eventType: "slot_runtime_degraded",
      projectId: project.id,
      subjectType: "requirement",
      subjectId: requirement.id,
      subjectKey: requirement.title,
      anchorId: "slot-4",
      payloadJson: JSON.stringify({ slotId: "slot-4", reason: "busy_timeout", severity: "error" }),
      emittedAt: new Date("2026-05-21T04:00:00.000Z"),
      sourceActor: "system",
      sourceComponent: "console"
    }
  });
  const app = buildApp({ enableFileWatcher: false });

  try {
    const response = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/slots`
    });

    assert.equal(response.statusCode, 200, response.body);
    const body = response.json() as {
      slots: Array<{
        slotId: string;
        state: string;
        requirement: { id: string; title: string } | null;
        unhealthy: { degradedReason: string | null; severity: string | null } | null;
      }>;
    };
    assert.deepEqual(body.slots.map((slot) => slot.slotId), ["slot-1", "slot-2", "slot-3", "slot-4"]);
    const slotFour = body.slots.find((slot) => slot.slotId === "slot-4");
    assert.equal(slotFour?.state, "unhealthy");
    assert.deepEqual(slotFour?.requirement, { id: requirement.id, title: requirement.title });
    assert.deepEqual(slotFour?.unhealthy, {
      degradedReason: "busy_timeout",
      severity: "error",
      emittedAt: "2026-05-21T04:00:00.000Z"
    });
  } finally {
    await app.close();
  }
});

test("GET /api/projects/:projectId/slots reports tail shrink eligibility and blocks su-cancel queue rows", async () => {
  const project = await createResizeProject(4);
  const requirement = await prisma.requirement.create({
    data: {
      projectId: project.id,
      title: "Cancel queued requirement",
      description: "resize projection fixture",
      status: "planning"
    }
  });
  await prisma.anchorDispatchQueue.create({
    data: {
      projectId: project.id,
      jobId: "job-slot-route-resize-cancel",
      anchorId: "slot-4",
      subjectType: "requirement",
      subjectId: requirement.id,
      command: "/ccb:su-cancel job_123",
      status: "pending"
    }
  });
  const app = buildApp({
    enableFileWatcher: false,
    slots: {
      slotResizeService: resizeService()
    }
  });

  try {
    const response = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/slots`
    });

    assert.equal(response.statusCode, 200, response.body);
    const body = response.json() as {
      slotCount: number;
      shrinkEligibility: {
        tailSlotId: string;
        eligible: boolean;
        checks: { slotBindingIdle: boolean; queueClear: boolean; runtimeIdle: boolean };
        reasons: string[];
        details: { queueRows?: Array<{ command: string; status: string }> };
      };
    };
    assert.equal(body.slotCount, 4);
    assert.equal(body.shrinkEligibility.tailSlotId, "slot-4");
    assert.equal(body.shrinkEligibility.eligible, false);
    assert.deepEqual(body.shrinkEligibility.checks, {
      slotBindingIdle: true,
      queueClear: false,
      runtimeIdle: true
    });
    assert.deepEqual(body.shrinkEligibility.reasons, ["queue_not_empty"]);
    assert.equal(body.shrinkEligibility.details.queueRows?.[0]?.command, "/ccb:su-cancel job_123");
  } finally {
    await app.close();
  }
});

test("POST /api/projects/:projectId/slots/resize grows and shrinks topology through SlotResizeService", async () => {
  const project = await createResizeProject(3);
  const service = resizeService();
  const app = buildApp({
    enableFileWatcher: false,
    slots: {
      slotResizeService: service
    }
  });

  try {
    const grown = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/slots/resize`,
      payload: { direction: "grow" }
    });
    assert.equal(grown.statusCode, 200, grown.body);
    const grownBody = grown.json() as {
      slotCount: number;
      resize: { ok: true; direction: string; mode: string; previousSlotCount: number; nextSlotCount: number };
      slots: Array<{ slotId: string }>;
    };
    assert.equal(grownBody.slotCount, 4);
    assert.deepEqual(grownBody.slots.map((slot) => slot.slotId), ["slot-1", "slot-2", "slot-3", "slot-4"]);
    assert.equal(grownBody.resize.ok, true);
    assert.equal(grownBody.resize.direction, "grow");
    assert.equal(grownBody.resize.mode, "reloaded");
    assert.equal(grownBody.resize.previousSlotCount, 3);
    assert.equal(grownBody.resize.nextSlotCount, 4);

    const shrunk = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/slots/resize`,
      payload: { direction: "shrink" }
    });
    assert.equal(shrunk.statusCode, 200, shrunk.body);
    const shrunkBody = shrunk.json() as {
      slotCount: number;
      resize: { ok: true; direction: string; previousSlotCount: number; nextSlotCount: number };
      slots: Array<{ slotId: string }>;
    };
    assert.equal(shrunkBody.slotCount, 3);
    assert.deepEqual(shrunkBody.slots.map((slot) => slot.slotId), ["slot-1", "slot-2", "slot-3"]);
    assert.equal(shrunkBody.resize.direction, "shrink");
    assert.equal(shrunkBody.resize.previousSlotCount, 4);
    assert.equal(shrunkBody.resize.nextSlotCount, 3);
  } finally {
    await app.close();
  }
});

test("POST /api/projects/:projectId/slots/resize returns structured shrink failure with su-cancel blocker details", async () => {
  const project = await createResizeProject(4);
  const requirement = await prisma.requirement.create({
    data: {
      projectId: project.id,
      title: "Shrink blocked requirement",
      description: "resize shrink fixture",
      status: "planning"
    }
  });
  await prisma.anchorDispatchQueue.create({
    data: {
      projectId: project.id,
      jobId: "job-slot-route-shrink-cancel",
      anchorId: "slot-4",
      subjectType: "requirement",
      subjectId: requirement.id,
      command: "/ccb:su-cancel job_456",
      status: "submitted"
    }
  });
  const app = buildApp({
    enableFileWatcher: false,
    slots: {
      slotResizeService: resizeService()
    }
  });

  try {
    const response = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/slots/resize`,
      payload: { direction: "shrink" }
    });

    assert.equal(response.statusCode, 409, response.body);
    const body = response.json() as {
      ok: false;
      reason: string;
      details: { queueRows?: Array<{ command: string; status: string }> };
    };
    assert.equal(body.ok, false);
    assert.equal(body.reason, "queue_not_empty");
    assert.equal(body.details.queueRows?.[0]?.command, "/ccb:su-cancel job_456");
    assert.equal(body.details.queueRows?.[0]?.status, "submitted");
  } finally {
    await app.close();
  }
});

test("POST /api/projects/:projectId/slots/resize records offline desired grow without reload", async () => {
  const project = await createResizeProject(3);
  const reload = vi.fn(async () => publishedReload());
  const app = buildApp({
    enableFileWatcher: false,
    slots: {
      slotResizeService: resizeService({
        runtime: mockRuntime({ isOnline: async () => false }),
        reload
      })
    }
  });

  try {
    const response = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/slots/resize`,
      payload: { direction: "grow" }
    });

    assert.equal(response.statusCode, 200, response.body);
    const body = response.json() as {
      slotCount: number;
      resize: { ok: true; direction: string; mode: string; previousSlotCount: number; nextSlotCount: number };
    };
    assert.equal(body.slotCount, 4);
    assert.equal(body.resize.direction, "grow");
    assert.equal(body.resize.mode, "offline_desired");
    assert.equal(reload.mock.calls.length, 0);
  } finally {
    await app.close();
  }
});

test("POST slot release requires force reason for busy slots and releases with drain callback", async () => {
  const project = await createProject();
  const requirement = await prisma.requirement.create({
    data: {
      projectId: project.id,
      title: "Busy Requirement",
      description: "busy fixture",
      status: "planning"
    }
  });
  await prisma.slotBinding.create({
    data: {
      projectId: project.id,
      slotId: "slot-1",
      requirementId: requirement.id,
      state: "busy",
      busySince: new Date("2026-05-21T00:00:00.000Z"),
      lastActivityAt: new Date("2026-05-21T00:00:00.000Z")
    }
  });
  const app = buildApp({ enableFileWatcher: false });

  try {
    const rejected = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/slots/slot-1/release`,
      payload: { confirm: true }
    });
    assert.equal(rejected.statusCode, 409, rejected.body);

    const released = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/slots/slot-1/release`,
      payload: { confirm: true, force: true, reason: "operator confirmed stuck busy slot" }
    });
    assert.equal(released.statusCode, 200, released.body);
    const body = released.json() as { slot: { slotId: string; state: string; requirement: null } };
    assert.equal(body.slot.slotId, "slot-1");
    assert.equal(body.slot.state, "idle");
    assert.equal(body.slot.requirement, null);
    const event = await prisma.eventJournal.findFirstOrThrow({ where: { eventType: "slot_released" } });
    assert.equal(JSON.parse(event.payloadJson).operatorReason, "operator confirmed stuck busy slot");
  } finally {
    await app.close();
  }
});

test("POST slot release attempts context reset before release and continues when reset fails", async () => {
  const project = await createProject();
  const requirement = await prisma.requirement.create({
    data: {
      projectId: project.id,
      title: "Bound Requirement",
      description: "release reset fixture",
      status: "planning"
    }
  });
  await prisma.slotBinding.create({
    data: {
      projectId: project.id,
      slotId: "slot-1",
      requirementId: requirement.id,
      state: "bound",
      lastActivityAt: new Date("2026-05-21T00:00:00.000Z")
    }
  });
  const resetSlotContext = vi.fn<SlotContextResetter["resetSlotContext"]>(async (input) => {
    const row = await prisma.slotBinding.findUniqueOrThrow({
      where: {
        projectId_slotId: {
          projectId: input.projectId,
          slotId: input.slotId
        }
      }
    });
    assert.equal(row.requirementId, requirement.id);
    assert.equal(row.state, "bound");
    throw new Error("context reset failed");
  });
  const app = buildApp({
    enableFileWatcher: false,
    slots: {
      slotContextResetter: {
        resetSlotContext
      }
    }
  });

  try {
    const response = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/slots/slot-1/release`,
      payload: { confirm: true }
    });

    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(resetSlotContext.mock.calls[0]?.[0], {
      projectId: project.id,
      slotId: "slot-1",
      requirementId: requirement.id,
      trigger: "release"
    });
    const row = await prisma.slotBinding.findUniqueOrThrow({
      where: {
        projectId_slotId: {
          projectId: project.id,
          slotId: "slot-1"
        }
      }
    });
    assert.equal(row.state, "idle");
    assert.equal(row.requirementId, null);
  } finally {
    await app.close();
  }
});

test("POST requirement bind-slot claims the first idle slot and returns the refreshed slot projection", async () => {
  const project = await createProject();
  const requirement = await prisma.requirement.create({
    data: {
      projectId: project.id,
      title: "Manual Bind Requirement",
      description: "bind fixture",
      status: "planning"
    }
  });
  await prisma.slotBinding.create({
    data: {
      projectId: project.id,
      slotId: "slot-1",
      state: "bound",
      requirementId: (await prisma.requirement.create({
        data: {
          projectId: project.id,
          title: "Existing Requirement",
          description: "existing fixture",
          status: "planning"
        }
      })).id
    }
  });
  const resetSlotContext = vi.fn<SlotContextResetter["resetSlotContext"]>(async (input) => ({
    projectId: input.projectId,
    slotId: input.slotId,
    trigger: input.trigger,
    command: "/new",
    agentNames: [],
    results: [],
    sent: 0,
    skipped: 0,
    failed: 0,
    status: "ok"
  }));
  const app = buildApp({
    enableFileWatcher: false,
    slots: {
      slotContextResetter: {
        resetSlotContext
      }
    }
  });

  try {
    const response = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/requirements/${requirement.id}/bind-slot`
    });

    assert.equal(response.statusCode, 200, response.body);
    const body = response.json() as {
      slot: { slotId: string; state: string; requirement: { id: string; title: string } | null };
      slots: Array<{ slotId: string; requirement: { id: string } | null }>;
    };
    assert.equal(body.slot.slotId, "slot-2");
    assert.equal(body.slot.state, "bound");
    assert.deepEqual(body.slot.requirement, { id: requirement.id, title: requirement.title });
    assert.equal(body.slots.find((slot) => slot.slotId === "slot-2")?.requirement?.id, requirement.id);
    const event = await prisma.eventJournal.findFirstOrThrow({ where: { eventType: "slot_bound" } });
    assert.equal(event.anchorId, "slot-2");
    assert.deepEqual(resetSlotContext.mock.calls[0]?.[0], {
      projectId: project.id,
      slotId: "slot-2",
      requirementId: requirement.id,
      trigger: "bind"
    });
    const config = await readFile(join(project.localPath, ".ccb", "ccb.config"), "utf8");
    assert.match(config, /"slot-1: Existing Requirement"/);
    assert.match(config, /"slot-2: Manual Bind Requirement"/);
  } finally {
    await app.close();
  }
});

test("POST requirement bind-slot waits for an in-flight resize lock and then succeeds", async () => {
  const project = await createProject();
  const requirement = await prisma.requirement.create({
    data: {
      projectId: project.id,
      title: "Lock Wait Requirement",
      description: "lock wait fixture",
      status: "planning"
    }
  });
  const resizeLock = new ManagedConfigMutationLock();
  let releaseLock!: () => void;
  let enteredLock!: () => void;
  const entered = new Promise<void>((resolve) => {
    enteredLock = resolve;
  });
  const release = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });
  const holding = resizeLock.runExclusive(project.id, async () => {
    enteredLock();
    await release;
  });
  await entered;
  const app = buildApp({
    enableFileWatcher: false,
    slots: {
      resizeLock,
      resizeLockWaitTimeoutMs: 200
    }
  });

  try {
    const pending = app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/requirements/${requirement.id}/bind-slot`
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    releaseLock();
    await holding;
    const response = await pending;

    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().slot.slotId, "slot-1");
  } finally {
    releaseLock();
    await holding.catch(() => undefined);
    await app.close();
  }
});

test("POST requirement bind-slot returns 409 when resize lock wait times out", async () => {
  const project = await createProject();
  const requirement = await prisma.requirement.create({
    data: {
      projectId: project.id,
      title: "Lock Timeout Requirement",
      description: "lock timeout fixture",
      status: "planning"
    }
  });
  const resizeLock = new ManagedConfigMutationLock();
  let releaseLock!: () => void;
  let enteredLock!: () => void;
  const entered = new Promise<void>((resolve) => {
    enteredLock = resolve;
  });
  const release = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });
  const holding = resizeLock.runExclusive(project.id, async () => {
    enteredLock();
    await release;
  });
  await entered;
  const app = buildApp({
    enableFileWatcher: false,
    slots: {
      resizeLock,
      resizeLockWaitTimeoutMs: 5
    }
  });

  try {
    const response = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/requirements/${requirement.id}/bind-slot`
    });

    assert.equal(response.statusCode, 409, response.body);
    assert.equal(response.json().code, "SLOT_RESIZE_LOCK_TIMEOUT");
    assert.equal(await prisma.slotBinding.count({ where: { projectId: project.id } }), 0);
  } finally {
    releaseLock();
    await holding.catch(() => undefined);
    await app.close();
  }
});

test("POST slot release drains a queued requirement and syncs the final tips projection", async () => {
  const project = await createProject();
  const releasedRequirement = await prisma.requirement.create({
    data: {
      projectId: project.id,
      title: "Released Requirement",
      description: "release fixture",
      status: "planning"
    }
  });
  const queuedRequirement = await prisma.requirement.create({
    data: {
      projectId: project.id,
      title: "Queued Requirement",
      description: "queued fixture",
      status: "planning"
    }
  });
  await prisma.slotBinding.create({
    data: {
      projectId: project.id,
      slotId: "slot-1",
      requirementId: releasedRequirement.id,
      state: "bound",
      lastActivityAt: new Date("2026-05-21T00:00:00.000Z")
    }
  });
  await prisma.anchorDispatchQueue.create({
    data: {
      projectId: project.id,
      jobId: "job-slot-route-release-drain",
      anchorId: "slot-unassigned",
      subjectType: "requirement",
      subjectId: queuedRequirement.id,
      command: "/ccb:su-flow --payload {}",
      status: "pending",
      queuedAt: new Date("2026-05-22T00:00:00.000Z")
    }
  });
  const app = buildApp({ enableFileWatcher: false });

  try {
    const response = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/slots/slot-1/release`,
      payload: { confirm: true }
    });

    assert.equal(response.statusCode, 200, response.body);
    const rebound = await prisma.slotBinding.findUniqueOrThrow({
      where: { projectId_slotId: { projectId: project.id, slotId: "slot-1" } }
    });
    assert.equal(rebound.requirementId, queuedRequirement.id);
    const queued = await prisma.anchorDispatchQueue.findUniqueOrThrow({ where: { jobId: "job-slot-route-release-drain" } });
    assert.equal(queued.anchorId, "slot-1");
    const config = await readFile(join(project.localPath, ".ccb", "ccb.config"), "utf8");
    assert.match(config, /"slot-1: Queued Requirement"/);
    assert.doesNotMatch(config, /Released Requirement/);
  } finally {
    await app.close();
  }
});

test("POST requirement bind-slot returns slot full without a 500 when no idle slot exists", async () => {
  const project = await createProject();
  const target = await prisma.requirement.create({
    data: {
      projectId: project.id,
      title: "Overflow Requirement",
      description: "overflow fixture",
      status: "planning"
    }
  });
  for (let index = 0; index < 3; index++) {
    const requirement = await prisma.requirement.create({
      data: {
        projectId: project.id,
        title: `Bound Requirement ${index + 1}`,
        description: "bound fixture",
        status: "planning"
      }
    });
    await prisma.slotBinding.create({
      data: {
        projectId: project.id,
        slotId: `slot-${index + 1}`,
        requirementId: requirement.id,
        state: "bound"
      }
    });
  }
  const app = buildApp({ enableFileWatcher: false });

  try {
    const response = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/requirements/${target.id}/bind-slot`
    });

    assert.equal(response.statusCode, 409, response.body);
    assert.deepEqual(response.json(), {
      code: "SLOT_FULL",
      message: "slot 已满，去 SlotsPage 看排队"
    });
  } finally {
    await app.close();
  }
});

test("POST slot renew clears stale marker without releasing the sticky requirement", async () => {
  const project = await createProject();
  const requirement = await prisma.requirement.create({
    data: {
      projectId: project.id,
      title: "Stale Requirement",
      description: "stale fixture",
      status: "planning"
    }
  });
  await prisma.slotBinding.create({
    data: {
      projectId: project.id,
      slotId: "slot-1",
      requirementId: requirement.id,
      state: "bound",
      staleDetectedAt: new Date("2026-05-18T00:00:00.000Z"),
      staleNotifiedCount: 3,
      lastActivityAt: new Date("2026-05-10T00:00:00.000Z")
    }
  });
  const app = buildApp({ enableFileWatcher: false });

  try {
    const response = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/slots/slot-1/renew`
    });

    assert.equal(response.statusCode, 200, response.body);
    const body = response.json() as { slot: { slotId: string; state: string; stale: null; requirement: { id: string } | null } };
    assert.equal(body.slot.slotId, "slot-1");
    assert.equal(body.slot.state, "bound");
    assert.equal(body.slot.stale, null);
    assert.equal(body.slot.requirement?.id, requirement.id);
    const binding = await prisma.slotBinding.findUniqueOrThrow({
      where: { projectId_slotId: { projectId: project.id, slotId: "slot-1" } }
    });
    assert.equal(binding.requirementId, requirement.id);
    assert.equal(binding.staleDetectedAt, null);
    assert.equal(binding.staleNotifiedCount, 0);
  } finally {
    await app.close();
  }
});

test("POST slot archive enqueues su-archive for the sticky requirement without direct canonical writes", async () => {
  const project = await createProject();
  const requirement = await prisma.requirement.create({
    data: {
      projectId: project.id,
      title: "Archive Requirement",
      description: "archive fixture",
      status: "delivering"
    }
  });
  await prisma.slotBinding.create({
    data: {
      projectId: project.id,
      slotId: "slot-1",
      requirementId: requirement.id,
      state: "bound",
      staleDetectedAt: new Date("2026-05-18T00:00:00.000Z"),
      staleNotifiedCount: 1,
      lastActivityAt: new Date("2026-05-10T00:00:00.000Z")
    }
  });
  const app = buildApp({ enableFileWatcher: false });

  try {
    const response = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/slots/slot-1/archive`,
      payload: { confirm: true }
    });

    assert.equal(response.statusCode, 202, response.body);
    const body = response.json() as { jobId: string; slotId: string; requirementId: string; status: string };
    assert.equal(body.slotId, "slot-1");
    assert.equal(body.requirementId, requirement.id);
    assert.equal(body.status, "queued");
    const queued = await prisma.anchorDispatchQueue.findUniqueOrThrow({ where: { jobId: body.jobId } });
    assert.equal(queued.anchorId, "slot-1");
    assert.match(queued.command, /^\/ccb:su-archive --payload /);
    const reqAfter = await prisma.requirement.findUniqueOrThrow({ where: { id: requirement.id } });
    assert.equal(reqAfter.status, "delivering");
    const binding = await prisma.slotBinding.findUniqueOrThrow({
      where: { projectId_slotId: { projectId: project.id, slotId: "slot-1" } }
    });
    assert.equal(binding.requirementId, requirement.id);
    assert.equal(binding.state, "bound");
  } finally {
    await app.close();
  }
});

test("POST slot cancel-current-job best-effort cancels the latest submitted slot queue row", async () => {
  const project = await createProject();
  const requirement = await prisma.requirement.create({
    data: {
      projectId: project.id,
      title: "Busy Timeout Requirement",
      description: "cancel fixture",
      status: "delivering"
    }
  });
  await prisma.slotBinding.create({
    data: {
      projectId: project.id,
      slotId: "slot-1",
      requirementId: requirement.id,
      state: "unhealthy",
      busySince: new Date("2026-05-20T00:00:00.000Z"),
      lastActivityAt: new Date("2026-05-20T00:00:00.000Z")
    }
  });
  await prisma.anchorDispatchQueue.create({
    data: {
      projectId: project.id,
      jobId: "job-slot-current",
      anchorId: "slot-1",
      subjectType: "requirement",
      subjectId: requirement.id,
      command: "/ccb:su-flow --payload {}",
      status: "submitted",
      submittedAt: new Date("2026-05-20T01:00:00.000Z")
    }
  });
  const cancelCurrentJob = vi.fn(async () => ({}));
  const app = buildApp({
    enableFileWatcher: false,
    slots: {
      slotRuntime: {
        cancelCurrentJob
      }
    }
  });

  try {
    const response = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/slots/slot-1/cancel-current-job`,
      payload: { confirm: true }
    });

    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(cancelCurrentJob.mock.calls[0], [{ projectRoot: project.localPath, jobId: "job-slot-current" }]);
    assert.equal(response.json().cancelledJobId, "job-slot-current");
  } finally {
    await app.close();
  }
});
