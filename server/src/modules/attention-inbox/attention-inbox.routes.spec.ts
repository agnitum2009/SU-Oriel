import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeEach, test } from "vitest";

import { buildApp } from "../../app.js";
import { prisma } from "../../db/prisma.js";

async function resetDatabase(): Promise<void> {
  await prisma.attentionAck.deleteMany();
  await prisma.projectAttentionSettings.deleteMany();
  await prisma.consultRequest.deleteMany();
  await prisma.eventJournal.deleteMany();
  await prisma.reviewIntent.deleteMany();
  await prisma.slotBinding.deleteMany();
  await prisma.taskWorkspace.deleteMany();
  await prisma.syncJob.deleteMany();
  await prisma.task.deleteMany();
  await prisma.document.deleteMany();
  await prisma.requirement.deleteMany();
  await prisma.projectSettings.deleteMany();
  await prisma.project.deleteMany();
}

async function fixture() {
  const project = await prisma.project.create({
    data: {
      name: `Attention route ${randomUUID()}`,
      localPath: join(tmpdir(), `ccb-attention-route-${randomUUID()}`),
      updatedAt: new Date("2026-06-06T12:00:00.000Z")
    }
  });
  const task = await prisma.task.create({
    data: {
      projectId: project.id,
      taskKey: `task-${randomUUID()}`,
      title: "Route task",
      currentNode: "review",
      status: "reviewing",
      updatedAt: new Date("2026-06-06T12:00:00.000Z")
    }
  });
  const intent = await prisma.reviewIntent.create({
    data: {
      projectId: project.id,
      taskId: task.id,
      taskKey: task.taskKey,
      intentType: "mark_review_pass",
      payloadJson: "Please review",
      status: "pending",
      createdAt: new Date("2026-06-06T11:00:00.000Z")
    }
  });
  return { projectId: project.id, taskId: task.id, intentRef: `review_intent:${intent.id}` };
}

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await resetDatabase();
  await prisma.$disconnect();
});

test("attention routes list items and ack the same ref idempotently", async () => {
  const fx = await fixture();
  const app = buildApp({ enableFileWatcher: false });

  const list = await app.inject({ method: "GET", url: `/api/projects/${fx.projectId}/attention` });
  assert.equal(list.statusCode, 200);
  assert.equal(list.json().count, 1);
  assert.equal(list.json().items[0].ref, fx.intentRef);

  const firstAck = await app.inject({
    method: "POST",
    url: `/api/projects/${fx.projectId}/attention/ack`,
    payload: { ref: fx.intentRef }
  });
  assert.equal(firstAck.statusCode, 200);
  assert.equal(firstAck.json().ref, fx.intentRef);

  const secondAck = await app.inject({
    method: "POST",
    url: `/api/projects/${fx.projectId}/attention/ack`,
    payload: { ref: fx.intentRef }
  });
  assert.equal(secondAck.statusCode, 200);
  assert.equal(secondAck.json().ref, fx.intentRef);

  const afterAck = await app.inject({ method: "GET", url: `/api/projects/${fx.projectId}/attention` });
  assert.equal(afterAck.statusCode, 200);
  assert.equal(afterAck.json().count, 0);

  await app.close();
});

test("attention settings routes persist and clear project DND", async () => {
  const fx = await fixture();
  const app = buildApp({ enableFileWatcher: false });

  const dndUntil = "2099-01-01T00:00:00.000Z";
  const put = await app.inject({
    method: "PUT",
    url: `/api/projects/${fx.projectId}/attention/settings`,
    payload: { dnd_until: dndUntil }
  });
  assert.equal(put.statusCode, 200);
  assert.equal(put.json().dnd_until, dndUntil);

  const suppressed = await app.inject({ method: "GET", url: `/api/projects/${fx.projectId}/attention` });
  assert.equal(suppressed.statusCode, 200);
  assert.equal(suppressed.json().count, 0);

  const cleared = await app.inject({
    method: "PUT",
    url: `/api/projects/${fx.projectId}/attention/settings`,
    payload: { dnd_until: null }
  });
  assert.equal(cleared.statusCode, 200);
  assert.equal(cleared.json().dnd_until, null);

  const visible = await app.inject({ method: "GET", url: `/api/projects/${fx.projectId}/attention` });
  assert.equal(visible.statusCode, 200);
  assert.equal(visible.json().count, 1);

  await app.close();
});

test("attention routes return 404 for missing projects", async () => {
  const app = buildApp({ enableFileWatcher: false });
  const response = await app.inject({ method: "GET", url: `/api/projects/missing-${randomUUID()}/attention` });
  assert.equal(response.statusCode, 404);
  await app.close();
});
