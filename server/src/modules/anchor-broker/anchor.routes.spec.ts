import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, test, vi } from "vitest";

import { buildApp } from "../../app.js";
import { prisma } from "../../db/prisma.js";
import type { MultiAnchorBrokerService } from "./broker.service.js";

async function resetFixtures(): Promise<void> {
  await prisma.anchorAllocation.deleteMany();
  await prisma.task.deleteMany();
  await prisma.requirement.deleteMany();
  await prisma.project.deleteMany();
}

async function createProjectFixture(prefix: string) {
  const suffix = randomUUID();
  return await prisma.project.create({
    data: {
      name: `${prefix}-${suffix}`,
      localPath: join(tmpdir(), `ccb-${prefix}-${suffix}`)
    }
  });
}

async function createRequirementFixture() {
  const project = await createProjectFixture("anchor-route-requirement");
  const requirement = await prisma.requirement.create({
    data: {
      projectId: project.id,
      title: `Route Requirement ${randomUUID()}`,
      description: "Planning anchor requirement",
      status: "planning",
      currentPlanningStep: "analysis"
    }
  });
  return { project, requirement };
}

async function createSubtaskFixture() {
  const project = await createProjectFixture("anchor-route-subtask");
  const requirement = await prisma.requirement.create({
    data: {
      projectId: project.id,
      title: `Parent Requirement ${randomUUID()}`,
      description: "Subtask parent requirement",
      status: "delivering"
    }
  });
  const subtask = await prisma.task.create({
    data: {
      projectId: project.id,
      requirementId: requirement.id,
      taskKey: `subtask-${randomUUID()}`,
      title: "Route Subtask",
      status: "reviewing",
      currentNode: "dispatch",
      runtimeState: "running"
    }
  });
  return { project, requirement, subtask };
}

beforeEach(async () => {
  await resetFixtures();
});

test("GET /api/anchors projects SlotBinding rows with slotId for compat readers", async () => {
  const { project, requirement } = await createRequirementFixture();
  await prisma.slotBinding.create({
    data: {
      projectId: project.id,
      slotId: "slot-1",
      requirementId: requirement.id,
      state: "bound",
      boundAt: new Date(),
      lastActivityAt: new Date()
    }
  });
  const app = buildApp({ enableFileWatcher: false });

  try {
    const response = await app.inject({
      method: "GET",
      url: "/api/anchors"
    });

    assert.equal(response.statusCode, 200, response.body);
    const body = response.json() as {
      anchors: Array<{ anchorId: string; slotId: string; subjectType: string; subjectId: string; state: string }>;
    };
    assert.equal(body.anchors.length, 1);
    assert.equal(body.anchors[0].anchorId, "slot-1");
    assert.equal(body.anchors[0].slotId, "slot-1");
    assert.equal(body.anchors[0].subjectType, "requirement");
    assert.equal(body.anchors[0].subjectId, requirement.id);
    assert.equal(body.anchors[0].state, "bound");
  } finally {
    await app.close();
  }
});

