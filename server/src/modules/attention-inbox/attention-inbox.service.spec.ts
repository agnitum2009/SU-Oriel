import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeEach, test } from "vitest";

import { prisma } from "../../db/prisma.js";
import { TaskEventViewService } from "../task-event-view/task-event-view.service.js";
import { AttentionInboxService } from "./attention-inbox.service.js";

const NOW = new Date("2026-06-06T12:00:00.000Z");
const ATTENTION_EVENT_TYPES = [
  "codex_receipt_ready",
  "codex_rejected",
  "state_write_conflict",
  "anchor_dispatch_failed"
] as const;

async function resetDatabase(): Promise<void> {
  await prisma.attentionAck.deleteMany();
  await prisma.projectAttentionSettings.deleteMany();
  await prisma.anchorDispatchQueue.deleteMany();
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
  const localPath = join(tmpdir(), `ccb-attention-${randomUUID()}`);
  const project = await prisma.project.create({
    data: {
      name: `Attention ${randomUUID()}`,
      localPath,
      updatedAt: NOW
    }
  });
  const requirement = await prisma.requirement.create({
    data: {
      projectId: project.id,
      title: "主动通知需求",
      description: "desc",
      status: "delivering"
    }
  });
  const task = await prisma.task.create({
    data: {
      projectId: project.id,
      requirementId: requirement.id,
      taskKey: `task-${randomUUID()}`,
      title: "Attention task",
      currentNode: "review",
      status: "reviewing",
      updatedAt: NOW
    }
  });
  return { projectId: project.id, localPath, requirementId: requirement.id, taskId: task.id, taskKey: task.taskKey };
}

async function createOtherProjectConsultRequest(): Promise<void> {
  const other = await fixture();
  await prisma.consultRequest.create({
    data: {
      taskId: other.taskId,
      taskKey: other.taskKey,
      nodeId: "review",
      message: "Other project consult",
      targetAgent: "ccb_codex",
      status: "pending",
      createdBy: "console_user",
      createdAt: new Date("2026-06-06T11:50:00.000Z")
    }
  });
}

async function seedAllBusinessSources(fx: Awaited<ReturnType<typeof fixture>>): Promise<void> {
  await prisma.reviewIntent.create({
    data: {
      projectId: fx.projectId,
      taskId: fx.taskId,
      taskKey: fx.taskKey,
      intentType: "mark_review_pass",
      payloadJson: JSON.stringify({ summary: "请确认实现回执", node_id: "review" }),
      status: "pending",
      createdAt: new Date("2026-06-06T11:00:00.000Z")
    }
  });
  await prisma.consultRequest.create({
    data: {
      taskId: fx.taskId,
      taskKey: fx.taskKey,
      nodeId: "review",
      message: "Need implementation opinion",
      targetAgent: "ccb_codex",
      status: "pending",
      createdBy: "console_user",
      createdAt: new Date("2026-06-06T11:01:00.000Z")
    }
  });
  await prisma.document.create({
    data: {
      projectId: fx.projectId,
      taskKey: fx.taskKey,
      path: `docs/03_开发计划/${fx.taskKey}-开发任务.md`,
      kind: "dev_task",
      title: "Dev Task",
      status: "reviewing",
      frontmatterJson: JSON.stringify({
        doc_type: "dev_task",
        task_id: fx.taskKey,
        approval_records: JSON.stringify([
          { id: "approve-1", gate: "release", decided: false, created_at: "2026-06-06T11:02:00.000Z" },
          { id: "approve-2", gate: "skip", decided: true }
        ]),
        pending_user_decision: JSON.stringify({
          id: "decision-1",
          summary: "选择下一步",
          created_at: "2026-06-06T11:03:00.000Z"
        })
      }),
      contentHash: randomUUID(),
      mtime: new Date("2026-06-06T11:03:00.000Z")
    }
  });
  for (const [index, eventType] of ATTENTION_EVENT_TYPES.entries()) {
    await prisma.eventJournal.create({
      data: {
        eventId: `event-${eventType}-${randomUUID()}`,
        eventType,
        projectId: fx.projectId,
        subjectType: "subtask",
        subjectId: fx.taskId,
        subjectKey: fx.taskKey,
        emittedAt: new Date(`2026-06-06T11:0${index + 4}:00.000Z`),
        payloadJson: JSON.stringify({ receipt_summary: "done", reason: "rejected", primitive: "apply", errorMessage: "failed" }),
        sourceActor: "codex",
        sourceComponent: "test"
      }
    });
  }
  await prisma.slotBinding.create({
    data: {
      projectId: fx.projectId,
      slotId: "slot-2",
      requirementId: fx.requirementId,
      state: "unhealthy",
      boundAt: new Date("2026-06-06T10:00:00.000Z"),
      lastActivityAt: new Date("2026-06-06T11:08:00.000Z")
    }
  });
  await prisma.slotBinding.create({
    data: {
      projectId: fx.projectId,
      slotId: "slot-3",
      requirementId: fx.requirementId,
      state: "recovering",
      boundAt: new Date("2026-06-06T10:00:00.000Z"),
      lastActivityAt: new Date("2026-06-06T11:09:00.000Z")
    }
  });
}

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await resetDatabase();
  await prisma.$disconnect();
});

