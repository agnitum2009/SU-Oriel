import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, test, vi } from "vitest";

import { buildApp } from "../../app.js";
import { prisma } from "../../db/prisma.js";

const createdProjectIds: string[] = [];
const createdTempPaths: string[] = [];

async function createTaskFixture(options: { status?: string } = {}) {
  const suffix = randomUUID();
  const project = await prisma.project.create({
    data: {
      name: `task-routes-${suffix}`,
      localPath: `/tmp/ccb-task-routes-${suffix}`
    }
  });
  createdProjectIds.push(project.id);

  const task = await prisma.task.create({
    data: {
      projectId: project.id,
      taskKey: `task-${suffix}`,
      title: "PATCH phase task",
      status: options.status ?? "reviewing",
      currentNode: "implementation",
      runtimeState: "running",
      priority: "medium",
      progress: 20
    }
  });

  return {
    projectId: project.id,
    taskId: task.id
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await prisma.anchorDispatchQueue.deleteMany();
  await prisma.eventJournal.deleteMany();
  await prisma.anchorAllocation.deleteMany();
  for (const projectId of createdProjectIds.splice(0)) {
    await prisma.project.deleteMany({
      where: {
        id: projectId
      }
    });
  }
  await Promise.all(createdTempPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function createRequirementWithEpicFixture() {
  const suffix = randomUUID();
  const project = await prisma.project.create({
    data: {
      name: `task-routes-cancel-${suffix}`,
      localPath: `/tmp/ccb-task-routes-cancel-${suffix}`
    }
  });
  createdProjectIds.push(project.id);
  const requirement = await prisma.requirement.create({
    data: {
      projectId: project.id,
      title: "Cancelable requirement",
      description: "Requirement for cancel route coverage.",
      status: "delivering"
    }
  });
  await prisma.task.create({
    data: {
      projectId: project.id,
      requirementId: requirement.id,
      taskKey: `direct-${suffix}`,
      title: "Direct reviewing subtask",
      status: "reviewing",
      currentNode: "dispatch",
      progress: 10
    }
  });

  return { projectId: project.id, requirementId: requirement.id };
}

async function createTaskMarkdownRouteFixture(options: { writeDocument?: boolean } = {}) {
  const suffix = randomUUID();
  const projectRoot = join(tmpdir(), `ccb-task-markdown-route-${suffix}`);
  createdTempPaths.push(projectRoot);
  await mkdir(join(projectRoot, "docs", "03_开发计划"), { recursive: true });
  const project = await prisma.project.create({
    data: {
      name: `task-markdown-route-${suffix}`,
      localPath: projectRoot
    }
  });
  createdProjectIds.push(project.id);
  const task = await prisma.task.create({
    data: {
      projectId: project.id,
      taskKey: `task-${suffix}`,
      title: "Markdown route task",
      status: "reviewing"
    }
  });

  if (options.writeDocument ?? true) {
    const documentPath = "docs/03_开发计划/route-开发任务.md";
    await writeFile(join(projectRoot, documentPath), "---\ndoc_type: dev_task\n---\n# Route body", "utf8");
    const document = await prisma.document.create({
      data: {
        projectId: project.id,
        taskKey: task.taskKey,
        path: documentPath,
        kind: "dev_task",
        title: "Route dev task",
        status: "reviewing",
        frontmatterJson: JSON.stringify({ doc_type: "dev_task", task_id: task.taskKey }),
        contentHash: randomUUID(),
        mtime: new Date()
      }
    });
    await prisma.task.update({
      where: {
        id: task.id
      },
      data: {
        primaryDocumentId: document.id
      }
    });
  }

  return {
    project,
    task
  };
}

test("PATCH /api/tasks/:taskId rejects deprecated phase writes with currentNode guidance", async () => {
  const app = buildApp();
  const { taskId } = await createTaskFixture();

  try {
    const response = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${taskId}`,
      payload: {
        phase: "blocked"
      }
    });

    assert.equal(response.statusCode, 400);
    const body = response.json();
    assert.equal(body.error, "phase field is deprecated, use currentNode");
    assert.match(JSON.stringify(body), /deprecated/);
    assert.match(JSON.stringify(body), /currentNode/);
  } finally {
    await app.close();
  }
});

test("PATCH /api/tasks/:taskId rejects plugin-canonical state fields", async () => {
  const app = buildApp();
  const { taskId } = await createTaskFixture({
    status: "reviewing"
  });

  try {
    const response = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${taskId}`,
      payload: {
        status: "done",
        progress: 42,
        blockedReason: "clear block"
      }
    });

    assert.equal(response.statusCode, 400);
    assert.equal(response.json().code, "plugin_canonical_dev_task");
    const task = await prisma.task.findUniqueOrThrow({ where: { id: taskId } });
    assert.equal(task.status, "reviewing");
    assert.equal(task.progress, 20);
  } finally {
    await app.close();
  }
});

test("PATCH /api/tasks/:taskId still updates console-internal priority", async () => {
  const app = buildApp();
  const { taskId } = await createTaskFixture({
    status: "reviewing"
  });

  try {
    const response = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${taskId}`,
      payload: {
        priority: "high"
      }
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().status, "reviewing");
    assert.equal(response.json().priority, "high");
    assert.equal(response.json().progress, 20);
    assert.equal(response.json().phase, "实施");
  } finally {
    await app.close();
  }
});

test("GET /api/projects/:projectId/tasks/:taskId/markdown returns body-only task markdown", async () => {
  const app = buildApp();
  const { project, task } = await createTaskMarkdownRouteFixture();

  try {
    const response = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/tasks/${task.id}/markdown`
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      path: "docs/03_开发计划/route-开发任务.md",
      content: "# Route body"
    });
  } finally {
    await app.close();
  }
});