test("POST /api/projects/:projectId/requirements/:requirementId/planning-anchor/start creates a planning anchor", async () => {
  const { project, requirement } = await createRequirementFixture();
  const app = buildApp({ enableFileWatcher: false });

  try {
    const response = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/requirements/${requirement.id}/planning-anchor/start`,
      payload: {}
    });

    assert.equal(response.statusCode, 200, response.body);
    const body = response.json();
    assert.equal(body.subjectType, "requirement");
    assert.equal(body.subjectId, requirement.id);
    assert.equal(body.mode, "planning");
    assert.equal(body.status, "bound");
    assert.equal(body.slotId, "slot-1");
    assert.equal(body.anchorId, "slot-1");
    assert.equal(body.socketPath, null);
    assert.equal(await prisma.anchorAllocation.count({ where: { subjectType: "requirement", subjectId: requirement.id, mode: "planning" } }), 0);
    assert.equal(await prisma.slotBinding.count({ where: { projectId: project.id, requirementId: requirement.id, slotId: "slot-1" } }), 1);
    const refreshed = await prisma.requirement.findUniqueOrThrow({ where: { id: requirement.id } });
    assert.equal(refreshed.planningAnchorId, "slot-1");
    assert.equal(refreshed.planningRuntimeState, "running");
  } finally {
    await app.close();
  }
});

test("POST /api/tasks/:taskId/anchor/start is deprecated and does not create per-subject runtime", async () => {
  const { subtask } = await createSubtaskFixture();
  const app = buildApp({ enableFileWatcher: false });

  try {
    const response = await app.inject({
      method: "POST",
      url: `/api/tasks/${subtask.id}/anchor/start`,
      payload: {}
    });

    assert.equal(response.statusCode, 410);
    assert.equal(await prisma.anchorAllocation.count({ where: { subjectType: "subtask", subjectId: subtask.id } }), 0);
  } finally {
    await app.close();
  }
});

test("task anchor route keeps preview read-only and deprecates start/stop writes", async () => {
  const { subtask } = await createSubtaskFixture();
  const app = buildApp({ enableFileWatcher: false });

  try {
    const previewResponse = await app.inject({
      method: "GET",
      url: `/api/tasks/${subtask.id}/anchor/preview`
    });
    assert.equal(previewResponse.statusCode, 200);
    assert.equal(previewResponse.json().subjectType, "subtask");
    assert.equal(previewResponse.json().subjectId, subtask.id);
    assert.match(previewResponse.json().anchorPath, new RegExp(`ccb-anchor-route-subtask-.+-task-${subtask.id}$`));

    const startResponse = await app.inject({
      method: "POST",
      url: `/api/tasks/${subtask.id}/anchor/start`,
      payload: {}
    });
    assert.equal(startResponse.statusCode, 410);

    const stopResponse = await app.inject({
      method: "POST",
      url: `/api/tasks/${subtask.id}/anchor/stop`,
      payload: { jobId: "job-subtask-stop" }
    });
    assert.equal(stopResponse.statusCode, 410);
    assert.equal(await prisma.anchorAllocation.count({ where: { subjectType: "subtask", subjectId: subtask.id } }), 0);
  } finally {
    await app.close();
  }
});

test("POST /api/anchors/:anchorId/runtime/stop pauses runtime without destroying anchor artifacts", async () => {
  const { project, requirement } = await createRequirementFixture();
  const anchorPath = join(tmpdir(), `ccb-anchor-runtime-stop-${randomUUID()}`);
  await prisma.anchorAllocation.create({
    data: {
      anchorId: "anchor-runtime-stop",
      anchorPath,
      projectId: project.id,
      socketPath: null,
      subjectType: "requirement",
      subjectId: requirement.id,
      subjectKey: requirement.title,
      mode: "planning",
      state: "ready",
      updatedAt: new Date()
    }
  });
  const app = buildApp({ enableFileWatcher: false });

  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/anchors/anchor-runtime-stop/runtime/stop",
      payload: {}
    });

    assert.equal(response.statusCode, 410);
    const row = await prisma.anchorAllocation.findUniqueOrThrow({ where: { anchorId: "anchor-runtime-stop" } });
    assert.equal(row.runtimePaused, false);
    assert.equal(row.state, "ready");
    assert.equal(row.socketPath, null);
  } finally {
    await app.close();
  }
});

test("POST /api/anchors/:anchorId/runtime/resume restarts requirement runtime and resubmits planning startAsk", async () => {
  const { project, requirement } = await createRequirementFixture();
  const anchorPath = join(tmpdir(), `ccb-anchor-runtime-resume-${randomUUID()}`);
  await prisma.anchorAllocation.create({
    data: {
      anchorId: "anchor-runtime-resume",
      anchorPath,
      projectId: project.id,
      socketPath: null,
      subjectType: "requirement",
      subjectId: requirement.id,
      subjectKey: requirement.title,
      mode: "planning",
      state: "ready",
      runtimePaused: true,
      updatedAt: new Date()
    }
  });
  const app = buildApp({ enableFileWatcher: false });

  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/anchors/anchor-runtime-resume/runtime/resume",
      payload: {}
    });

    assert.equal(response.statusCode, 410);
    const row = await prisma.anchorAllocation.findUniqueOrThrow({ where: { anchorId: "anchor-runtime-resume" } });
    assert.equal(row.runtimePaused, true);
    assert.equal(row.socketPath, null);
  } finally {
    await app.close();
  }
});

test("POST /api/anchors/:anchorId/runtime/resume is idempotent when runtime is active", async () => {
  const { project, subtask } = await createSubtaskFixture();
  await prisma.anchorAllocation.create({
    data: {
      anchorId: "anchor-runtime-resume-idempotent",
      anchorPath: join(tmpdir(), `ccb-anchor-runtime-resume-idempotent-${randomUUID()}`),
      projectId: project.id,
      socketPath: "/tmp/already-active.sock",
      subjectType: "subtask",
      subjectId: subtask.id,
      subjectKey: subtask.taskKey,
      mode: "execution",
      state: "ready",
      runtimePaused: false,
      updatedAt: new Date()
    }
  });
  const app = buildApp({ enableFileWatcher: false });

  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/anchors/anchor-runtime-resume-idempotent/runtime/resume",
      payload: {}
    });

    assert.equal(response.statusCode, 410);
  } finally {
    await app.close();
  }
});

test("POST /api/tasks/:taskId/anchor/reset deletes an existing subtask anchor row and is idempotent", async () => {
  const { project, subtask } = await createSubtaskFixture();
  await prisma.anchorAllocation.create({
    data: {
      anchorId: "anchor-route-reset",
      anchorPath: join(tmpdir(), `ccb-anchor-route-reset-${randomUUID()}`),
      projectId: project.id,
      socketPath: join(tmpdir(), "ccb-anchor-route-reset.sock"),
      subjectType: "subtask",
      subjectId: subtask.id,
      subjectKey: subtask.taskKey,
      mode: "execution",
      state: "mount_failed",
      updatedAt: new Date()
    }
  });
  const app = buildApp({ enableFileWatcher: false });

  try {
    const first = await app.inject({
      method: "POST",
      url: `/api/tasks/${subtask.id}/anchor/reset`,
      payload: {}
    });
    const second = await app.inject({
      method: "POST",
      url: `/api/tasks/${subtask.id}/anchor/reset`,
      payload: {}
    });

    assert.equal(first.statusCode, 410);
    assert.equal(second.statusCode, 410);
    assert.equal(await prisma.anchorAllocation.count({ where: { subjectType: "subtask", subjectId: subtask.id } }), 1);
  } finally {
    await app.close();
  }
});

test("POST /api/projects/:projectId/requirements/:requirementId/anchor/reset is deprecated and does not clean per-anchor artifacts", async () => {
  const { project, requirement } = await createRequirementFixture();
  const app = buildApp({ enableFileWatcher: false });

  try {
    const response = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/requirements/${requirement.id}/anchor/reset`,
      payload: {}
    });

    assert.equal(response.statusCode, 410);
  } finally {
    await app.close();
  }
});

