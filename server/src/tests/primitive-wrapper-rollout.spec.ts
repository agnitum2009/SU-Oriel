import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, test, vi } from "vitest";

import { buildApp } from "../app.js";
import { prisma } from "../db/prisma.js";
import { createRequirement, generateTaskFromRequirement, scanProject } from "../indexer/project-indexer.js";
import { submitEventJournal } from "../modules/events/event-journal.service.js";
import { primitiveExecutor } from "../modules/primitive/primitive-wrapper.js";

const createdProjectIds = new Set<string>();
const createdEventIds = new Set<string>();
const createdProjectRoots = new Set<string>();

async function cleanupCreatedProjects(): Promise<void> {
  const projectIds = [...createdProjectIds];
  if (projectIds.length === 0) {
    return;
  }
  await prisma.project.deleteMany({
    where: {
      id: {
        in: projectIds
      }
    }
  });
}

async function cleanupCreatedProjectRoots(): Promise<void> {
  for (const projectRoot of createdProjectRoots) {
    await rm(projectRoot, { recursive: true, force: true });
  }
  createdProjectRoots.clear();
}

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupCreatedProjects();
  await cleanupCreatedProjectRoots();
  createdEventIds.clear();
  createdProjectIds.clear();
});

async function createTaskFixture(
  options: { currentNode?: string; stateFile?: boolean } = {}
): Promise<{ projectId: string; taskId: string; taskKey: string; projectRoot: string; statePath: string }> {
  const projectRoot = await mkdtemp(join(tmpdir(), "ccb-primitive-wrapper-"));
  createdProjectRoots.add(projectRoot);
  const taskKey = `task-${randomUUID()}`;
  const statePath = join(projectRoot, "docs", "03_开发计划", `${taskKey}-开发任务.md`);

  if (options.stateFile ?? false) {
    await mkdir(join(projectRoot, "docs", "03_开发计划"), { recursive: true });
    await writeFile(
      statePath,
      [
        "---",
        "doc_type: dev_task",
        `task_id: ${taskKey}`,
        `title: ${taskKey}`,
        `current_node: ${options.currentNode ?? "implementation"}`,
        "node_substate: executing",
        "last_transition_id: dispatch__on_codex_pickup__to__implementation",
        "revision: 4",
        "status: reviewing",
        "priority: high",
        `batch_id: wrapper-${randomUUID()}`,
        "---",
        "",
        "# Body",
        ""
      ].join("\n"),
      "utf8"
    );
  }

  const project = await prisma.project.create({
    data: {
      name: `Primitive Wrapper Project ${randomUUID()}`,
      localPath: projectRoot,
      updatedAt: new Date()
    }
  });
  createdProjectIds.add(project.id);

  const task = await prisma.task.create({
    data: {
      projectId: project.id,
      taskKey,
      title: "Primitive wrapper task",
      status: "reviewing",
      currentNode: options.currentNode ?? "implementation",
      nodeSubstate: "executing",
      runtimeState: "waiting_codex",
      lastTransitionId: "dispatch__on_codex_pickup__to__implementation",
      updatedAt: new Date()
    }
  });
  if (options.stateFile ?? false) {
    await prisma.document.create({
      data: {
        projectId: project.id,
        taskKey,
        path: `docs/03_开发计划/${taskKey}-开发任务.md`,
        kind: "dev_task",
        title: taskKey,
        status: "reviewing",
        frontmatterJson: JSON.stringify({ doc_type: "dev_task", task_id: taskKey, current_node: options.currentNode ?? "implementation", revision: 4 }),
        contentHash: randomUUID(),
        mtime: new Date()
      }
    });
  }

  return {
    projectId: project.id,
    taskId: task.id,
    taskKey,
    projectRoot,
    statePath
  };
}

