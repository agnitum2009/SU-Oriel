import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, test, vi } from "vitest";

import { prisma } from "../../db/prisma.js";
import { ManagedConfigMutationLock } from "../project-ccbd/managed-config-mutation-lock.js";
import { CcbdClientService } from "../ccbd-client/ccbd-client.service.js";
import { AnchorSocketNotReadyError } from "./anchor-broker.errors.js";
import { runAnchorDispatchWorkerTick } from "./anchor-dispatch-worker.js";

async function resetFixtures(): Promise<void> {
  await prisma.anchorDispatchQueue.deleteMany();
  await prisma.eventJournal.deleteMany();
  await prisma.anchorAllocation.deleteMany();
  await prisma.task.deleteMany();
  await prisma.requirement.deleteMany();
  await prisma.project.deleteMany();
}

async function createRequirementQueueFixture() {
  const suffix = randomUUID();
  const project = await prisma.project.create({
    data: {
      name: `dispatch-worker-requirement-${suffix}`,
      localPath: join(tmpdir(), `ccb-dispatch-worker-requirement-${suffix}`)
    }
  });
  const requirement = await prisma.requirement.create({
    data: {
      projectId: project.id,
      title: "Requirement dispatch worker",
      description: "Plan this requirement",
      status: "planning"
    }
  });
  const anchorPath = join(project.localPath, `requirement-${requirement.id}`);
  const anchor = await prisma.anchorAllocation.create({
    data: {
      anchorId: "anchor_dispatch_worker_requirement",
      anchorPath,
      projectId: project.id,
      socketPath: "/tmp/worker-requirement.sock",
      subjectType: "requirement",
      subjectId: requirement.id,
      subjectKey: requirement.title,
      mode: "planning",
      state: "ready"
    }
  });
  const queue = await prisma.anchorDispatchQueue.create({
    data: {
      projectId: project.id,
      jobId: "job_worker_req",
      anchorId: anchor.anchorId,
      subjectType: "requirement",
      subjectId: requirement.id,
      command: `/ccb:su-flow --payload ${JSON.stringify({
        language: "中文",
        project_id: project.id,
        requirement_id: requirement.id,
        step: "design",
        subject: "requirement"
      })}`,
      status: "pending"
    }
  });
  return { project, requirement, anchor, queue };
}

async function createSubtaskQueueFixture() {
  const suffix = randomUUID();
  const project = await prisma.project.create({
    data: {
      name: `dispatch-worker-subtask-${suffix}`,
      localPath: join(tmpdir(), `ccb-dispatch-worker-subtask-${suffix}`)
    }
  });
  const task = await prisma.task.create({
    data: {
      projectId: project.id,
      taskKey: `task-${suffix}`,
      title: "Subtask dispatch worker",
      status: "reviewing",
      currentNode: "implementation"
    }
  });
  const anchorPath = join(project.localPath, `task-${task.id}`);
  const anchor = await prisma.anchorAllocation.create({
    data: {
      anchorId: "anchor_dispatch_worker_subtask",
      anchorPath,
      projectId: project.id,
      socketPath: "/tmp/worker-subtask.sock",
      subjectType: "subtask",
      subjectId: task.id,
      subjectKey: task.taskKey,
      mode: "execution",
      state: "ready"
    }
  });
  const queue = await prisma.anchorDispatchQueue.create({
    data: {
      projectId: project.id,
      jobId: "job_worker_subtask",
      anchorId: anchor.anchorId,
      subjectType: "subtask",
      subjectId: task.id,
      command: `/ccb:su-dispatch --payload ${JSON.stringify({
        language: "中文",
        subject: "subtask",
        task_id: task.id,
        task_key: task.taskKey
      })}`,
      status: "pending"
    }
  });
  return { project, task, anchor, queue };
}

beforeEach(async () => {
  await resetFixtures();
});

afterEach(() => {
  vi.restoreAllMocks();
});