test("POST /api/anchors/:anchorId/terminal/spawn rejects non-local requests", async () => {
  const nativeTerminal = {
    spawn: vi.fn(async () => ({
      spawned: true,
      attempted: ["xterm"],
      fallbackCommand: "tmux -S /tmp/tmux.sock attach -t ccb-su-ccb-task-task-1",
      sessionName: "ccb-su-ccb-task-task-1",
      socketPath: "/tmp/tmux.sock",
      anchorPath: "/tmp/anchor"
    }))
  };
  const app = buildApp({
    enableFileWatcher: false,
    anchorBroker: {
      nativeTerminal
    }
  });

  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/anchors/anchor-1/terminal/spawn",
      remoteAddress: "10.0.0.20",
      payload: {}
    });

    assert.equal(response.statusCode, 403);
    assert.equal(response.json().message, "仅本机可用");
    assert.equal(nativeTerminal.spawn.mock.calls.length, 0);
  } finally {
    await app.close();
  }
});

test("POST /api/anchors/:anchorId/terminal/spawn returns 404 when anchor is missing or destroyed", async () => {
  const nativeTerminal = {
    spawn: vi.fn()
  };
  const broker = {
    registerAnchor: vi.fn(),
    unregisterAnchor: vi.fn(),
    resolveAnchor: vi.fn(async () => null)
  } as unknown as MultiAnchorBrokerService;
  const app = buildApp({
    enableFileWatcher: false,
    anchorBroker: {
      broker,
      nativeTerminal
    }
  });

  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/anchors/anchor-missing/terminal/spawn",
      payload: {}
    });

    assert.equal(response.statusCode, 404);
    assert.equal(response.json().message, "anchor 已销毁");
    assert.equal(nativeTerminal.spawn.mock.calls.length, 0);
  } finally {
    await app.close();
  }
});

test("POST /api/anchors/:anchorId/terminal/spawn returns native terminal spawn result", async () => {
  const spawnResult = {
    spawned: false,
    attempted: ["gnome-terminal", "konsole", "xterm"],
    reason: "no supported terminal emulator found",
    fallbackCommand: "tmux -S /tmp/anchor/.ccb/ccbd/tmux.sock attach -t ccb-su-ccb-task-task-1",
    sessionName: "ccb-su-ccb-task-task-1",
    socketPath: "/tmp/anchor/.ccb/ccbd/tmux.sock",
    anchorPath: "/tmp/anchor"
  };
  const spawn = vi.fn(
    async (_anchor: { anchorId: string; projectId: string | null; anchorPath: string; socketPath: string | null }) =>
      spawnResult
  );
  const nativeTerminal = { spawn };
  const broker = {
    registerAnchor: vi.fn(),
    unregisterAnchor: vi.fn(),
    resolveAnchor: vi.fn(async () => ({
      anchorId: "anchor-1",
      projectId: "project-1",
      anchorPath: "/tmp/anchor",
      socketPath: "/tmp/anchor/.ccb/ccbd/ccbd.sock",
      runtimePaused: false
    }))
  } as unknown as MultiAnchorBrokerService;
  const app = buildApp({
    enableFileWatcher: false,
    anchorBroker: {
      broker,
      nativeTerminal
    }
  });

  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/anchors/anchor-1/terminal/spawn",
      payload: {}
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), spawnResult);
    assert.deepEqual(spawn.mock.calls[0]?.[0], {
      anchorId: "anchor-1",
      projectId: "project-1",
      anchorPath: "/tmp/anchor",
      socketPath: "/tmp/anchor/.ccb/ccbd/ccbd.sock",
      runtimePaused: false
    });
  } finally {
    await app.close();
  }
});
