import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, test } from "vitest";

import { prisma } from "../../db/prisma.js";
import { resolveCcbProjectRoot } from "../../lib/project-root.js";
import {
  TASK_RUN_ALLOWED_TRANSITIONS,
  TASK_RUN_TERMINAL_STATES,
  assertTaskRunTransition,
  canTransitionTaskRun
} from "./task-run.state-machine.js";

async function resetDatabase(): Promise<void> {
  const taskRunDelegate = (prisma as unknown as { taskRun?: { deleteMany: () => Promise<unknown> } }).taskRun;
  if (taskRunDelegate) {
    await taskRunDelegate.deleteMany();
  } await prisma.eventJournal.deleteMany();
  await prisma.reviewIntent.deleteMany();
  await prisma.taskWorkspace.deleteMany();
  await prisma.syncJob.deleteMany();
  await prisma.requirement.deleteMany();
  await prisma.task.deleteMany();
  await prisma.document.deleteMany();
  await prisma.project.deleteMany();
}

async function createTaskFixture(): Promise<{ taskId: string }> {
  const project = await prisma.project.create({
    data: {
      name: `TaskRun Project ${randomUUID()}`,
      localPath: join(tmpdir(), `ccb-task-run-${randomUUID()}`),
      updatedAt: new Date()
    }
  });
  const task = await prisma.task.create({
    data: {
      projectId: project.id,
      taskKey: `task-${randomUUID()}`,
      title: "TaskRun state machine task",
      status: "reviewing",
      currentNode: "implementation",
      nodeSubstate: "executing",
      runtimeState: "running",
      updatedAt: new Date()
    }
  });

  return { taskId: task.id };
}

test("TaskRun allows explicit forward transitions and pause/resume loop", () => {
  assert.ok(TASK_RUN_ALLOWED_TRANSITIONS.length >= 7);
  assert.equal(canTransitionTaskRun("pending", "dispatched"), true);
  assert.equal(canTransitionTaskRun("dispatched", "running"), true);
  assert.equal(canTransitionTaskRun("running", "paused"), true);
  assert.equal(canTransitionTaskRun("paused", "running"), true);
});

test("TaskRun rejects invalid transitions", () => {
  assert.equal(canTransitionTaskRun("pending", "completed"), false);
  assert.throws(
    () => assertTaskRunTransition("pending", "completed"),
    /TaskRun transition not allowed: pending -> completed/
  );
});

test("TaskRun terminal states cannot transition", () => {
  assert.deepEqual(TASK_RUN_TERMINAL_STATES, ["completed", "cancelled", "failed-terminal"]);
  for (const terminalState of TASK_RUN_TERMINAL_STATES) {
    assert.equal(canTransitionTaskRun(terminalState, "dispatched"), false);
  }
});

test("TaskRun Prisma model persists attempt and transition journal fields", async () => {
  await resetDatabase();
  const { taskId } = await createTaskFixture();
  const taskRunDelegate = (prisma as unknown as {
    taskRun?: {
      create: (input: {
        data: {
          taskId: string;
          status: string;
          attemptN: number;
          transitionsJson: string;
          dispatchedAt: Date;
        };
      }) => Promise<{ taskId: string; status: string; attemptN: number; transitionsJson: string }>;
    };
  }).taskRun;

  assert.ok(taskRunDelegate, "prisma.taskRun delegate should exist");

  const run = await taskRunDelegate.create({
    data: {
      taskId,
      status: "dispatched",
      attemptN: 1,
      transitionsJson: JSON.stringify([{ from: "pending", to: "dispatched", attempt_n: 1 }]),
      dispatchedAt: new Date("2026-05-03T00:00:00.000Z")
    }
  });

  assert.equal(run.taskId, taskId);
  assert.equal(run.status, "dispatched");
  assert.equal(run.attemptN, 1);
  assert.deepEqual(JSON.parse(run.transitionsJson), [{ from: "pending", to: "dispatched", attempt_n: 1 }]);
});

test("TaskRun state-machine document records transitions, terminal states, and attempt tracking", async () => {
  const doc = await readFile(
    resolve(resolveCcbProjectRoot(), "docs/04_模块规格/su-oriel-taskrun状态机模块规格.md"),
    "utf8"
  );

  const transitionRows = doc.match(/\|\s*`[^`]+`\s*\|\s*`[^`]+`\s*\|/g) ?? [];
  assert.ok(transitionRows.length >= 7, `expected at least 7 transition rows, got ${transitionRows.length}`);
  assert.match(doc, /completed/);
  assert.match(doc, /cancelled/);
  assert.match(doc, /failed-terminal/);
  assert.match(doc, /attemptN/);
  assert.match(doc, /attempt 变化/);
  assert.match(doc, /\+1/);
});

afterAll(async () => {
  await resetDatabase();
  await prisma.$disconnect();
});