test("GET /api/projects/:projectId/tasks/:taskId/markdown returns 404 across project or without readable document", async () => {
  const app = buildApp();
  const readable = await createTaskMarkdownRouteFixture();
  const missing = await createTaskMarkdownRouteFixture({ writeDocument: false });

  try {
    const crossProjectResponse = await app.inject({
      method: "GET",
      url: `/api/projects/${missing.project.id}/tasks/${readable.task.id}/markdown`
    });
    assert.equal(crossProjectResponse.statusCode, 404);
    assert.equal(crossProjectResponse.json().message, "任务文档不存在或尚未进入索引");

    const missingDocumentResponse = await app.inject({
      method: "GET",
      url: `/api/projects/${missing.project.id}/tasks/${missing.task.id}/markdown`
    });
    assert.equal(missingDocumentResponse.statusCode, 404);
    assert.equal(missingDocumentResponse.json().message, "任务文档不存在或尚未进入索引");
  } finally {
    await app.close();
  }
});

test("POST /api/epics/:epicId/cancel returns 410 after Epic retirement", async () => {
  const app = buildApp({ enableFileWatcher: false });
  const { requirementId } = await createRequirementWithEpicFixture();

  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/epics/retired-epic/cancel"
    });

    assert.equal(response.statusCode, 410);
    assert.match(response.json().message, /Epic 已取消/);
    const requirement = await prisma.requirement.findUniqueOrThrow({ where: { id: requirementId } });
    assert.equal(requirement.status, "delivering");
  } finally {
    await app.close();
  }
});

test("GET /api/requirements/:requirementId/epics returns 410 after Epic retirement", async () => {
  const app = buildApp({ enableFileWatcher: false });
  const { requirementId } = await createRequirementWithEpicFixture();

  try {
    const response = await app.inject({
      method: "GET",
      url: `/api/requirements/${requirementId}/epics`
    });

    assert.equal(response.statusCode, 410);
    assert.match(response.json().message, /Epic 已取消/);
  } finally {
    await app.close();
  }
});

test("POST /api/requirements/:requirementId/cancel enqueues anchor dispatch without writing status", async () => {
  const app = buildApp({ enableFileWatcher: false });
  const { projectId, requirementId } = await createRequirementWithEpicFixture();
  await prisma.anchorAllocation.create({
    data: {
      anchorId: "anchor_requirement_cancel",
      anchorPath: `/tmp/anchor-requirement-cancel-${requirementId}`,
      projectId,
      socketPath: "/tmp/anchor-requirement-cancel.sock",
      subjectType: "requirement",
      subjectId: requirementId,
      subjectKey: "Cancelable requirement",
      mode: "planning",
      state: "ready"
    }
  });

  try {
    const response = await app.inject({
      method: "POST",
      url: `/api/requirements/${requirementId}/cancel`
    });

    assert.equal(response.statusCode, 202);
    assert.equal(response.json().status, "queued");
    assert.equal(response.json().requirementId, requirementId);
    assert.equal(response.json().anchorId, "slot-1");
    const requirement = await prisma.requirement.findUniqueOrThrow({ where: { id: requirementId } });
    assert.equal(requirement.status, "delivering");
    const queued = await prisma.anchorDispatchQueue.findFirstOrThrow({
      where: { subjectType: "requirement", subjectId: requirementId }
    });
    assert.equal(queued.anchorId, "slot-1");
    assert.match(queued.command, /^\/ccb:su-cancel --payload /);
    assert.equal(await prisma.eventJournal.count({ where: { eventType: "slot_queued_request" } }), 1);
  } finally {
    await app.close();
  }
});

test("POST /api/requirements/:requirementId/defer enqueues anchor dispatch without writing status", async () => {
  const app = buildApp({ enableFileWatcher: false });
  const { projectId, requirementId } = await createRequirementWithEpicFixture();
  await prisma.anchorAllocation.create({
    data: {
      anchorId: "anchor_requirement_defer",
      anchorPath: `/tmp/anchor-requirement-defer-${requirementId}`,
      projectId,
      socketPath: "/tmp/anchor-requirement-defer.sock",
      subjectType: "requirement",
      subjectId: requirementId,
      subjectKey: "Deferrable requirement",
      mode: "planning",
      state: "ready"
    }
  });

  try {
    const response = await app.inject({
      method: "POST",
      url: `/api/requirements/${requirementId}/defer`
    });

    assert.equal(response.statusCode, 202);
    assert.equal(response.json().status, "queued");
    assert.equal(response.json().requirementId, requirementId);
    assert.equal(response.json().anchorId, "slot-1");
    const requirement = await prisma.requirement.findUniqueOrThrow({ where: { id: requirementId } });
    assert.equal(requirement.status, "delivering");
    const queued = await prisma.anchorDispatchQueue.findFirstOrThrow({
      where: { subjectType: "requirement", subjectId: requirementId }
    });
    assert.equal(queued.anchorId, "slot-1");
    assert.match(queued.command, /^\/ccb:su-defer --payload /);
    assert.equal(await prisma.eventJournal.count({ where: { eventType: "slot_queued_request" } }), 1);
  } finally {
    await app.close();
  }
});
