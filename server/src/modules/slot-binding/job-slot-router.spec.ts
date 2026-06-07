import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, test, vi } from "vitest";

import { prisma } from "../../db/prisma.js";
import { JobSlotRouter } from "./job-slot-router.js";
import { SlotBindingService } from "./slot-binding.service.js";

async function resetDatabase(): Promise<void> {
  await prisma.anchorDispatchQueue.deleteMany();
  await prisma.eventJournal.deleteMany();
  await prisma.slotBinding.deleteMany();
  await prisma.anchorAllocation.deleteMany();
  await prisma.task.deleteMany();
  await prisma.requirement.deleteMany();
  await prisma.project.deleteMany();
}

async function createRequirementFixture() {
  const project = await prisma.project.create({
    data: {
      name: `job-slot-router-${randomUUID()}`,
      localPath: join(tmpdir(), `job-slot-router-${randomUUID()}`)
    }
  });
  const requirement = await prisma.requirement.create({
    data: {
      projectId: project.id,
      title: "Routed requirement",
      description: "Router fixture",
      status: "planning"
    }
  });
  return { project, requirement };
}

async function createProjectWithRequirements(count: number, slotCount = 3) {
  const project = await prisma.project.create({
    data: {
      name: `job-slot-router-project-${randomUUID()}`,
      localPath: join(tmpdir(), `job-slot-router-project-${randomUUID()}`),
      slotCount
    }
  });
  const requirements = [];
  for (let index = 0; index < count; index++) {
    requirements.push(
      await prisma.requirement.create({
        data: {
          projectId: project.id,
          title: `Requirement ${index + 1}`,
          description: "Router fixture",
          status: "planning"
        }
      })
    );
  }
  return { project, requirements };
}

beforeEach(async () => {
  await resetDatabase();
});

test("JobSlotRouter binds a requirement, writes slot queue row, and targets the slot claude agent", async () => {
  const { project, requirement } = await createRequirementFixture();
  const submit = vi.fn(async () => ({ jobId: "ccbd-job-1", traceRef: "trace-1" }));
  const router = new JobSlotRouter({
    prismaClient: prisma,
    slotBinding: new SlotBindingService(prisma),
    submitToSlot: submit,
    submitImmediately: true
  });

  const result = await router.enqueue({
    projectId: project.id,
    requirementId: requirement.id,
    subjectType: "requirement",
    subjectId: requirement.id,
    command: "/ccb:su-flow --payload {}",
    dispatchPayload: { subject: "requirement" }
  });

  assert.equal(result.status, "submitted");
  assert.equal(result.slotId, "slot-1");
  assert.equal(submit.mock.calls[0]?.[0].toAgent, "slot1_claude");
  assert.equal(submit.mock.calls[0]?.[0].slotId, "slot-1");

  const row = await prisma.anchorDispatchQueue.findUniqueOrThrow({ where: { jobId: result.jobId } });
  assert.equal(row.anchorId, "slot-1");
  assert.equal(row.status, "submitted");
  assert.equal(await prisma.eventJournal.count({ where: { eventType: "slot_queued_request" } }), 1);
});

test("JobSlotRouter queues overflow when all three slots are bound", async () => {
  const fixtures = [];
  const project = await prisma.project.create({
    data: {
      name: `job-slot-router-overflow-${randomUUID()}`,
      localPath: join(tmpdir(), `job-slot-router-overflow-${randomUUID()}`)
    }
  });
  for (let index = 0; index < 4; index++) {
    fixtures.push(
      await prisma.requirement.create({
        data: {
          projectId: project.id,
          title: `Requirement ${index + 1}`,
          description: "Overflow fixture",
          status: "planning"
        }
      })
    );
  }
  const slotBinding = new SlotBindingService(prisma);
  for (const requirement of fixtures.slice(0, 3)) {
    await slotBinding.bindRequirement({ projectId: project.id, requirementId: requirement.id });
  }
  const submit = vi.fn(async () => ({ jobId: "unused" }));
  const router = new JobSlotRouter({
    prismaClient: prisma,
    slotBinding,
    submitToSlot: submit
  });

  const result = await router.enqueue({
    projectId: project.id,
    requirementId: fixtures[3].id,
    subjectType: "requirement",
    subjectId: fixtures[3].id,
    command: "/ccb:su-flow --payload {}",
    dispatchPayload: { subject: "requirement" }
  });

  assert.equal(result.status, "queued");
  assert.equal(result.slotId, null);
  assert.equal(submit.mock.calls.length, 0);
  const row = await prisma.anchorDispatchQueue.findUniqueOrThrow({ where: { jobId: result.jobId } });
  assert.equal(row.anchorId, "slot-unassigned");
  assert.equal(row.status, "pending");
});

