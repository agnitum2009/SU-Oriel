import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, test } from "vitest";

import { prisma } from "../../db/prisma.js";
import { repairAnchorDispatchQueueProjectScope } from "./anchor-dispatch-queue-project-scope.js";

async function resetFixtures(): Promise<void> {
  await prisma.anchorDispatchQueue.deleteMany();
  await prisma.task.deleteMany();
  await prisma.requirement.deleteMany();
  await prisma.project.deleteMany();
}

async function createProjectFixture() {
  const suffix = randomUUID();
  const project = await prisma.project.create({
    data: {
      name: `adq-project-scope-${suffix}`,
      localPath: join(tmpdir(), `adq-project-scope-${suffix}`)
    }
  });
  const requirement = await prisma.requirement.create({
    data: {
      projectId: project.id,
      title: "Scoped requirement",
      description: "ADQ project scope fixture",
      status: "planning"
    }
  });
  const task = await prisma.task.create({
    data: {
      projectId: project.id,
      requirementId: requirement.id,
      taskKey: `adq-scope-${suffix}`,
      title: "Scoped task",
      status: "reviewing",
      currentNode: "dispatch"
    }
  });
  return { project, requirement, task };
}

beforeEach(async () => {
  await resetFixtures();
});

test("repairAnchorDispatchQueueProjectScope backfills requirement and subtask rows", async () => {
  const { project, requirement, task } = await createProjectFixture();
  await prisma.anchorDispatchQueue.createMany({
    data: [
      {
        jobId: "job_scope_requirement",
        anchorId: "slot-1",
        subjectType: "requirement",
        subjectId: requirement.id,
        command: "/ccb:su-flow --payload {}",
        status: "pending"
      },
      {
        jobId: "job_scope_subtask",
        anchorId: "slot-1",
        subjectType: "subtask",
        subjectId: task.id,
        command: "/ccb:su-dispatch --payload {}",
        status: "pending"
      }
    ]
  });

  const report = await repairAnchorDispatchQueueProjectScope(prisma);

  assert.deepEqual(report, {
    backfilledRequirementRows: 1,
    backfilledSubtaskRows: 1,
    deletedTerminalDirtyRows: 0,
    markedActiveDirtyRows: 0,
    remainingActiveDirtyRows: 0
  });
  assert.equal(await prisma.anchorDispatchQueue.count({ where: { projectId: project.id } }), 2);
});

test("repairAnchorDispatchQueueProjectScope deletes terminal dirty rows", async () => {
  await prisma.anchorDispatchQueue.create({
    data: {
      jobId: "job_terminal_dirty",
      anchorId: "slot-1",
      subjectType: "requirement",
      subjectId: "missing_requirement",
      command: "/ccb:su-flow --payload {}",
      status: "failed"
    }
  });

  const report = await repairAnchorDispatchQueueProjectScope(prisma);

  assert.equal(report.deletedTerminalDirtyRows, 1);
  assert.equal(await prisma.anchorDispatchQueue.count(), 0);
});

test("repairAnchorDispatchQueueProjectScope marks active dirty rows for operator cleanup", async () => {
  await prisma.anchorDispatchQueue.create({
    data: {
      jobId: "job_active_dirty",
      anchorId: "slot-1",
      subjectType: "requirement",
      subjectId: "missing_requirement",
      command: "/ccb:su-flow --payload {}",
      status: "pending"
    }
  });

  const report = await repairAnchorDispatchQueueProjectScope(prisma);

  assert.equal(report.markedActiveDirtyRows, 1);
  assert.equal(report.remainingActiveDirtyRows, 1);
  const row = await prisma.anchorDispatchQueue.findUniqueOrThrow({ where: { jobId: "job_active_dirty" } });
  assert.equal(row.projectId, null);
  assert.match(row.errorMessage ?? "", /project scope unresolved/);
});
