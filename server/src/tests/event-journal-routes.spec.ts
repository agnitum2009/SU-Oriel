import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, test } from "vitest";

import { buildApp } from "../app.js";
import { prisma } from "../db/prisma.js";
import { emitEventInTransaction } from "../modules/events/event-journal.service.js";
import { PrismaProjectStore } from "../modules/project/project.store.prisma.js";

async function resetDatabase(): Promise<void> { await prisma.eventJournal.deleteMany();
  await prisma.reviewIntent.deleteMany();
  await prisma.taskWorkspace.deleteMany();
  await prisma.syncJob.deleteMany();
  await prisma.requirement.deleteMany();
  await prisma.task.deleteMany();
  await prisma.document.deleteMany();
  await prisma.project.deleteMany();
}

async function createTaskFixture(): Promise<{ projectId: string; taskId: string; taskKey: string }> {
  const project = await prisma.project.create({
    data: {
      name: `Event Journal Project ${randomUUID()}`,
      localPath: join(tmpdir(), `ccb-test-${randomUUID()}`),
      updatedAt: new Date()
    }
  });
  const task = await prisma.task.create({
    data: {
      projectId: project.id,
      taskKey: `task-${randomUUID()}`,
      title: "Event Journal task",
      status: "reviewing",
      currentNode: "implementation",
      nodeSubstate: "executing",
      runtimeState: "waiting_codex",
      lastTransitionId: "dispatch__on_codex_pickup__to__implementation",
      updatedAt: new Date()
    }
  });

  return {
    projectId: project.id,
    taskId: task.id,
    taskKey: task.taskKey
  };
}

function buildEventPayload(taskId: string, eventId = randomUUID(), emittedAt = "2026-04-28T00:00:00.000Z") {
  return {
    event_id: eventId,
    event_type: "codex_receipt_ready",
    task_id: taskId,
    payload: {
      receipt_ref: "docs/.ccb/state/task.md",
      provider: "codex",
      receipt_summary: "实现已完成，等待 review",
      unsolicited_findings: []
    },
    emitted_at: emittedAt,
    source_actor: "codex",
    source_component: "primitive_executor",
    causation_id: "event-prev",
    correlation_id: "corr-1",
    state_revision_seen: 12,
    idempotency_key: "audit-key-1"
  };
}

async function loadTaskStateSnapshot(taskId: string) {
  const task = await prisma.task.findUniqueOrThrow({
    where: {
      id: taskId
    },
    select: {
      currentNode: true,
      nodeSubstate: true,
      runtimeState: true,
      status: true,
      lastTransitionId: true
    }
  });
  return task;
}

test("EventJournal submit/query records codex_receipt_ready without mutating task state", async () => {
  const app = buildApp({
    projectStore: new PrismaProjectStore(prisma)
  });

  await resetDatabase();
  const fixture = await createTaskFixture();
  const beforeSnapshot = await loadTaskStateSnapshot(fixture.taskId);
  const eventId = randomUUID();

  const response = await app.inject({
    method: "POST",
    url: "/api/event-journal/events",
    payload: buildEventPayload(fixture.taskId, eventId)
  });
  assert.equal(response.statusCode, 201);
  assert.equal(response.json().success, true);
  assert.equal(response.json().result, "created");
  assert.equal(response.json().idempotent, false);
  assert.equal(response.json().event.eventId, eventId);
  assert.equal(response.json().event.eventType, "codex_receipt_ready");
  assert.equal(response.json().event.projectId, fixture.projectId);
  assert.equal(response.json().event.taskId, fixture.taskId);
  assert.equal(response.json().event.taskKey, fixture.taskKey);
  assert.equal(response.json().event.emittedAt, "2026-04-28T00:00:00.000Z");
  assert.equal(response.json().event.idempotencyKey, "audit-key-1");
  assert.deepEqual(response.json().event.payload.unsolicited_findings, []);

  const queryResponse = await app.inject({
    method: "GET",
    url: `/api/event-journal/events?task_id=${fixture.taskId}&event_type=codex_receipt_ready`
  });
  assert.equal(queryResponse.statusCode, 200);
  assert.equal(queryResponse.json().items.length, 1);
  assert.equal(queryResponse.json().pageInfo.count, 1);
  assert.equal(queryResponse.json().items[0].eventId, eventId);

  assert.deepEqual(await loadTaskStateSnapshot(fixture.taskId), beforeSnapshot);

  await app.close();
});

