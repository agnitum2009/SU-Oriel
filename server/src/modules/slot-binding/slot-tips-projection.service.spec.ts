import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, test, vi } from "vitest";

import { prisma } from "../../db/prisma.js";
import { AttentionInboxService } from "../attention-inbox/attention-inbox.service.js";
import {
  computeSlotTipsProjection,
  SLOT_TIP_TITLE_MAX_CHARS,
  syncSlotTips
} from "./slot-tips-projection.service.js";

const tmpRoots: string[] = [];

async function resetDatabase(): Promise<void> {
  await prisma.attentionAck.deleteMany();
  await prisma.projectAttentionSettings.deleteMany();
  await prisma.anchorDispatchQueue.deleteMany();
  await prisma.consultRequest.deleteMany();
  await prisma.eventJournal.deleteMany();
  await prisma.reviewIntent.deleteMany();
  await prisma.slotBinding.deleteMany();
  await prisma.anchorAllocation.deleteMany();
  await prisma.taskWorkspace.deleteMany();
  await prisma.syncJob.deleteMany();
  await prisma.task.deleteMany();
  await prisma.document.deleteMany();
  await prisma.requirement.deleteMany();
  await prisma.projectSettings.deleteMany();
  await prisma.project.deleteMany();
}

async function createProjectWithRoot(): Promise<{ projectId: string; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "ccb-slot-tips-"));
  tmpRoots.push(root);
  const project = await prisma.project.create({
    data: {
      name: `slot-tips-${randomUUID()}`,
      localPath: root
    }
  });
  return { projectId: project.id, root };
}

async function createRequirement(projectId: string, title: string) {
  return await prisma.requirement.create({
    data: {
      projectId,
      title,
      description: "slot tips fixture",
      status: "planning"
    }
  });
}

beforeEach(async () => {
  await resetDatabase();
});

afterEach(async () => {
  await resetDatabase();
  await Promise.all(tmpRoots.map((root) => rm(root, { recursive: true, force: true })));
  tmpRoots.length = 0;
});

test("computeSlotTipsProjection includes active requirement bindings sorted by slot id with truncated titles", async () => {
  const { projectId } = await createProjectWithRoot();
  const longTitle = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const activeOne = await createRequirement(projectId, longTitle);
  const activeTwo = await createRequirement(projectId, "中文标题");
  const draining = await createRequirement(projectId, "Draining Requirement");

  await prisma.slotBinding.create({
    data: { projectId, slotId: "slot-2", requirementId: activeTwo.id, state: "busy" }
  });
  await prisma.slotBinding.create({
    data: { projectId, slotId: "slot-1", requirementId: activeOne.id, state: "bound" }
  });
  await prisma.slotBinding.create({
    data: { projectId, slotId: "slot-3", requirementId: draining.id, state: "draining" }
  });

  const tips = await computeSlotTipsProjection(prisma, projectId);

  assert.deepEqual(tips, [
    `slot-1: ${longTitle.slice(0, SLOT_TIP_TITLE_MAX_CHARS - 3)}...`,
    "slot-2: 中文标题"
  ]);
});

test("computeSlotTipsProjection marks attention-level requirement tips and ack removes the marker", async () => {
  const { projectId } = await createProjectWithRoot();
  const requirement = await createRequirement(projectId, "Needs Decision");
  const task = await prisma.task.create({
    data: {
      projectId,
      requirementId: requirement.id,
      taskKey: `task-${randomUUID()}`,
      title: "Review task",
      currentNode: "review",
      status: "reviewing"
    }
  });
  const reviewIntent = await prisma.reviewIntent.create({
    data: {
      projectId,
      taskId: task.id,
      taskKey: task.taskKey,
      intentType: "mark_review_pass",
      payloadJson: JSON.stringify({ summary: "确认回执" }),
      status: "pending",
      createdAt: new Date("2026-06-06T12:00:00.000Z")
    }
  });
  await prisma.slotBinding.create({
    data: { projectId, slotId: "slot-1", requirementId: requirement.id, state: "bound" }
  });

  assert.deepEqual(await computeSlotTipsProjection(prisma, projectId), ["slot-1: ⚠️待你决策 Needs Decision"]);

  await new AttentionInboxService(prisma).ackAttention(projectId, `review_intent:${reviewIntent.id}`);

  assert.deepEqual(await computeSlotTipsProjection(prisma, projectId), ["slot-1: Needs Decision"]);
});