test("runAnchorDispatchWorkerTick submits pending requirement dispatches and emits submitted event", async () => {
  const { requirement, anchor, queue } = await createRequirementQueueFixture();
  const askAcrossAnchor = vi.fn(async () => ({ jobId: "ccbd_job_1", traceRef: "trace-1" }));
  const waitForClaudeTuiReady = vi.fn(async () => ({
    ready: true,
    elapsedMs: 5,
    lastTitles: ["✳ Analyze customer requirement"]
  }));

  const result = await runAnchorDispatchWorkerTick({
    prismaClient: prisma,
    askRouter: { askAcrossAnchor },
    waitForClaudeTuiReady
  });

  assert.deepEqual(result, { count: 1, submitted: 1, failed: 0 });
  assert.deepEqual(waitForClaudeTuiReady.mock.calls[0], [anchor.anchorPath]);
  assert.deepEqual(askAcrossAnchor.mock.calls[0]?.[0], {
    targetAnchorId: anchor.anchorId,
    toAgent: "ccb_claude",
    taskId: requirement.id,
    body: queue.command
  });

  const updated = await prisma.anchorDispatchQueue.findUniqueOrThrow({ where: { id: queue.id } });
  assert.equal(updated.status, "submitted");
  assert.equal(updated.readinessWarning, false);
  assert.ok(updated.submittedAt);

  const event = await prisma.eventJournal.findFirstOrThrow({
    where: { eventType: "anchor_dispatch_submitted", subjectType: "requirement", subjectId: requirement.id }
  });
  const payload = JSON.parse(event.payloadJson) as { jobId: string; traceRef?: string; readinessWarning?: boolean };
  assert.equal(payload.jobId, queue.jobId);
  assert.equal(payload.traceRef, "trace-1");
  assert.equal(payload.readinessWarning, false);
});

test("runAnchorDispatchWorkerTick fail-opens readiness warning and still submits subtask dispatches", async () => {
  const { task, anchor, queue } = await createSubtaskQueueFixture();
  const askAcrossAnchor = vi.fn(async () => ({ jobId: "ccbd_job_2", traceRef: null }));
  const waitForClaudeTuiReady = vi.fn(async () => ({
    ready: false,
    elapsedMs: 3000,
    lastTitles: ["✳ Epic multi-PR code review"]
  }));

  const result = await runAnchorDispatchWorkerTick({
    prismaClient: prisma,
    askRouter: { askAcrossAnchor },
    waitForClaudeTuiReady
  });

  assert.deepEqual(result, { count: 1, submitted: 1, failed: 0 });
  assert.deepEqual(askAcrossAnchor.mock.calls[0]?.[0], {
    targetAnchorId: anchor.anchorId,
    toAgent: "ccb_claude",
    taskId: task.taskKey,
    body: queue.command
  });

  const updated = await prisma.anchorDispatchQueue.findUniqueOrThrow({ where: { id: queue.id } });
  assert.equal(updated.status, "submitted");
  assert.equal(updated.readinessWarning, true);

  const event = await prisma.eventJournal.findFirstOrThrow({
    where: { eventType: "anchor_dispatch_submitted", subjectType: "subtask", subjectId: task.id }
  });
  const payload = JSON.parse(event.payloadJson) as { jobId: string; readinessWarning?: boolean };
  assert.equal(payload.jobId, queue.jobId);
  assert.equal(payload.readinessWarning, true);
});

test("runAnchorDispatchWorkerTick marks failed dispatches and emits failed event without retrying", async () => {
  const { requirement, queue } = await createRequirementQueueFixture();
  const askAcrossAnchor = vi.fn(async () => {
    throw new AnchorSocketNotReadyError("anchor_dispatch_worker_requirement");
  });

  const result = await runAnchorDispatchWorkerTick({
    prismaClient: prisma,
    askRouter: { askAcrossAnchor },
    waitForClaudeTuiReady: vi.fn(async () => ({ ready: true, elapsedMs: 1, lastTitles: ["Claude"] }))
  });

  assert.deepEqual(result, { count: 1, submitted: 0, failed: 1 });

  const updated = await prisma.anchorDispatchQueue.findUniqueOrThrow({ where: { id: queue.id } });
  assert.equal(updated.status, "failed");
  assert.ok(updated.failedAt);
  assert.match(updated.errorMessage ?? "", /anchor socket is not ready/);

  const event = await prisma.eventJournal.findFirstOrThrow({
    where: { eventType: "anchor_dispatch_failed", subjectType: "requirement", subjectId: requirement.id }
  });
  const payload = JSON.parse(event.payloadJson) as { jobId: string; errorCode: string; errorMessage: string };
  assert.equal(payload.jobId, queue.jobId);
  assert.equal(payload.errorCode, "ANCHOR_SOCKET_NOT_READY");
  assert.match(payload.errorMessage, /anchor socket is not ready/);
});