test("EventJournal accepts requirement_materialized payload", async () => {
  const app = buildApp({
    projectStore: new PrismaProjectStore(prisma)
  });

  await resetDatabase();
  const fixture = await createTaskFixture();
  const requirement = await prisma.requirement.create({
    data: {
      projectId: fixture.projectId,
      title: "Materialized requirement",
      description: "Requirement subject for materialization",
      status: "planning"
    }
  });
  const eventId = randomUUID();

  const response = await app.inject({
    method: "POST",
    url: "/api/event-journal/events",
    payload: {
      event_id: eventId,
      event_type: "requirement_materialized",
      subject_type: "requirement",
      subject_id: requirement.id,
      payload: {
        requirement_id: requirement.id,
        subtask_count: 3,
        plan_spec_path: "docs/03_开发计划/2026-05-13-requirement.md",
        draft_hash: "a".repeat(64)
      },
      emitted_at: "2026-05-13T00:00:00.000Z",
      source_actor: "system",
      source_component: "console"
    }
  });

  assert.equal(response.statusCode, 201);
  assert.equal(response.json().event.eventType, "requirement_materialized");
  assert.equal(response.json().event.subjectType, "requirement");
  assert.equal(response.json().event.subjectId, requirement.id);
  assert.equal(response.json().event.payload.subtask_count, 3);

  await app.close();
});

test("EventJournal accepts anchor dispatch lifecycle payloads", async () => {
  const app = buildApp({
    projectStore: new PrismaProjectStore(prisma)
  });

  await resetDatabase();
  const fixture = await createTaskFixture();
  const requirement = await prisma.requirement.create({
    data: {
      projectId: fixture.projectId,
      title: "Dispatch lifecycle requirement",
      description: "Requirement subject for anchor dispatch",
      status: "planning"
    }
  });

  const events = [
    {
      event_type: "anchor_dispatch_queued",
      payload: {
        jobId: "job_dispatch_lifecycle",
        command: '/ccb:su-flow --payload {"language":"中文","project_id":"project","requirement_id":"req","step":"design","subject":"requirement"}',
        dispatchPayload: {
          language: "中文",
          project_id: "project",
          requirement_id: "req",
          step: "design",
          subject: "requirement"
        },
        step: "design"
      }
    },
    {
      event_type: "anchor_dispatch_submitted",
      payload: {
        jobId: "job_dispatch_lifecycle",
        traceRef: "trace-dispatch",
        readinessWarning: true
      }
    },
    {
      event_type: "anchor_dispatch_failed",
      payload: {
        jobId: "job_dispatch_lifecycle",
        errorCode: "ANCHOR_SOCKET_NOT_READY",
        errorMessage: "anchor socket is not ready"
      }
    }
  ] as const;

  for (const [index, event] of events.entries()) {
    const response = await app.inject({
      method: "POST",
      url: "/api/event-journal/events",
      payload: {
        event_id: randomUUID(),
        event_type: event.event_type,
        subject_type: "requirement",
        subject_id: requirement.id,
        anchor_id: "anchor-dispatch-lifecycle",
        payload: event.payload,
        emitted_at: `2026-05-20T00:00:0${index}.000Z`,
        source_actor: "system",
        source_component: "console"
      }
    });
    assert.equal(response.statusCode, 201, response.body);
    assert.equal(response.json().event.eventType, event.event_type);
    assert.equal(response.json().event.subjectType, "requirement");
    assert.equal(response.json().event.subjectId, requirement.id);
    assert.equal(response.json().event.anchorId, "anchor-dispatch-lifecycle");
    assert.equal(response.json().event.payload.jobId, "job_dispatch_lifecycle");
  }

  await app.close();
});

test("EventJournal envelope persists anchor and generic subject columns", async () => {
  const app = buildApp({
    projectStore: new PrismaProjectStore(prisma)
  });

  await resetDatabase();
  const fixture = await createTaskFixture();
  const eventId = randomUUID();

  const response = await app.inject({
    method: "POST",
    url: "/api/event-journal/events",
    payload: {
      ...buildEventPayload(fixture.taskId, eventId),
      anchor_id: "anchor-route-1"
    }
  });

  assert.equal(response.statusCode, 201, response.body);
  assert.equal(response.json().event.anchorId, "anchor-route-1");
  assert.equal(response.json().event.subjectType, "subtask");
  assert.equal(response.json().event.subjectId, fixture.taskId);

  const stored = await prisma.eventJournal.findUniqueOrThrow({
    where: { eventId }
  });
  assert.equal(stored.anchorId, "anchor-route-1");
  assert.equal(stored.subjectType, "subtask");
  assert.equal(stored.subjectId, fixture.taskId);

  await app.close();
});