test("syncSlotTips writes a full managed projection and clears to an empty tips array", async () => {
  const { projectId, root } = await createProjectWithRoot();
  const requirement = await createRequirement(projectId, "Projected Requirement");
  await prisma.slotBinding.create({
    data: { projectId, slotId: "slot-1", requirementId: requirement.id, state: "bound" }
  });

  const written = await syncSlotTips(projectId, { client: prisma });

  assert.equal(written.status, "ok");
  let config = await readFile(join(root, ".ccb", "ccb.config"), "utf8");
  assert.match(config, /^\[ui\.sidebar\.view]$/m);
  assert.match(config, /"slot-1: Projected Requirement"/);

  await prisma.slotBinding.update({
    where: { projectId_slotId: { projectId, slotId: "slot-1" } },
    data: { requirementId: null, state: "idle" }
  });
  const cleared = await syncSlotTips(projectId, { client: prisma });

  assert.equal(cleared.status, "ok");
  config = await readFile(join(root, ".ccb", "ccb.config"), "utf8");
  assert.match(config, /^tips = \[]$/m);
  assert.doesNotMatch(config, /Projected Requirement/);
});

test("syncSlotTips skips managed-config writes when the tips content hash is unchanged", async () => {
  const { projectId } = await createProjectWithRoot();
  const requirement = await createRequirement(projectId, "Stable Text");
  await prisma.slotBinding.create({
    data: { projectId, slotId: "slot-1", requirementId: requirement.id, state: "bound" }
  });

  let refCounter = 0;
  const attentionService = {
    async computeAttention() {
      refCounter += 1;
      return {
        project_id: projectId,
        count: 1,
        items: [
          {
            ref: `attention-${refCounter}`,
            kind: "review_intent" as const,
            source: "review_intent" as const,
            severity: "attention" as const,
            subjectType: "requirement" as const,
            projectId,
            requirementId: requirement.id,
            taskId: null,
            taskKey: null,
            slotId: null,
            title: "Review",
            summary: "Review",
            createdAt: new Date("2026-06-06T12:00:00.000Z").toISOString(),
            updatedAt: null,
            cta: { type: "requirement" as const, label: "打开需求", projectId, requirementId: requirement.id }
          }
        ]
      };
    }
  };
  const writeManagedConfig = vi.fn(async () => ({
    configText: "",
    coreSignature: "",
    drift: null
  }));

  const first = await syncSlotTips(projectId, { client: prisma, attentionService, writeManagedConfig });
  const second = await syncSlotTips(projectId, { client: prisma, attentionService, writeManagedConfig });

  assert.equal(first.status, "ok");
  assert.equal(second.status, "skipped");
  assert.equal(second.reason, "content_unchanged");
  assert.equal(writeManagedConfig.mock.calls.length, 1);
});

test("syncSlotTips serializes concurrent syncs through a project lock", async () => {
  const { projectId, root } = await createProjectWithRoot();
  const first = await createRequirement(projectId, "First");
  const second = await createRequirement(projectId, "Second");
  await prisma.slotBinding.create({
    data: { projectId, slotId: "slot-1", requirementId: first.id, state: "bound" }
  });
  await prisma.slotBinding.create({
    data: { projectId, slotId: "slot-2", requirementId: second.id, state: "bound" }
  });

  const results = await Promise.all([
    syncSlotTips(projectId, { client: prisma }),
    syncSlotTips(projectId, { client: prisma })
  ]);

  assert.deepEqual(results.map((result) => result.status), ["ok", "skipped"]);
  assert.equal(results[1]?.reason, "content_unchanged");
  const config = await readFile(join(root, ".ccb", "ccb.config"), "utf8");
  assert.match(config, /"slot-1: First"/);
  assert.match(config, /"slot-2: Second"/);
});