test("computeAttention derives the 5 business sources in batch and keeps source-native refs stable", async () => {
  const fx = await fixture();
  await seedAllBusinessSources(fx);
  await createOtherProjectConsultRequest();

  const service = new AttentionInboxService(prisma);
  const first = await service.computeAttention(fx.projectId, { now: NOW });
  const second = await service.computeAttention(fx.projectId, { now: NOW });

  assert.equal(first.count, 10);
  assert.deepEqual(first.items.map((item) => item.ref), second.items.map((item) => item.ref));
  assert.ok(first.items.some((item) => item.ref.startsWith("review_intent:")));
  assert.ok(first.items.some((item) => item.ref.startsWith("consult_request:")));
  assert.ok(first.items.some((item) => item.ref === `dev_task_approval:${fx.taskKey}/approval_records[0]`));
  assert.ok(first.items.some((item) => item.ref === `dev_task_approval:${fx.taskKey}/pending_user_decision`));
  for (const eventType of ATTENTION_EVENT_TYPES) {
    assert.ok(
      first.items.some(
        (item) =>
          item.ref.startsWith(`event_journal:event-${eventType}-`) &&
          item.kind === eventType &&
          item.severity === "attention"
      ),
      `missing EventJournal attention item for ${eventType}`
    );
  }
  assert.ok(
    first.items.some(
      (item) =>
        item.ref === "slot_binding:slot-2/unhealthy" &&
        item.kind === "slot_unhealthy" &&
        item.severity === "warning"
    )
  );
  assert.ok(
    first.items.some(
      (item) =>
        item.ref === "slot_binding:slot-3/recovering" &&
        item.kind === "slot_recovering" &&
        item.severity === "warning"
    )
  );
  assert.equal(first.items.filter((item) => item.kind === "consult_request").length, 1);
  assert.deepEqual(new Set(first.items.filter((item) => item.severity === "attention").map((item) => item.kind)), new Set([
    "review_intent",
    "consult_request",
    "dev_task_approval",
    "dev_task_user_decision",
    "codex_receipt_ready",
    "codex_rejected",
    "state_write_conflict",
    "anchor_dispatch_failed"
  ]));
});

test("ack left-anti-join and DND marks delivery pause without hiding attention items", async () => {
  const fx = await fixture();
  await seedAllBusinessSources(fx);
  const service = new AttentionInboxService(prisma);
  const targetRef = (await service.computeAttention(fx.projectId, { now: NOW })).items[0].ref;

  await service.ackAttention(fx.projectId, targetRef, NOW);
  await service.ackAttention(fx.projectId, targetRef, NOW);
  const afterAck = await service.computeAttention(fx.projectId, { now: NOW });
  assert.equal(afterAck.items.some((item) => item.ref === targetRef), false);
  assert.equal(afterAck.count, 9);

  const dndUntil = new Date("2026-06-06T13:00:00.000Z");
  await service.putSettings(fx.projectId, dndUntil);
  const dnd = await service.computeAttention(fx.projectId, { now: NOW });
  assert.equal(dnd.count, 9);
  assert.equal(dnd.items.length, 9);
  assert.equal(dnd.dnd_active, true);
  assert.equal(dnd.dnd_until, dndUntil.toISOString());

  await service.putSettings(fx.projectId, null);
  const visibleAgain = await service.computeAttention(fx.projectId, { now: NOW });
  assert.equal(visibleAgain.count, 9);
  assert.equal(visibleAgain.dnd_active, false);
  assert.equal(visibleAgain.dnd_until, null);
});

