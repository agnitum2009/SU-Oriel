import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Fastify from "fastify";
import { beforeEach, test, vi } from "vitest";

import { prisma } from "../../db/prisma.js";
import { registerUserIntentRoutes } from "./user-intent.routes.js";

async function resetDatabase(): Promise<void> {
  await prisma.userIntent.deleteMany();
  await prisma.anchorDispatchQueue.deleteMany();
  await prisma.eventJournal.deleteMany();
  await prisma.slotBinding.deleteMany();
  await prisma.anchorAllocation.deleteMany();
  await prisma.task.deleteMany();
  await prisma.requirement.deleteMany();
  await prisma.project.deleteMany();
}

async function createBusySlotFixture(options: { slotId?: string; slotCount?: number } = {}) {
  const suffix = randomUUID();
  const slotId = options.slotId ?? "slot-3";
  const project = await prisma.project.create({
    data: {
      name: `user-intent-slot-${suffix}`,
      localPath: join(tmpdir(), `user-intent-slot-${suffix}`),
      slotCount: options.slotCount ?? 3
    }
  });
  const requirement = await prisma.requirement.create({
    data: {
      projectId: project.id,
      title: "Sticky requirement",
      description: "User intent slot fixture",
      status: "delivering"
    }
  });
  const task = await prisma.task.create({
    data: {
      projectId: project.id,
      requirementId: requirement.id,
      taskKey: `task-${suffix}`,
      title: "Sticky subtask",
      status: "reviewing",
      currentNode: "execute",
      runtimeState: "running"
    }
  });
  await prisma.slotBinding.create({
    data: {
      projectId: project.id,
      slotId,
      requirementId: requirement.id,
      state: "busy",
      boundAt: new Date("2026-05-24T00:00:00.000Z"),
      busySince: new Date("2026-05-24T00:01:00.000Z"),
      lastActivityAt: new Date("2026-05-24T00:01:00.000Z")
    }
  });
  return { project, requirement, task };
}

beforeEach(async () => {
  await resetDatabase();
});

test("stop-and-append records intent and moves sticky slot busy to bound without AnchorAllocation writes", async () => {
  const { project, task } = await createBusySlotFixture();
  const cancel = vi.fn(async () => ({}));
  const submit = vi.fn();
  const app = Fastify();
  await app.register(registerUserIntentRoutes, {
    prismaClient: prisma,
    slotRuntime: { cancel, submit }
  } as never);

  try {
    const response = await app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/stop-and-append`,
      payload: {
        intentType: "append_instruction",
        body: "please pause and add this constraint",
        ccbJobId: "job-current"
      }
    });

    assert.equal(response.statusCode, 200, response.body);
    const body = response.json() as {
      intentId: string;
      cancelledJobId: string | null;
      slotId: string | null;
      slotState: string | null;
    };
    assert.equal(body.cancelledJobId, "job-current");
    assert.equal(body.slotId, "slot-3");
    assert.equal(body.slotState, "bound");
    assert.equal(cancel.mock.calls.length, 1);
    assert.deepEqual(cancel.mock.calls[0], [{ projectRoot: project.localPath, jobId: "job-current" }]);
    assert.equal(submit.mock.calls.length, 0);

    const binding = await prisma.slotBinding.findUniqueOrThrow({
      where: { projectId_slotId: { projectId: project.id, slotId: "slot-3" } }
    });
    assert.equal(binding.state, "bound");
    assert.equal(binding.requirementId, task.requirementId);
    assert.equal(binding.busySince, null);
    assert.equal(await prisma.userIntent.count({ where: { taskId: task.id, consumedAt: null } }), 1);
    assert.equal(await prisma.anchorAllocation.count(), 0);
  } finally {
    await app.close();
  }
});

test("resume redispatches pending intent to the sticky slot claude agent without AnchorAllocation", async () => {
  const { project, task } = await createBusySlotFixture();
  await prisma.slotBinding.update({
    where: { projectId_slotId: { projectId: project.id, slotId: "slot-3" } },
    data: { state: "bound", busySince: null }
  });
  const intent = await prisma.userIntent.create({
    data: {
      taskId: task.id,
      intentType: "change_direction",
      body: "switch to plan B"
    }
  });
  const cancel = vi.fn();
  const submit = vi.fn(async () => ({ jobId: "job-resume", traceRef: "trace-resume" }));
  const app = Fastify();
  await app.register(registerUserIntentRoutes, {
    prismaClient: prisma,
    slotRuntime: { cancel, submit }
  } as never);

  try {
    const response = await app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/resume`,
      payload: {}
    });

    assert.equal(response.statusCode, 200, response.body);
    const body = response.json() as {
      slotId: string;
      jobId: string | null;
      intentId: string;
      intentType: string;
      body: string;
    };
    assert.equal(body.slotId, "slot-3");
    assert.equal(body.jobId, "job-resume");
    assert.equal(body.intentId, intent.id);
    assert.equal(cancel.mock.calls.length, 0);
    assert.deepEqual(submit.mock.calls[0], [{
      projectRoot: project.localPath,
      slotId: "slot-3",
      toAgent: "slot3_claude",
      taskId: task.taskKey,
      body: `/ccb:su-resume task_id=${task.id} intent_id=${intent.id}`
    }]);

    const binding = await prisma.slotBinding.findUniqueOrThrow({
      where: { projectId_slotId: { projectId: project.id, slotId: "slot-3" } }
    });
    assert.equal(binding.state, "busy");
    assert.notEqual(binding.busySince, null);
    assert.equal(await prisma.anchorAllocation.count(), 0);
  } finally {
    await app.close();
  }
});

test("stop-and-append and resume accept slot-4 when the project has four slots", async () => {
  const { project, task } = await createBusySlotFixture({ slotId: "slot-4", slotCount: 4 });
  const cancel = vi.fn(async () => ({}));
  const submit = vi.fn(async () => ({ jobId: "job-resume-slot-4", traceRef: "trace-slot-4" }));
  const app = Fastify();
  await app.register(registerUserIntentRoutes, {
    prismaClient: prisma,
    slotRuntime: { cancel, submit }
  } as never);

  try {
    const stopped = await app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/stop-and-append`,
      payload: {
        intentType: "append_instruction",
        body: "append this after stopping slot four",
        ccbJobId: "job-current-slot-4"
      }
    });

    assert.equal(stopped.statusCode, 200, stopped.body);
    assert.equal(stopped.json().cancelledJobId, "job-current-slot-4");
    assert.equal(stopped.json().slotId, "slot-4");
    assert.equal(stopped.json().slotState, "bound");
    assert.deepEqual(cancel.mock.calls[0], [{ projectRoot: project.localPath, jobId: "job-current-slot-4" }]);

    const resumed = await app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/resume`,
      payload: {}
    });

    assert.equal(resumed.statusCode, 200, resumed.body);
    assert.equal(resumed.json().slotId, "slot-4");
    assert.deepEqual(submit.mock.calls[0], [{
      projectRoot: project.localPath,
      slotId: "slot-4",
      toAgent: "slot4_claude",
      taskId: task.taskKey,
      body: `/ccb:su-resume task_id=${task.id} intent_id=${stopped.json().intentId}`
    }]);
    const binding = await prisma.slotBinding.findUniqueOrThrow({
      where: { projectId_slotId: { projectId: project.id, slotId: "slot-4" } }
    });
    assert.equal(binding.state, "busy");
  } finally {
    await app.close();
  }
});