test("JobSlotRouter targets slot4_claude when the project has four slots", async () => {
  const { project, requirements } = await createProjectWithRequirements(4, 4);
  const slotBinding = new SlotBindingService(prisma);
  for (const requirement of requirements.slice(0, 3)) {
    await slotBinding.bindRequirement({ projectId: project.id, requirementId: requirement.id });
  }
  const submit = vi.fn(async () => ({ jobId: "ccbd-job-slot-4", traceRef: "trace-slot-4" }));
  const router = new JobSlotRouter({
    prismaClient: prisma,
    slotBinding,
    submitToSlot: submit,
    submitImmediately: true
  });

  const result = await router.enqueue({
    projectId: project.id,
    requirementId: requirements[3].id,
    subjectType: "requirement",
    subjectId: requirements[3].id,
    command: "/ccb:su-flow --payload {}"
  });

  assert.equal(result.status, "submitted");
  assert.equal(result.slotId, "slot-4");
  assert.equal(submit.mock.calls[0]?.[0].toAgent, "slot4_claude");
  assert.equal(submit.mock.calls[0]?.[0].slotId, "slot-4");
});

test("JobSlotRouter.tick drains the oldest current-project queued request into an idle slot without worktree allocation", async () => {
  const projectOne = await createProjectWithRequirements(4);
  const projectTwo = await createProjectWithRequirements(4);
  const slotBinding = new SlotBindingService(prisma);
  for (const requirement of projectOne.requirements.slice(0, 3)) {
    await slotBinding.bindRequirement({ projectId: projectOne.project.id, requirementId: requirement.id });
  }
  for (const requirement of projectTwo.requirements.slice(0, 3)) {
    await slotBinding.bindRequirement({ projectId: projectTwo.project.id, requirementId: requirement.id });
  }
  const router = new JobSlotRouter({ prismaClient: prisma, slotBinding });
  const otherProjectQueued = await router.enqueue({
    projectId: projectTwo.project.id,
    requirementId: projectTwo.requirements[3].id,
    subjectType: "requirement",
    subjectId: projectTwo.requirements[3].id,
    command: "/ccb:su-flow --payload {}",
    requestedAt: new Date("2026-05-24T00:00:00.000Z")
  });
  const currentProjectQueued = await router.enqueue({
    projectId: projectOne.project.id,
    requirementId: projectOne.requirements[3].id,
    subjectType: "requirement",
    subjectId: projectOne.requirements[3].id,
    command: "/ccb:su-flow --payload {}",
    requestedAt: new Date("2026-05-24T00:00:01.000Z")
  });
  await slotBinding.releaseSlot({
    projectId: projectOne.project.id,
    slotId: "slot-1",
    reason: "manual_release",
    releasedBy: "user"
  });

  const result = await router.tick(projectOne.project.id);

  assert.equal(result.submitted, 1);
  assert.equal(result.failed, 0);
  const drained = await prisma.anchorDispatchQueue.findUniqueOrThrow({ where: { jobId: currentProjectQueued.jobId } });
  assert.equal(drained.anchorId, "slot-1");
  assert.equal(drained.status, "pending");
  const untouched = await prisma.anchorDispatchQueue.findUniqueOrThrow({ where: { jobId: otherProjectQueued.jobId } });
  assert.equal(untouched.anchorId, "slot-unassigned");
  assert.equal(await prisma.eventJournal.count({ where: { eventType: "slot_queued_request" } }), 2);
  assert.equal(await prisma.anchorAllocation.count(), 0);
});

test("JobSlotRouter reuses persisted SlotBinding after a Console restart without creating a worktree", async () => {
  const { project, requirement } = await createRequirementFixture();
  const firstRouter = new JobSlotRouter({
    prismaClient: prisma,
    slotBinding: new SlotBindingService(prisma)
  });

  const first = await firstRouter.enqueue({
    projectId: project.id,
    requirementId: requirement.id,
    subjectType: "requirement",
    subjectId: requirement.id,
    command: "/ccb:su-flow --payload {}"
  });
  const restartedRouter = new JobSlotRouter({
    prismaClient: prisma,
    slotBinding: new SlotBindingService(prisma)
  });
  const second = await restartedRouter.enqueue({
    projectId: project.id,
    requirementId: requirement.id,
    subjectType: "requirement",
    subjectId: requirement.id,
    command: "/ccb:su-flow --payload {}"
  });

  assert.equal(first.slotId, "slot-1");
  assert.equal(second.slotId, "slot-1");
  assert.equal(await prisma.slotBinding.count({ where: { projectId: project.id, requirementId: requirement.id } }), 1);
  assert.equal(await prisma.anchorAllocation.count(), 0);
});