test("EventJournal accepts slot lifecycle payloads and exposes slotId alias", async () => {
  const app = buildApp({
    projectStore: new PrismaProjectStore(prisma)
  });

  await resetDatabase();
  const fixture = await createTaskFixture();
  const requirement = await prisma.requirement.create({
    data: {
      projectId: fixture.projectId,
      title: "Slot lifecycle requirement",
      description: "Requirement subject for slot lifecycle",
      status: "planning"
    }
  });

  const response = await app.inject({
    method: "POST",
    url: "/api/event-journal/events",
    payload: {
      event_id: randomUUID(),
      event_type: "slot_bound",
      subject_type: "requirement",
      subject_id: requirement.id,
      anchor_id: "slot-1",
      payload: {
        slotId: "slot-1",
        requirementId: requirement.id,
        reason: "new_requirement"
      },
      emitted_at: "2026-05-23T00:00:00.000Z",
      source_actor: "system",
      source_component: "console"
    }
  });

  assert.equal(response.statusCode, 201, response.body);
  assert.equal(response.json().event.anchorId, "slot-1");
  assert.equal(response.json().event.slotId, "slot-1");
  assert.equal(response.json().event.payload.slotId, "slot-1");

  await app.close();
});

test("EventJournal accepts slot_stale payloads without requiring slot id", async () => {
  const app = buildApp({
    projectStore: new PrismaProjectStore(prisma)
  });

  await resetDatabase();
  const fixture = await createTaskFixture();
  const requirement = await prisma.requirement.create({
    data: {
      projectId: fixture.projectId,
      title: "Slot stale requirement",
      description: "Requirement subject for slot stale",
      status: "planning"
    }
  });

  const response = await app.inject({
    method: "POST",
    url: "/api/event-journal/events",
    payload: {
      event_id: randomUUID(),
      event_type: "slot_stale",
      subject_type: "requirement",
      subject_id: requirement.id,
      payload: {
        requirementId: requirement.id,
        lastActivityAt: "2026-05-01T00:00:00.000Z",
        staleDays: 9,
        policyVersion: "slot-stale-policy-v1"
      },
      emitted_at: "2026-05-10T00:00:00.000Z",
      source_actor: "system",
      source_component: "console"
    }
  });

  assert.equal(response.statusCode, 201, response.body);
  assert.equal(response.json().event.eventType, "slot_stale");
  assert.equal(response.json().event.slotId, null);
  assert.equal(response.json().event.payload.requirementId, requirement.id);

  await app.close();
});

test("emitEventInTransaction writes anchor and generic subject columns", async () => {
  await resetDatabase();
  const fixture = await createTaskFixture();
  const eventId = randomUUID();

  await prisma.$transaction(async (tx) => {
    await emitEventInTransaction(tx, {
      event_id: eventId,
      event_type: "codex_receipt_ready",
      task_id: fixture.taskId,
      payload: {
        receipt_ref: "docs/.ccb/state/task.md",
        provider: "codex",
        receipt_summary: "实现已完成，等待 review",
        unsolicited_findings: []
      },
      emitted_at: "2026-04-28T00:00:00.000Z",
      source_actor: "codex",
      source_component: "primitive_executor",
      anchor_id: "anchor-tx-1"
    });
  });

  const stored = await prisma.eventJournal.findUniqueOrThrow({
    where: { eventId }
  });
  assert.equal(stored.anchorId, "anchor-tx-1");
  assert.equal(stored.subjectType, "subtask");
  assert.equal(stored.subjectId, fixture.taskId);
});