test("runAnchorDispatchWorkerTick submits slot-4 dispatches through the project slot runtime", async () => {
  const suffix = randomUUID();
  const project = await prisma.project.create({
    data: {
      name: `dispatch-worker-slot-${suffix}`,
      localPath: join(tmpdir(), `ccb-dispatch-worker-slot-${suffix}`),
      slotCount: 4
    }
  });
  const requirement = await prisma.requirement.create({
    data: {
      projectId: project.id,
      title: "Slot dispatch worker",
      description: "Slot dispatch fixture",
      status: "planning"
    }
  });
  await prisma.slotBinding.create({
    data: {
      projectId: project.id,
      slotId: "slot-4",
      requirementId: requirement.id,
      state: "bound",
      boundAt: new Date("2026-06-06T10:00:00.000Z")
    }
  });
  const queue = await prisma.anchorDispatchQueue.create({
    data: {
      projectId: project.id,
      jobId: "job_worker_slot_4",
      anchorId: "slot-4",
      subjectType: "requirement",
      subjectId: requirement.id,
      command: "/ccb:su-flow --payload {}",
      status: "pending"
    }
  });
  const submit = vi
    .spyOn(CcbdClientService.prototype, "submit")
    .mockResolvedValue({ jobId: "ccbd-slot-4", traceRef: "trace-slot-4" });
  const waitForClaudeTuiReady = vi.fn(async () => ({
    ready: true,
    elapsedMs: 1,
    lastTitles: ["slot-4"]
  }));

  const result = await runAnchorDispatchWorkerTick({
    prismaClient: prisma,
    waitForClaudeTuiReady
  });

  assert.deepEqual(result, { count: 1, submitted: 1, failed: 0 });
  assert.deepEqual(waitForClaudeTuiReady.mock.calls[0], [project.localPath]);
  assert.equal(submit.mock.calls[0]?.[0].toAgent, "slot4_claude");
  assert.equal(submit.mock.calls[0]?.[0].taskId, requirement.id);
  const updated = await prisma.anchorDispatchQueue.findUniqueOrThrow({ where: { id: queue.id } });
  assert.equal(updated.status, "submitted");
  const binding = await prisma.slotBinding.findUniqueOrThrow({
    where: { projectId_slotId: { projectId: project.id, slotId: "slot-4" } }
  });
  assert.equal(binding.state, "busy");
});

test("runAnchorDispatchWorkerTick records 409 semantics when resize lock wait times out", async () => {
  const suffix = randomUUID();
  const project = await prisma.project.create({
    data: {
      name: `dispatch-worker-slot-lock-${suffix}`,
      localPath: join(tmpdir(), `ccb-dispatch-worker-slot-lock-${suffix}`),
      slotCount: 4
    }
  });
  const requirement = await prisma.requirement.create({
    data: {
      projectId: project.id,
      title: "Slot dispatch worker lock",
      description: "Slot dispatch lock fixture",
      status: "planning"
    }
  });
  await prisma.slotBinding.create({
    data: {
      projectId: project.id,
      slotId: "slot-4",
      requirementId: requirement.id,
      state: "bound"
    }
  });
  const queue = await prisma.anchorDispatchQueue.create({
    data: {
      projectId: project.id,
      jobId: "job_worker_slot_lock_timeout",
      anchorId: "slot-4",
      subjectType: "requirement",
      subjectId: requirement.id,
      command: "/ccb:su-flow --payload {}",
      status: "pending"
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

  try {
    const result = await runAnchorDispatchWorkerTick({
      prismaClient: prisma,
      resizeLock,
      resizeLockWaitTimeoutMs: 5,
      waitForClaudeTuiReady: vi.fn(async () => ({ ready: true, elapsedMs: 1, lastTitles: ["slot-4"] }))
    });

    assert.deepEqual(result, { count: 1, submitted: 0, failed: 1 });
    const updated = await prisma.anchorDispatchQueue.findUniqueOrThrow({ where: { id: queue.id } });
    assert.equal(updated.status, "failed");
    assert.match(updated.errorMessage ?? "", /slot resize lock wait timed out/);
    const event = await prisma.eventJournal.findFirstOrThrow({
      where: { eventType: "anchor_dispatch_failed", correlationId: queue.jobId }
    });
    const payload = JSON.parse(event.payloadJson) as { errorCode: string; errorMessage: string };
    assert.equal(payload.errorCode, "SLOT_RESIZE_LOCK_TIMEOUT");
    assert.match(payload.errorMessage, /slot resize lock wait timed out/);
  } finally {
    releaseLock();
    await holding.catch(() => undefined);
  }
});
