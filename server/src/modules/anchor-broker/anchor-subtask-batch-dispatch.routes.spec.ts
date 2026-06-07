import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, test } from "vitest";

import { buildApp } from "../../app.js";
import { prisma } from "../../db/prisma.js";

async function resetFixtures(): Promise<void> {
  await prisma.anchorDispatchQueue.deleteMany();
  await prisma.eventJournal.deleteMany();
  await prisma.slotBinding.deleteMany();
  await prisma.anchorAllocation.deleteMany();
  await prisma.task.deleteMany();
  await prisma.requirement.deleteMany();
  await prisma.project.deleteMany();
}

function parseQueuedPayload(command: string): { command: string; payload: Record<string, unknown> } {
  const matched = command.match(/^\/ccb:([a-z][a-z0-9-]*) --payload (.+)$/);
  assert.ok(matched, `expected structured dispatch command, got: ${command}`);
  return {
    command: matched[1],
    payload: JSON.parse(matched[2]) as Record<string, unknown>
  };
}

async function createRequirementFixture() {
  const suffix = randomUUID();
  const project = await prisma.project.create({
    data: {
      name: `subtask-batch-${suffix}`,
      localPath: join(tmpdir(), `ccb-subtask-batch-${suffix}`)
    }
  });
  const requirement = await prisma.requirement.create({
    data: {
      projectId: project.id,
      title: "Batch dispatch requirement",
      description: "Dispatch child subtasks",
      status: "delivering"
    }
  });
  return { project, requirement };
}

async function createSubtask(input: {
  projectId: string;
  requirementId: string;
  title: string;
  currentNode?: string | null;
  status?: string;
  step?: number;
}) {
  const suffix = randomUUID();
  const taskKeyPrefix = input.step === undefined ? "batch" : `batch-${String(input.step).padStart(2, "0")}`;
  return await prisma.task.create({
    data: {
      projectId: input.projectId,
      requirementId: input.requirementId,
      taskKey: `${taskKeyPrefix}-${suffix}`,
      title: input.title,
      status: input.status ?? "reviewing",
      currentNode: input.currentNode ?? "dispatch",
      runtimeState: "idle",
      progress: 0
    }
  });
}

function buildBatchApp() {
  return buildApp({ enableFileWatcher: false });
}

beforeEach(async () => {
  await resetFixtures();
});

test("GET batch-candidates honors active AnchorAllocation rows and keeps pending queue guard", async () => {
  const { project, requirement } = await createRequirementFixture();
  const eligible = await createSubtask({
    projectId: project.id,
    requirementId: requirement.id,
    title: "Eligible dispatch task",
    step: 1
  });
  const wrongNode = await createSubtask({
    projectId: project.id,
    requirementId: requirement.id,
    title: "Already implementing",
    currentNode: "implementation",
    step: 2
  });
  const anchored = await createSubtask({
    projectId: project.id,
    requirementId: requirement.id,
    title: "Has active anchor",
    step: 3
  });
  const pending = await createSubtask({
    projectId: project.id,
    requirementId: requirement.id,
    title: "Has pending dispatch",
    step: 4
  });
  await prisma.anchorAllocation.create({
    data: {
      anchorId: "anchor_existing_subtask",
      anchorPath: join(project.localPath, "existing-subtask-anchor"),
      projectId: project.id,
      socketPath: "/tmp/existing-subtask.sock",
      subjectType: "subtask",
      subjectId: anchored.id,
      subjectKey: anchored.taskKey,
      mode: "execution",
      state: "ready"
    }
  });
  await prisma.anchorDispatchQueue.create({
    data: {
      projectId: project.id,
      jobId: "job_pending_subtask",
      anchorId: "anchor_pending_subtask",
      subjectType: "subtask",
      subjectId: pending.id,
      command: '/ccb:su-flow --payload {"language":"中文","subject":"subtask","step":"execution"}',
      status: "pending"
    }
  });
  const app = buildBatchApp();

  try {
    const response = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/requirements/${requirement.id}/subtasks/batch-candidates`
    });

    assert.equal(response.statusCode, 200, response.body);
    const body = response.json() as {
      candidates: Array<{
        taskId: string;
        eligible: boolean;
        hasActiveAnchor: boolean;
        isPendingDispatch: boolean;
        ineligibleReason: string | null;
      }>;
    };
    assert.deepEqual(body.candidates.map((candidate) => candidate.taskId), [
      eligible.id,
      wrongNode.id,
      anchored.id,
      pending.id
    ]);
    assert.equal(body.candidates[0].eligible, true);
    assert.equal(body.candidates[0].ineligibleReason, null);
    assert.equal(body.candidates[1].eligible, false);
    assert.equal(body.candidates[1].ineligibleReason, "子任务不在 dispatch 节点");
    assert.equal(body.candidates[2].eligible, false);
    assert.equal(body.candidates[2].hasActiveAnchor, true);
    assert.equal(body.candidates[2].ineligibleReason, "已有 active execution anchor");
    assert.equal(body.candidates[3].eligible, false);
    assert.equal(body.candidates[3].isPendingDispatch, true);
    assert.equal(body.candidates[3].ineligibleReason, "已有 pending dispatch");
  } finally {
    await app.close();
  }
});

test("POST batch-dispatch queues one su-batch coordinator command on the parent requirement slot", async () => {
  const { project, requirement } = await createRequirementFixture();
  const first = await createSubtask({ projectId: project.id, requirementId: requirement.id, title: "First", step: 1 });
  const second = await createSubtask({ projectId: project.id, requirementId: requirement.id, title: "Second", step: 2 });
  const app = buildBatchApp();

  try {
    const response = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/requirements/${requirement.id}/subtasks/batch-dispatch`,
      payload: {
        taskIds: [second.id, first.id],
        step: "execution"
      }
    });

    assert.equal(response.statusCode, 202, response.body);
    const body = response.json() as {
      jobId: string;
      slotId: string | null;
      status: string;
      command: string;
      taskIds: string[];
      totalQueued: number;
      totalFailed: number;
    };
    assert.equal(body.totalQueued, 1);
    assert.equal(body.totalFailed, 0);
    assert.deepEqual(body.taskIds, [second.id, first.id]);
    assert.equal(body.slotId, "slot-1");
    assert.equal(body.status, "queued");
    assert.match(body.jobId, /^job_[a-f0-9]{12}$/);
    assert.equal(body.command, "su-batch");

    const queued = await prisma.anchorDispatchQueue.findMany({
      where: {
        subjectType: "requirement",
        subjectId: requirement.id
      },
      orderBy: {
        queuedAt: "asc"
      }
    });
    assert.equal(queued.length, 1);
    assert.equal(queued[0].anchorId, "slot-1");
    assert.ok(queued.every((item) => item.status === "pending"));
    const firstPayload = parseQueuedPayload(queued[0].command);
    assert.equal(firstPayload.command, "su-batch");
    assert.deepEqual(firstPayload.payload, {
      language: "中文",
      policy_profile: "autonomous-batch",
      project_id: project.id,
      requirement_id: requirement.id,
      scope: "subtasks",
      stop_policy: {
        on_subtask_failure: "stop_and_report"
      },
      subject: "requirement",
      task_ids: [second.id, first.id],
      task_keys: [second.taskKey, first.taskKey]
    });

    const bindings = await prisma.slotBinding.findMany({
      where: {
        projectId: project.id,
        requirementId: requirement.id
      }
    });
    assert.equal(bindings.length, 1);
    assert.equal(bindings[0].slotId, "slot-1");
    assert.equal(await prisma.anchorAllocation.count({ where: { subjectType: "subtask" } }), 0);
    assert.equal(await prisma.anchorDispatchQueue.count({ where: { subjectType: "subtask" } }), 0);
  } finally {
    await app.close();
  }
});