test("EventJournal submit rejects unsupported types and top-level state or derived fields", async () => {
  const app = buildApp({
    projectStore: new PrismaProjectStore(prisma)
  });

  await resetDatabase();
  const fixture = await createTaskFixture();

  for (const eventType of ["unknown_event"]) {
    const response = await app.inject({
      method: "POST",
      url: "/api/event-journal/events",
      payload: {
        ...buildEventPayload(fixture.taskId),
        event_type: eventType
      }
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().message, "event journal 参数不合法");
  }

  const extraFieldResponse = await app.inject({
    method: "POST",
    url: "/api/event-journal/events",
    payload: {
      ...buildEventPayload(fixture.taskId),
      projectId: fixture.projectId,
      taskKey: fixture.taskKey,
      currentNode: "review"
    }
  });
  assert.equal(extraFieldResponse.statusCode, 400);
  assert.equal(extraFieldResponse.json().message, "event journal 参数不合法");

  await app.close();
});

test("EventJournal dedupes only by event_id and keeps idempotency_key audit-only", async () => {
  const app = buildApp({
    projectStore: new PrismaProjectStore(prisma)
  });

  await resetDatabase();
  const fixture = await createTaskFixture();
  const eventId = randomUUID();

  const firstResponse = await app.inject({
    method: "POST",
    url: "/api/event-journal/events",
    payload: buildEventPayload(fixture.taskId, eventId)
  });
  assert.equal(firstResponse.statusCode, 201);

  const duplicateResponse = await app.inject({
    method: "POST",
    url: "/api/event-journal/events",
    payload: {
      ...buildEventPayload(fixture.taskId, eventId),
      payload: {
        receipt_ref: "changed.md",
        provider: "different-provider",
        receipt_summary: "this must not overwrite the original row",
        unsolicited_findings: ["changed"]
      },
      idempotency_key: "audit-key-2"
    }
  });
  assert.equal(duplicateResponse.statusCode, 200);
  assert.equal(duplicateResponse.json().result, "already_recorded");
  assert.equal(duplicateResponse.json().idempotent, true);
  assert.equal(duplicateResponse.json().event.payload.provider, "codex");
  assert.equal(duplicateResponse.json().event.idempotencyKey, "audit-key-1");

  const sameIdempotencyKeyResponse = await app.inject({
    method: "POST",
    url: "/api/event-journal/events",
    payload: {
      ...buildEventPayload(fixture.taskId, randomUUID()),
      idempotency_key: "audit-key-1",
      emitted_at: "2026-04-28T00:01:00.000Z"
    }
  });
  assert.equal(sameIdempotencyKeyResponse.statusCode, 201);

  const queryResponse = await app.inject({
    method: "GET",
    url: `/api/event-journal/events?task_id=${fixture.taskId}`
  });
  assert.equal(queryResponse.statusCode, 200);
  assert.equal(queryResponse.json().items.length, 2);

  await app.close();
});

test("EventJournal query optionally filters by project_id", async () => {
  const app = buildApp({
    projectStore: new PrismaProjectStore(prisma)
  });

  await resetDatabase();
  const fixture = await createTaskFixture();
  const secondFixture = await createTaskFixture();
  const firstEventId = randomUUID();
  const secondEventId = randomUUID();

  const firstResponse = await app.inject({
    method: "POST",
    url: "/api/event-journal/events",
    payload: buildEventPayload(fixture.taskId, firstEventId, "2026-04-28T00:00:00.000Z")
  });
  assert.equal(firstResponse.statusCode, 201, firstResponse.body);
  const secondResponse = await app.inject({
    method: "POST",
    url: "/api/event-journal/events",
    payload: buildEventPayload(secondFixture.taskId, secondEventId, "2026-04-28T00:01:00.000Z")
  });
  assert.equal(secondResponse.statusCode, 201, secondResponse.body);

  const unscopedResponse = await app.inject({
    method: "GET",
    url: "/api/event-journal/events?event_type=codex_receipt_ready"
  });
  assert.equal(unscopedResponse.statusCode, 200);
  assert.equal(unscopedResponse.json().pageInfo.count, 2);
  assert.deepEqual(
    new Set(unscopedResponse.json().items.map((item: { projectId: string }) => item.projectId)),
    new Set([fixture.projectId, secondFixture.projectId])
  );

  const firstProjectResponse = await app.inject({
    method: "GET",
    url: `/api/event-journal/events?project_id=${fixture.projectId}&event_type=codex_receipt_ready`
  });
  assert.equal(firstProjectResponse.statusCode, 200);
  assert.equal(firstProjectResponse.json().pageInfo.count, 1);
  assert.equal(firstProjectResponse.json().items[0].eventId, firstEventId);
  assert.equal(firstProjectResponse.json().items[0].projectId, fixture.projectId);

  const secondProjectResponse = await app.inject({
    method: "GET",
    url: `/api/event-journal/events?project_id=${secondFixture.projectId}&event_type=codex_receipt_ready`
  });
  assert.equal(secondProjectResponse.statusCode, 200);
  assert.equal(secondProjectResponse.json().pageInfo.count, 1);
  assert.equal(secondProjectResponse.json().items[0].eventId, secondEventId);
  assert.equal(secondProjectResponse.json().items[0].projectId, secondFixture.projectId);

  await app.close();
});

test("EventJournal query filters by task, type, emitted range, limit, and offset", async () => {
  const app = buildApp({
    projectStore: new PrismaProjectStore(prisma)
  });

  await resetDatabase();
  const fixture = await createTaskFixture();
  const secondFixture = await createTaskFixture();

  for (const emittedAt of [
    "2026-04-28T00:00:00.000Z",
    "2026-04-28T00:10:00.000Z",
    "2026-04-28T00:20:00.000Z"
  ]) {
    const response = await app.inject({
      method: "POST",
      url: "/api/event-journal/events",
      payload: buildEventPayload(fixture.taskId, randomUUID(), emittedAt)
    });
    assert.equal(response.statusCode, 201);
  }
  await app.inject({
    method: "POST",
    url: "/api/event-journal/events",
    payload: buildEventPayload(secondFixture.taskId, randomUUID(), "2026-04-28T00:15:00.000Z")
  });

  const filteredResponse = await app.inject({
    method: "GET",
    url:
      `/api/event-journal/events?task_id=${fixture.taskId}` +
      "&event_type=codex_receipt_ready&emitted_from=2026-04-28T00:05:00.000Z" +
      "&emitted_to=2026-04-28T00:25:00.000Z&limit=1&offset=0"
  });
  assert.equal(filteredResponse.statusCode, 200);
  assert.equal(filteredResponse.json().items.length, 1);
  assert.equal(filteredResponse.json().pageInfo.count, 2);
  assert.equal(filteredResponse.json().items[0].eventType, "codex_receipt_ready");
  assert.equal(filteredResponse.json().items[0].taskId, fixture.taskId);

  const badTypeQueryResponse = await app.inject({
    method: "GET",
    url: "/api/event-journal/events?event_type=unknown_event"
  });
  assert.equal(badTypeQueryResponse.statusCode, 400);
  assert.equal(badTypeQueryResponse.json().message, "event journal 查询参数不合法");

  await app.close();
});

test("EventJournal timeline projection is projection-only and survives task deletion", async () => {
  const app = buildApp({
    projectStore: new PrismaProjectStore(prisma)
  });

  await resetDatabase();
  const fixture = await createTaskFixture();
  const longSummary = "x".repeat(700);
  const eventId = randomUUID();

  const createResponse = await app.inject({
    method: "POST",
    url: "/api/event-journal/events",
    payload: {
      ...buildEventPayload(fixture.taskId, eventId),
      payload: {
        receipt_ref: "docs/.ccb/state/task.md",
        provider: "codex",
        receipt_summary: longSummary,
        unsolicited_findings: []
      }
    }
  });
  assert.equal(createResponse.statusCode, 201);

  const timelineResponse = await app.inject({
    method: "GET",
    url: `/api/tasks/${fixture.taskId}/timeline`
  });
  assert.equal(timelineResponse.statusCode, 200);
  const projection = timelineResponse.json().events.find((event: { kind: string }) => event.kind === "event_projection");
  assert.equal(projection.label, "Event projection: codex_receipt_ready");
  assert.equal(projection.at, "2026-04-28T00:00:00.000Z");
  assert.equal(projection.details.eventId, eventId);
  assert.equal(projection.details.projectionOnly, true);
  assert.equal(projection.details.payloadPreview.length <= 500, true);
  assert.equal(JSON.stringify(timelineResponse.json().events).includes("transition applied"), false);
  assert.equal(JSON.stringify(timelineResponse.json().events).includes("moved to review"), false);
  assert.equal(JSON.stringify(timelineResponse.json().events).includes("workflow state"), false);

  await prisma.task.delete({
    where: {
      id: fixture.taskId
    }
  });
  const queryAfterTaskDeleteResponse = await app.inject({
    method: "GET",
    url: `/api/event-journal/events?task_id=${fixture.taskId}`
  });
  assert.equal(queryAfterTaskDeleteResponse.statusCode, 200);
  assert.equal(queryAfterTaskDeleteResponse.json().items.length, 1);
  assert.equal(queryAfterTaskDeleteResponse.json().items[0].taskId, fixture.taskId);

  await app.close();
});

afterAll(async () => {
  await resetDatabase();
  await prisma.$disconnect();
});
