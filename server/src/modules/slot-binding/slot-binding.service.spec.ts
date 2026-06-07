import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, test } from "vitest";

import { prisma } from "../../db/prisma.js";
import { JobSlotRouter } from "./job-slot-router.js";
import {
  isSlotId,
  reconcileCancelledRequirementProjection,
  SlotBindingService,
  updateSlotActivityForCapabilityOutcome
} from "./slot-binding.service.js";

async function resetDatabase(): Promise<void> {
  await prisma.anchorDispatchQueue.deleteMany();
  await prisma.eventJournal.deleteMany();
  await prisma.slotBinding.deleteMany();
  await prisma.anchorAllocation.deleteMany();
  await prisma.requirement.deleteMany();
  await prisma.project.deleteMany();
}

async function createProjectWithRequirements(count: number, slotCount = 3) {
  const project = await prisma.project.create({
    data: {
      name: `slot-binding-${randomUUID()}`,
      localPath: join(tmpdir(), `slot-binding-${randomUUID()}`),
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
          description: "Slot binding fixture",
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

test("SlotBindingService claims deterministic slots and preserves sticky requirement binding", async () => {
  const { project, requirements } = await createProjectWithRequirements(2);
  const service = new SlotBindingService(prisma);

  const first = await service.bindRequirement({
    projectId: project.id,
    requirementId: requirements[0].id
  });
  const again = await service.bindRequirement({
    projectId: project.id,
    requirementId: requirements[0].id
  });
  const second = await service.bindRequirement({
    projectId: project.id,
    requirementId: requirements[1].id
  });

  assert.equal(first.slotId, "slot-1");
  assert.equal(again.slotId, "slot-1");
  assert.equal(second.slotId, "slot-2");
  assert.equal(await prisma.eventJournal.count({ where: { eventType: "slot_bound" } }), 2);
});

test("SlotBindingService runs the slot-bound callback after commit and keeps binding when it fails", async () => {
  const { project, requirements } = await createProjectWithRequirements(1);
  const calls: Array<{ projectId: string; slotId: string; requirementId: string; committed: boolean }> = [];
  const service = new SlotBindingService(prisma, {
    onSlotBound: async (input) => {
      const row = await prisma.slotBinding.findUnique({
        where: {
          projectId_slotId: {
            projectId: input.projectId,
            slotId: input.slotId
          }
        }
      });
      calls.push({
        ...input,
        committed: row?.requirementId === input.requirementId
      });
      throw new Error("reset failed");
    }
  });

  const bound = await service.bindRequirement({
    projectId: project.id,
    requirementId: requirements[0].id
  });
  const sticky = await service.bindRequirement({
    projectId: project.id,
    requirementId: requirements[0].id
  });

  assert.equal(bound?.slotId, "slot-1");
  assert.equal(sticky?.slotId, "slot-1");
  assert.deepEqual(calls, [
    {
      projectId: project.id,
      slotId: "slot-1",
      requirementId: requirements[0].id,
      committed: true
    }
  ]);
  assert.equal(await prisma.slotBinding.count({ where: { projectId: project.id, requirementId: requirements[0].id } }), 1);
});

test("SlotBindingService queues the fourth active requirement without binding main", async () => {
  const { project, requirements } = await createProjectWithRequirements(4);
  const service = new SlotBindingService(prisma);

  for (const requirement of requirements.slice(0, 3)) {
    const bound = await service.bindRequirement({
      projectId: project.id,
      requirementId: requirement.id
    });
    assert.match(bound.slotId, /^slot-[1-3]$/);
  }
  const overflow = await service.bindRequirement({
    projectId: project.id,
    requirementId: requirements[3].id
  });

  assert.equal(overflow, null);
  assert.equal(await prisma.slotBinding.count({ where: { projectId: project.id, slotId: "main" } }), 0);
  assert.equal(await prisma.slotBinding.count({ where: { projectId: project.id } }), 3);
});

test("isSlotId accepts supported topology bounds and rejects out-of-range values", () => {
  assert.equal(isSlotId("slot-16"), true);
  assert.equal(isSlotId("slot-17"), false);
  assert.equal(isSlotId("slot-0"), false);
  assert.equal(isSlotId("slot-x"), false);
  assert.equal(isSlotId("main"), false);
  assert.equal(isSlotId("slot-4", 3), false);
  assert.equal(isSlotId("slot-4", 4), true);
});

test("SlotBindingService uses project slotCount when claiming the fourth requirement", async () => {
  const { project, requirements } = await createProjectWithRequirements(4, 4);
  const service = new SlotBindingService(prisma);

  for (const requirement of requirements) {
    await service.bindRequirement({
      projectId: project.id,
      requirementId: requirement.id
    });
  }

  const bindings = await prisma.slotBinding.findMany({
    where: { projectId: project.id },
    orderBy: { slotId: "asc" }
  });
  assert.deepEqual(bindings.map((binding) => binding.slotId), ["slot-1", "slot-2", "slot-3", "slot-4"]);
  assert.equal(bindings.find((binding) => binding.slotId === "slot-4")?.requirementId, requirements[3].id);
});

test("SlotBindingService explicit release drains then idles and emits slot_released", async () => {
  const { project, requirements } = await createProjectWithRequirements(1);
  const service = new SlotBindingService(prisma);
  const bound = await service.bindRequirement({
    projectId: project.id,
    requirementId: requirements[0].id
  });

  const released = await service.releaseSlot({
    projectId: project.id,
    slotId: bound.slotId,
    reason: "manual_release",
    releasedBy: "user",
    operatorReason: "operator requested release"
  });

  assert.equal(released.state, "idle");
  assert.equal(released.requirementId, null);
  assert.equal(released.releasedAt instanceof Date, true);
  const event = await prisma.eventJournal.findFirstOrThrow({ where: { eventType: "slot_released" } });
  assert.equal(JSON.parse(event.payloadJson).operatorReason, "operator requested release");
});

test("SlotBindingService keeps release authoritative when the release callback fails", async () => {
  const { project, requirements } = await createProjectWithRequirements(1);
  const service = new SlotBindingService(prisma, {
    onSlotReleased: async () => {
      throw new Error("tips sync failed");
    }
  });
  const bound = await service.bindRequirement({
    projectId: project.id,
    requirementId: requirements[0].id
  });

  const released = await service.releaseSlot({
    projectId: project.id,
    slotId: bound.slotId,
    reason: "manual_release",
    releasedBy: "user"
  });

  assert.equal(released.state, "idle");
  assert.equal(released.requirementId, null);
  assert.equal(await prisma.eventJournal.count({ where: { eventType: "slot_released" } }), 1);
});

test("SlotBindingService release callback drains the oldest queued requirement into the freed slot", async () => {
  const { project, requirements } = await createProjectWithRequirements(4);
  let router!: JobSlotRouter;
  const service = new SlotBindingService(prisma, {
    onSlotReleased: async ({ projectId }) => {
      await router.tick(projectId);
    }
  });
  router = new JobSlotRouter({ prismaClient: prisma, slotBinding: service });

  for (const requirement of requirements.slice(0, 3)) {
    await service.bindRequirement({ projectId: project.id, requirementId: requirement.id });
  }
  const queued = await router.enqueue({
    projectId: project.id,
    requirementId: requirements[3].id,
    subjectType: "requirement",
    subjectId: requirements[3].id,
    command: "/ccb:su-flow --payload {}"
  });

  await service.releaseSlot({
    projectId: project.id,
    slotId: "slot-1",
    reason: "requirement_archived",
    releasedBy: "system"
  });

  const row = await prisma.anchorDispatchQueue.findUniqueOrThrow({ where: { jobId: queued.jobId } });
  assert.equal(row.anchorId, "slot-1");
  assert.equal(row.status, "pending");
  const rebound = await prisma.slotBinding.findUniqueOrThrow({
    where: {
      projectId_slotId: {
        projectId: project.id,
        slotId: "slot-1"
      }
    }
  });
  assert.equal(rebound.requirementId, requirements[3].id);
  assert.equal(rebound.state, "bound");
  assert.equal(await prisma.eventJournal.count({ where: { eventType: "slot_queued_request" } }), 1);
});

test("reconcileCancelledRequirementProjection releases non-busy slot and supersedes same-scope pending dispatches", async () => {
  const { project, requirements } = await createProjectWithRequirements(2);
  const requirement = await prisma.requirement.update({
    where: { id: requirements[0].id },
    data: { status: "cancelled" }
  });
  const task = await prisma.task.create({
    data: {
      projectId: project.id,
      requirementId: requirement.id,
      taskKey: `cancel-reconcile-${randomUUID()}`,
      title: "Cancelled child",
      status: "reviewing",
      currentNode: "dispatch"
    }
  });
  await prisma.slotBinding.create({
    data: {
      projectId: project.id,
      slotId: "slot-1",
      requirementId: requirement.id,
      state: "bound",
      boundAt: new Date("2026-06-06T10:00:00.000Z"),
      lastActivityAt: new Date("2026-06-06T10:00:00.000Z")
    }
  });
  await prisma.anchorDispatchQueue.createMany({
    data: [
      {
        projectId: project.id,
        jobId: "job-reconcile-requirement",
        anchorId: "slot-1",
        subjectType: "requirement",
        subjectId: requirement.id,
        command: "/ccb:su-flow --payload {}",
        status: "pending"
      },
      {
        projectId: project.id,
        jobId: "job-reconcile-subtask",
        anchorId: "slot-1",
        subjectType: "subtask",
        subjectId: task.id,
        command: "/ccb:su-dispatch --payload {}",
        status: "pending"
      },
      {
        projectId: project.id,
        jobId: "job-reconcile-cancel",
        anchorId: "slot-1",
        subjectType: "requirement",
        subjectId: requirement.id,
        command: "/ccb:su-cancel --payload {}",
        status: "pending"
      }
    ]
  });

  const result = await reconcileCancelledRequirementProjection(prisma, {
    projectId: project.id,
    requirementId: requirement.id
  });

  assert.equal(result.requirementCancelled, true);
  assert.equal(result.superseded, 2);
  assert.deepEqual(result.releasedSlotIds, ["slot-1"]);
  const binding = await prisma.slotBinding.findUniqueOrThrow({
    where: {
      projectId_slotId: {
        projectId: project.id,
        slotId: "slot-1"
      }
    }
  });
  assert.equal(binding.state, "idle");
  assert.equal(binding.requirementId, null);
  const requirementRow = await prisma.anchorDispatchQueue.findUniqueOrThrow({ where: { jobId: "job-reconcile-requirement" } });
  const subtaskRow = await prisma.anchorDispatchQueue.findUniqueOrThrow({ where: { jobId: "job-reconcile-subtask" } });
  const cancelRow = await prisma.anchorDispatchQueue.findUniqueOrThrow({ where: { jobId: "job-reconcile-cancel" } });
  assert.equal(requirementRow.status, "superseded");
  assert.equal(subtaskRow.status, "superseded");
  assert.equal(cancelRow.status, "pending");
  const releaseEvent = await prisma.eventJournal.findFirstOrThrow({ where: { eventType: "slot_released" } });
  assert.equal(JSON.parse(releaseEvent.payloadJson).reason, "requirement_cancelled");
});

test("reconcileCancelledRequirementProjection does not release busy slots before the current job yields", async () => {
  const { project, requirements } = await createProjectWithRequirements(1);
  const requirement = await prisma.requirement.update({
    where: { id: requirements[0].id },
    data: { status: "cancelled" }
  });
  await prisma.slotBinding.create({
    data: {
      projectId: project.id,
      slotId: "slot-1",
      requirementId: requirement.id,
      state: "busy",
      boundAt: new Date("2026-06-06T10:00:00.000Z"),
      busySince: new Date("2026-06-06T10:01:00.000Z")
    }
  });
  await prisma.anchorDispatchQueue.create({
    data: {
      projectId: project.id,
      jobId: "job-busy-reconcile",
      anchorId: "slot-1",
      subjectType: "requirement",
      subjectId: requirement.id,
      command: "/ccb:su-flow --payload {}",
      status: "pending"
    }
  });

  const result = await reconcileCancelledRequirementProjection(prisma, {
    projectId: project.id,
    requirementId: requirement.id
  });

  assert.deepEqual(result.busySlotIds, ["slot-1"]);
  assert.deepEqual(result.releasedSlotIds, []);
  const binding = await prisma.slotBinding.findUniqueOrThrow({
    where: {
      projectId_slotId: {
        projectId: project.id,
        slotId: "slot-1"
      }
    }
  });
  assert.equal(binding.state, "busy");
  assert.equal(binding.requirementId, requirement.id);
  assert.equal(await prisma.eventJournal.count({ where: { eventType: "slot_released" } }), 0);
  const queued = await prisma.anchorDispatchQueue.findUniqueOrThrow({ where: { jobId: "job-busy-reconcile" } });
  assert.equal(queued.status, "superseded");
});

test("reconcileCancelledRequirementProjection accepts slot-4 when project slotCount is 4", async () => {
  const { project, requirements } = await createProjectWithRequirements(1, 4);
  const requirement = await prisma.requirement.update({
    where: { id: requirements[0].id },
    data: { status: "cancelled" }
  });
  await prisma.slotBinding.create({
    data: {
      projectId: project.id,
      slotId: "slot-4",
      requirementId: requirement.id,
      state: "bound",
      boundAt: new Date("2026-06-06T10:00:00.000Z"),
      lastActivityAt: new Date("2026-06-06T10:00:00.000Z")
    }
  });

  const result = await reconcileCancelledRequirementProjection(prisma, {
    projectId: project.id,
    requirementId: requirement.id
  });

  assert.deepEqual(result.releasedSlotIds, ["slot-4"]);
  const binding = await prisma.slotBinding.findUniqueOrThrow({
    where: {
      projectId_slotId: {
        projectId: project.id,
        slotId: "slot-4"
      }
    }
  });
  assert.equal(binding.state, "idle");
  assert.equal(binding.requirementId, null);
});

test("updateSlotActivityForCapabilityOutcome releases a busy slot after requirement.cancel outcome is projected", async () => {
  const { project, requirements } = await createProjectWithRequirements(1);
  const requirement = await prisma.requirement.update({
    where: { id: requirements[0].id },
    data: { status: "cancelled" }
  });
  await prisma.slotBinding.create({
    data: {
      projectId: project.id,
      slotId: "slot-1",
      requirementId: requirement.id,
      state: "busy",
      boundAt: new Date("2026-06-06T10:00:00.000Z"),
      busySince: new Date("2026-06-06T10:01:00.000Z"),
      lastActivityAt: new Date("2026-06-06T10:00:00.000Z")
    }
  });

  const updated = await updateSlotActivityForCapabilityOutcome(prisma, {
    projectId: project.id,
    subjectType: "requirement",
    subjectId: requirement.id,
    emittedAt: new Date("2026-06-06T10:02:00.000Z"),
    capabilityId: "requirement.cancel",
    outcomeType: "cancelled"
  });

  assert.equal(updated, 1);
  const binding = await prisma.slotBinding.findUniqueOrThrow({
    where: {
      projectId_slotId: {
        projectId: project.id,
        slotId: "slot-1"
      }
    }
  });
  assert.equal(binding.state, "idle");
  assert.equal(binding.requirementId, null);
  assert.equal(binding.busySince, null);
  assert.equal(await prisma.eventJournal.count({ where: { eventType: "slot_released" } }), 1);
});