test("POST batch-dispatch rejects the whole batch when any selected subtask is ineligible", async () => {
  const { project, requirement } = await createRequirementFixture();
  const valid = await createSubtask({ projectId: project.id, requirementId: requirement.id, title: "Valid", step: 1 });
  const invalid = await createSubtask({
    projectId: project.id,
    requirementId: requirement.id,
    title: "Invalid",
    currentNode: "implementation",
    step: 2
  });
  const app = buildBatchApp();

  try {
    const response = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/requirements/${requirement.id}/subtasks/batch-dispatch`,
      payload: {
        taskIds: [valid.id, invalid.id],
        step: "execution"
      }
    });

    assert.equal(response.statusCode, 409, response.body);
    const body = response.json() as {
      totalQueued: number;
      totalFailed: number;
      items: Array<{ taskId: string; status: string; jobId?: string; errorMessage?: string }>;
    };
    assert.equal(body.totalQueued, 0);
    assert.equal(body.totalFailed, 1);
    assert.equal(body.items.length, 1);
    assert.equal(body.items[0].taskId, invalid.id);
    assert.equal(body.items[0].status, "failed");
    assert.equal(body.items[0].errorMessage, "子任务不在 dispatch 节点");
    assert.equal(await prisma.anchorDispatchQueue.count({ where: { subjectId: valid.id } }), 0);
    assert.equal(await prisma.anchorDispatchQueue.count({ where: { subjectId: invalid.id } }), 0);
  } finally {
    await app.close();
  }
});

test("POST batch-dispatch rejects tasks outside the requirement before queueing", async () => {
  const { project, requirement } = await createRequirementFixture();
  const valid = await createSubtask({ projectId: project.id, requirementId: requirement.id, title: "Valid" });
  const otherRequirement = await prisma.requirement.create({
    data: {
      projectId: project.id,
      title: "Other requirement",
      description: "Other",
      status: "delivering"
    }
  });
  const outsider = await createSubtask({
    projectId: project.id,
    requirementId: otherRequirement.id,
    title: "Outsider"
  });
  const app = buildBatchApp();

  try {
    const response = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/requirements/${requirement.id}/subtasks/batch-dispatch`,
      payload: {
        taskIds: [valid.id, outsider.id],
        step: "execution"
      }
    });

    assert.equal(response.statusCode, 400, response.body);
    assert.equal(response.json().code, "invalid_batch_task_scope");
    assert.equal(await prisma.anchorDispatchQueue.count(), 0);
  } finally {
    await app.close();
  }
});

test("POST batch-dispatch returns 409 when every selected subtask fails eligibility", async () => {
  const { project, requirement } = await createRequirementFixture();
  const first = await createSubtask({
    projectId: project.id,
    requirementId: requirement.id,
    title: "First invalid",
    currentNode: "implementation"
  });
  const second = await createSubtask({
    projectId: project.id,
    requirementId: requirement.id,
    title: "Second invalid",
    status: "cancelled"
  });
  const app = buildBatchApp();

  try {
    const response = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/requirements/${requirement.id}/subtasks/batch-dispatch`,
      payload: {
        taskIds: [first.id, second.id],
        step: "execution"
      }
    });

    assert.equal(response.statusCode, 409, response.body);
    const body = response.json() as { totalQueued: number; totalFailed: number };
    assert.equal(body.totalQueued, 0);
    assert.equal(body.totalFailed, 2);
    assert.equal(await prisma.anchorDispatchQueue.count(), 0);
  } finally {
    await app.close();
  }
});