async function createScannableProjectFixture(): Promise<{
  projectId: string;
  projectRoot: string;
  taskPath: string;
}> {
  const projectRoot = await mkdtemp(join(tmpdir(), "ccb-primitive-scan-"));
  createdProjectRoots.add(projectRoot);
  const ccbRoot = join(projectRoot, "docs", ".ccb");
  const taskPath = join(projectRoot, "docs", "03_开发计划", "scan-task-开发任务.md");

  await mkdir(join(projectRoot, "docs", "03_开发计划"), { recursive: true });
  await mkdir(join(ccbRoot, "decisions"), { recursive: true });
  await writeFile(
    taskPath,
    [
      "---",
      "doc_type: dev_task",
      "task_id: scan-task",
      "title: Scan Task",
      "status: reviewing",
      "current_node: dispatch",
      "node_substate: awaiting_codex_pickup",
      "priority: high",
      "requirement_id: req-scan-task",
      "section_id: pr1-scan-task",
      "order: 1",
      "implementation_owner: ccb_codex",
      "dependencies: []",
      "source_breakdown_draft: docs/.ccb/drafts/breakdown/req-scan-task.json",
      `source_draft_hash: ${"a".repeat(64)}`,
      "created_at: 2026-05-29T10:00:00.000Z",
      "---",
      "",
      "# Scan Task",
      "",
      "- Keep scan projection covered by primitive wrapper tests.",
      ""
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    join(ccbRoot, "decisions", "ADR-primitive-wrapper.md"),
    [
      "---",
      "task_id: adr-not-task",
      "title: ADR Primitive Wrapper",
      "status: accepted",
      "kind: decision",
      "---",
      "",
      "# ADR Primitive Wrapper",
      ""
    ].join("\n"),
    "utf8"
  );

  const project = await prisma.project.create({
    data: {
      name: `Primitive Scan Project ${randomUUID()}`,
      localPath: projectRoot,
      updatedAt: new Date()
    }
  });
  createdProjectIds.add(project.id);

  return {
    projectId: project.id,
    projectRoot,
    taskPath
  };
}

async function createJournaledEvent(taskId: string): Promise<string> {
  const eventId = randomUUID();
  await submitEventJournal({
    event_id: eventId,
    event_type: "codex_receipt_ready",
    task_id: taskId,
    payload: {
      receipt_ref: "docs/.ccb/state/task.md",
      provider: "codex",
      receipt_summary: "实现已完成，等待 review",
      unsolicited_findings: []
    },
    emitted_at: "2026-04-28T00:00:00.000Z",
    source_actor: "codex",
    source_component: "primitive_executor"
  });
  createdEventIds.add(eventId);
  return eventId;
}

test("append_event_journal uses primitive wrapper for EventJournal create", async () => {
  const fixture = await createTaskFixture();
  const runSpy = vi.spyOn(primitiveExecutor, "run");

  const result = await submitEventJournal({
    event_id: randomUUID(),
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
    idempotency_key: "append-event-journal-key"
  });
  createdEventIds.add(result.event.eventId);

  assert.equal(result.result, "created");
  assert.ok(runSpy.mock.calls.some(([input]) => input.primitive === "append_event_journal"));
});

test("create_review_intent uses primitive wrapper for ReviewIntent create", async () => {
  const app = buildApp({ enableFileWatcher: false });
  const fixture = await createTaskFixture();
  const runSpy = vi.spyOn(primitiveExecutor, "run");

  try {
    const response = await app.inject({
      method: "POST",
      url: `/api/tasks/${fixture.taskId}/review-intents`,
      payload: {
        intentType: "request_replan",
        payload: "补充 wrapper rollout 记录"
      }
    });

    assert.equal(response.statusCode, 201);
    assert.equal(response.json().status, "pending");
    assert.ok(runSpy.mock.calls.some(([input]) => input.primitive === "create_review_intent"));
  } finally {
    await app.close();
  }
});

test("consume_review_intent uses primitive wrapper for ReviewIntent update", async () => {
  const app = buildApp({ enableFileWatcher: false });
  const fixture = await createTaskFixture();
  const createResponse = await app.inject({
    method: "POST",
    url: `/api/tasks/${fixture.taskId}/review-intents`,
    payload: {
      intentType: "request_escalate",
      payload: "消费 wrapper rollout 记录"
    }
  });
  assert.equal(createResponse.statusCode, 201);
  const runSpy = vi.spyOn(primitiveExecutor, "run");

  try {
    const response = await app.inject({
      method: "POST",
      url: `/api/review-intents/${createResponse.json().id as string}/consume`,
      payload: {
        consumer: "su-review",
        result: "considered"
      }
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().result, "consumed");
    assert.ok(runSpy.mock.calls.some(([input]) => input.primitive === "consume_review_intent"));
  } finally {
    await app.close();
  }
});

test("cancel_review_intent uses primitive wrapper for ReviewIntent update", async () => {
  const app = buildApp({ enableFileWatcher: false });
  const fixture = await createTaskFixture();
  const createResponse = await app.inject({
    method: "POST",
    url: `/api/tasks/${fixture.taskId}/review-intents`,
    payload: {
      intentType: "mark_review_pass",
      payload: "取消 wrapper rollout 记录"
    }
  });
  assert.equal(createResponse.statusCode, 201);
  const runSpy = vi.spyOn(primitiveExecutor, "run");

  try {
    const response = await app.inject({
      method: "DELETE",
      url: `/api/review-intents/${createResponse.json().id as string}`
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().status, "cancelled");
    assert.ok(runSpy.mock.calls.some(([input]) => input.primitive === "cancel_review_intent"));
  } finally {
    await app.close();
  }
});

test("update_task_metadata uses primitive wrapper for supported Task PATCH fields", async () => {
  const app = buildApp({ enableFileWatcher: false });
  const fixture = await createTaskFixture();
  const runSpy = vi.spyOn(primitiveExecutor, "run");

  try {
    const response = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${fixture.taskId}`,
      payload: {
        priority: "urgent"
      }
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().priority, "urgent");
    const updatedTask = await prisma.task.findUniqueOrThrow({
      where: {
        id: fixture.taskId
      },
      select: {
        priority: true
      }
    });

    assert.equal(updatedTask.priority, "urgent");
    assert.ok(runSpy.mock.calls.some(([input]) => input.primitive === "update_task_metadata"));
  } finally {
    await app.close();
  }
});

test("apply_task_projection_diff uses primitive wrapper for scanned Task upsert", async () => {
  const fixture = await createScannableProjectFixture();
  const runSpy = vi.spyOn(primitiveExecutor, "run");

  const result = await scanProject(prisma, fixture.projectId);
  const task = await prisma.task.findUniqueOrThrow({
    where: {
      projectId_taskKey: {
        projectId: fixture.projectId,
        taskKey: "scan-task"
      }
    }
  });

  assert.equal(result.taskCount, 1);
  assert.equal(task.title, "Scan Task");
  assert.ok(
    runSpy.mock.calls.some(
      ([input]) => input.primitive === "apply_task_projection_diff" && input.mutationType === "prisma.task.upsert"
    )
  );
});

test("re-scan reflects dev_task current_node/status change (no idempotency-cache freeze)", async () => {
  const fixture = await createScannableProjectFixture();

  await scanProject(prisma, fixture.projectId);
  const before = await prisma.task.findUniqueOrThrow({
    where: { projectId_taskKey: { projectId: fixture.projectId, taskKey: "scan-task" } }
  });
  assert.equal(before.currentNode, "dispatch");
  assert.equal(before.status, "reviewing");

  // 归档同一 dev_task：current_node/status 变更后重写文件
  await writeFile(
    fixture.taskPath,
    [
      "---",
      "doc_type: dev_task",
      "task_id: scan-task",
      "title: Scan Task",
      "status: done",
      "current_node: archive",
      "node_substate: archived",
      "review_status: passed",
      "priority: high",
      "requirement_id: req-scan-task",
      "section_id: pr1-scan-task",
      "order: 1",
      "implementation_owner: ccb_codex",
      "dependencies: []",
      "source_breakdown_draft: docs/.ccb/drafts/breakdown/req-scan-task.json",
      `source_draft_hash: ${"a".repeat(64)}`,
      "created_at: 2026-05-29T10:00:00.000Z",
      "---",
      "",
      "# Scan Task",
      "",
      "- Archived; re-scan must update the Task projection.",
      ""
    ].join("\n"),
    "utf8"
  );

  await scanProject(prisma, fixture.projectId);
  const after = await prisma.task.findUniqueOrThrow({
    where: { projectId_taskKey: { projectId: fixture.projectId, taskKey: "scan-task" } }
  });

  // 回归保护：apply_task_projection_diff 的 idempotencyKey 含投影内容，
  // 内容变更必须重投影，而非被 primitiveAudit 持久缓存冻结在首扫态。
  assert.equal(after.currentNode, "archive");
  assert.equal(after.status, "done");
  assert.equal(after.reviewStatus, "passed");
});

test("cleanup_stale_task_projections reports stale Task projection as orphan without deleting", async () => {
  const fixture = await createScannableProjectFixture();
  const staleTask = await prisma.task.create({
    data: {
      projectId: fixture.projectId,
      taskKey: "stale-task",
      title: "Stale Task",
      status: "reviewing"
    }
  });
  const runSpy = vi.spyOn(primitiveExecutor, "run");

  const result = await scanProject(prisma, fixture.projectId);
  const orphanTask = await prisma.task.findUnique({
    where: {
      id: staleTask.id
    }
  });
  const reconcileJob = await prisma.syncJob.findFirstOrThrow({
    where: { projectId: fixture.projectId, jobType: "reconcile" },
    orderBy: { createdAt: "desc" }
  });

  assert.equal(result.taskCount, 1);
  assert.equal(orphanTask?.id, staleTask.id);
  assert.match(reconcileJob.errorMessage ?? "", /stale_task_projection_orphan/);
  assert.ok(
    runSpy.mock.calls.some(
      ([input]) => input.primitive === "cleanup_stale_task_projections" && input.mutationType === "reconcile.orphan_report"
    )
  );
});

test.skip("SP-B23: materialize_requirement_task was retired by SP-B15 Requirement planning flow", async () => {
  const fixture = await createScannableProjectFixture();
  const requirement = await prisma.requirement.create({
    data: {
      projectId: fixture.projectId,
      title: "Materialize requirement",
      description: "Create a task from a requirement",
      status: "draft",
      outputMode: "requirement_only",
      verbatimSource: "Create a task from a requirement"
    }
  });
  const runSpy = vi.spyOn(primitiveExecutor, "run");

  const result = await generateTaskFromRequirement(prisma, fixture.projectId, requirement.id, {
    taskKey: "materialized-requirement-task",
    title: "Materialized Requirement Task",
    summary: "Generated through requirement flow"
  });
  const updatedRequirement = await prisma.requirement.findUniqueOrThrow({
    where: {
      id: requirement.id
    }
  });

  assert.equal(result.generatedTaskId, result.task.id);
  assert.equal(result.task.currentNode, "requirement_analysis");
  const materialization = await prisma.requirementMaterialization.findUniqueOrThrow({
    where: {
      requirementId: requirement.id
    }
  });
  assert.equal(materialization.taskId, result.task.id);
  assert.ok(
    runSpy.mock.calls.some(
      ([input]) => input.primitive === "materialize_requirement_task" && input.mutationType === "prisma.task.create"
    )
  );
  assert.ok(
    runSpy.mock.calls.some(
      ([input]) => input.primitive === "materialize_requirement_carrier" && input.mutationType === "prisma.requirementMaterialization.create"
    )
  );
});

test("apply_requirement_diff uses primitive wrapper for Requirement create", async () => {
  const fixture = await createScannableProjectFixture();
  const runSpy = vi.spyOn(primitiveExecutor, "run");

  const result = await createRequirement(prisma, fixture.projectId, {
    title: "Wrapped Requirement",
    description: "Keep requirement-only creation inside primitive wrapper",
    outputMode: "requirement_only",
    verbatimSource: "Original requirement text"
  });
  const requirement = await prisma.requirement.findUniqueOrThrow({
    where: {
      id: result.requirementId
    }
  });
  const requirementCalls = runSpy.mock.calls.filter(([input]) => input.primitive === "apply_requirement_diff");

  assert.equal(result.generatedTaskId, null);
  assert.equal(requirement.status, "drafting");
  assert.ok(requirementCalls.some(([input]) => input.mutationType === "prisma.requirement.create"));
  assert.equal(requirementCalls.some(([input]) => input.mutationType === "prisma.requirement.update"), false);
});