test("computeAttention includes provider activity source and ack suppresses it", async () => {
  const fx = await fixture();
  await writeProviderActivityFixture(fx.localPath);
  await prisma.slotBinding.create({
    data: {
      projectId: fx.projectId,
      slotId: "slot-1",
      requirementId: fx.requirementId,
      state: "bound",
      boundAt: new Date("2026-06-06T10:00:00.000Z"),
      lastActivityAt: new Date("2026-06-06T11:59:00.000Z")
    }
  });

  const service = new AttentionInboxService(prisma);
  const first = await service.computeAttention(fx.projectId, { now: NOW });
  const providerItem = first.items.find((item) => item.kind === "agent_waiting");

  assert.ok(providerItem);
  assert.equal(providerItem.source, "provider_activity");
  assert.equal(providerItem.severity, "attention");
  assert.equal(providerItem.requirementId, fx.requirementId);
  assert.equal(providerItem.slotId, "slot-1");
  assert.equal(providerItem.metadata?.reason, "question");

  await service.ackAttention(fx.projectId, providerItem.ref, NOW);
  const afterAck = await service.computeAttention(fx.projectId, { now: NOW });
  assert.equal(afterAck.items.some((item) => item.ref === providerItem.ref), false);
});

test("computeAttention projects unhealthy slots without requirement binding using slot fallback CTA", async () => {
  const fx = await fixture();
  await prisma.slotBinding.create({
    data: {
      projectId: fx.projectId,
      slotId: "slot-9",
      requirementId: null,
      state: "unhealthy",
      boundAt: new Date("2026-06-06T10:00:00.000Z"),
      lastActivityAt: new Date("2026-06-06T11:08:00.000Z")
    }
  });

  const service = new AttentionInboxService(prisma);
  const result = await service.computeAttention(fx.projectId, { now: NOW });
  const item = result.items.find((entry) => entry.ref === "slot_binding:slot-9/unhealthy");

  assert.ok(item);
  assert.equal(item.kind, "slot_unhealthy");
  assert.equal(item.severity, "warning");
  assert.equal(item.requirementId, null);
  assert.equal(item.summary, "slot-9: unhealthy");
  assert.deepEqual(item.cta, {
    type: "slot",
    label: "定位 slot",
    projectId: fx.projectId,
    requirementId: null,
    slotId: "slot-9"
  });
});

test("task-event-view keeps existing severity mapping after helper extraction", async () => {
  const fx = await fixture();
  await prisma.eventJournal.create({
    data: {
      eventId: randomUUID(),
      eventType: "codex_receipt_ready",
      projectId: fx.projectId,
      subjectType: "subtask",
      subjectId: fx.taskId,
      subjectKey: fx.taskKey,
      emittedAt: new Date("2026-06-06T11:00:00.000Z"),
      payloadJson: JSON.stringify({ receipt_ref: "r.md", provider: "codex", receipt_summary: "done", unsolicited_findings: [] })
    }
  });
  const timeline = await new TaskEventViewService(prisma).buildTimeline(fx.taskId);
  assert.equal(timeline.events[0]?.kind, "codex_receipt_ready");
  assert.equal(timeline.events[0]?.severity, "info");
});

async function writeProviderActivityFixture(projectRoot: string): Promise<void> {
  await mkdir(join(projectRoot, ".ccb", "agents", "slot1_codex", "provider-runtime", "codex"), { recursive: true });
  await writeFile(
    join(projectRoot, ".ccb", "ccb.config"),
    [
      "version = 2",
      'entry_window = "main"',
      "",
      "[windows]",
      'slot-1 = "slot1_codex:codex"',
      "",
      "[agents.slot1_codex]",
      'provider = "codex"',
      ""
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    join(projectRoot, ".ccb", "agents", "slot1_codex", "provider-runtime", "codex", "activity.json"),
    JSON.stringify({
      schema_version: 1,
      record_type: "provider_activity",
      agent_name: "slot1_codex",
      provider: "codex",
      state: "active",
      event_name: "PreToolUse",
      updated_at: "2026-06-06T12:00:00.000Z",
      provider_session_id: "provider-session-question",
      diagnostics: { tool_name: "AskUserQuestion" }
    }),
    "utf8"
  );
}
