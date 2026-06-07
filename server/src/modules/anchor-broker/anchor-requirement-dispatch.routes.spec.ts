import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, test } from "vitest";

import { buildApp } from "../../app.js";
import { prisma } from "../../db/prisma.js";

function parseQueuedPayload(command: string): { command: string; payload: Record<string, unknown> } {
  const matched = command.match(/^\/ccb:([a-z][a-z0-9-]*) --payload (.+)$/);
  assert.ok(matched, `expected structured dispatch command, got: ${command}`);
  return {
    command: matched[1],
    payload: JSON.parse(matched[2]) as Record<string, unknown>
  };
}

async function resetFixtures(): Promise<void> {
  await prisma.anchorDispatchQueue.deleteMany();
  await prisma.eventJournal.deleteMany();
  await prisma.anchorAllocation.deleteMany();
  await prisma.task.deleteMany();
  await prisma.requirement.deleteMany();
  await prisma.project.deleteMany();
}

async function createRequirementFixture() {
  const suffix = randomUUID();
  const project = await prisma.project.create({
    data: {
      name: `requirement-anchor-${suffix}`,
      localPath: join(tmpdir(), `ccb-requirement-anchor-${suffix}`)
    }
  });
  const requirement = await prisma.requirement.create({
    data: {
      projectId: project.id,
      title: "Requirement planning",
      description: "Plan this requirement",
      status: "drafting",
      currentPlanningStep: "analysis",
      planningRuntimeState: "idle"
    }
  });
  return { project, requirement };
}

async function createSubtaskFixture() {
  const suffix = randomUUID();
  const project = await prisma.project.create({
    data: {
      name: `subtask-anchor-${suffix}`,
      localPath: join(tmpdir(), `ccb-subtask-anchor-${suffix}`)
    }
  });
  const requirement = await prisma.requirement.create({
    data: {
      projectId: project.id,
      title: "Subtask parent requirement",
      description: "Parent requirement for slot routing",
      status: "delivering"
    }
  });
  const task = await prisma.task.create({
    data: {
      projectId: project.id,
      requirementId: requirement.id,
      taskKey: `subtask-${suffix}`,
      title: "Executable SubTask",
      status: "reviewing",
      currentNode: "dispatch",
      runtimeState: "running"
    }
  });
  return { project, requirement, task };
}

beforeEach(async () => {
  await resetFixtures();
});

test("POST /api/projects/:projectId/requirements/:requirementId/planning-anchor/start binds a Requirement slot without legacy runtime", async () => {
  const { project, requirement } = await createRequirementFixture();
  const app = buildApp({ enableFileWatcher: false });

  try {
    const response = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/requirements/${requirement.id}/planning-anchor/start`,
      payload: {}
    });

    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.status, "bound");
    assert.equal(body.slotId, "slot-1");
    assert.equal(body.anchorId, "slot-1");
    assert.equal(body.socketPath, null);
    assert.equal(body.subjectType, "requirement");
    assert.equal(body.subjectId, requirement.id);
    assert.equal(body.mode, "planning");
    assert.equal(await prisma.anchorAllocation.count({ where: { subjectType: "requirement", subjectId: requirement.id } }), 0);
    assert.equal(await prisma.slotBinding.count({ where: { projectId: project.id, requirementId: requirement.id, slotId: "slot-1" } }), 1);

    const updatedRequirement = await prisma.requirement.findUniqueOrThrow({ where: { id: requirement.id } });
    // D1 keeps Console-side slot binding as a runtime-only action: canonical
    // requirement status is promoted by plugin su-flow/analysis, not by this
    // endpoint. D2 Console enqueue promotion may change this contract later.
    assert.equal(updatedRequirement.status, "drafting");
    assert.equal(updatedRequirement.planningAnchorId, "slot-1");
    assert.equal(updatedRequirement.planningRuntimeState, "running");
    const config = await readFile(join(project.localPath, ".ccb", "ccb.config"), "utf8");
    assert.match(config, /"slot-1: Requirement planning"/);
  } finally {
    await app.close();
  }
});

test("POST /api/projects/:projectId/requirements/:requirementId/anchor-dispatch enqueues a command for the bound slot", async () => {
  const { project, requirement } = await createRequirementFixture();
  const app = buildApp({ enableFileWatcher: false });

  try {
    const response = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/requirements/${requirement.id}/anchor-dispatch`,
      payload: {
        command: "su-flow",
        payload: {
          step: "analysis",
          policy_profile: "interactive-single"
        }
      }
    });

    assert.equal(response.statusCode, 202);
    const body = response.json();
    assert.match(body.jobId, /^job_[a-f0-9]{12}$/);
    assert.equal(body.anchorId, "slot-1");
    assert.equal(body.slotId, "slot-1");
    assert.equal(body.subjectId, requirement.id);
    assert.equal(body.requirementId, requirement.id);
    assert.equal(body.status, "queued");
    assert.equal(typeof body.queuedAt, "string");

    const queued = await prisma.anchorDispatchQueue.findUniqueOrThrow({ where: { jobId: body.jobId } });
    assert.equal(queued.anchorId, "slot-1");
    assert.equal(queued.subjectType, "requirement");
    assert.equal(queued.subjectId, requirement.id);
    assert.equal(queued.status, "pending");
    const structured = parseQueuedPayload(queued.command);
    assert.equal(structured.command, "su-flow");
    assert.deepEqual(structured.payload, {
      language: "中文",
      policy_profile: "interactive-single",
      project_id: project.id,
      requirement_id: requirement.id,
      step: "analysis",
      subject: "requirement"
    });

    const event = await prisma.eventJournal.findFirstOrThrow({
      where: {
        eventType: "slot_queued_request",
        subjectType: "requirement",
        subjectId: requirement.id
      }
    });
    const payload = JSON.parse(event.payloadJson) as { jobId: string; command: string; dispatchPayload?: unknown };
    assert.equal(payload.jobId, body.jobId);
    assert.equal(payload.command, queued.command);
    assert.deepEqual(payload.dispatchPayload, structured.payload);
  } finally {
    await app.close();
  }
});

test("POST /api/projects/:projectId/requirements/:requirementId/anchor-dispatch claims a slot when no planning anchor exists", async () => {
  const { project, requirement } = await createRequirementFixture();
  const app = buildApp({ enableFileWatcher: false });

  try {
    const response = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/requirements/${requirement.id}/anchor-dispatch`,
      payload: {
        command: "su-flow",
        payload: {
          step: "analysis"
        }
      }
    });

    assert.equal(response.statusCode, 202);
    assert.equal(response.json().slotId, "slot-1");
    assert.equal(await prisma.slotBinding.count({ where: { projectId: project.id, requirementId: requirement.id, slotId: "slot-1" } }), 1);
  } finally {
    await app.close();
  }
});

test("POST /api/projects/:projectId/requirements/:requirementId/anchor-dispatch rejects new work while su-cancel is active", async () => {
  const { project, requirement } = await createRequirementFixture();
  await prisma.anchorDispatchQueue.create({
    data: {
      projectId: project.id,
      jobId: `job-cancel-${randomUUID()}`,
      anchorId: "slot-1",
      subjectType: "requirement",
      subjectId: requirement.id,
      command: "su-cancel",
      status: "pending"
    }
  });
  const app = buildApp({ enableFileWatcher: false });

  try {
    const response = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/requirements/${requirement.id}/anchor-dispatch`,
      payload: {
        command: "su-flow",
        payload: {
          step: "analysis"
        }
      }
    });

    assert.equal(response.statusCode, 409, response.body);
    assert.equal(response.json().code, "cancel_in_progress");
    assert.equal(await prisma.anchorDispatchQueue.count(), 1);
  } finally {
    await app.close();
  }
});

test("POST /api/projects/:projectId/requirements/:requirementId/anchor-dispatch blocks cancelled requirements except cancel/reactivate", async () => {
  const first = await createRequirementFixture();
  const second = await createRequirementFixture();
  await prisma.requirement.updateMany({
    where: {
      id: {
        in: [first.requirement.id, second.requirement.id]
      }
    },
    data: {
      status: "cancelled"
    }
  });
  await prisma.anchorDispatchQueue.createMany({
    data: [
      {
        projectId: first.project.id,
        jobId: `job-stale-cancel-${randomUUID()}`,
        anchorId: "slot-1",
        subjectType: "requirement",
        subjectId: first.requirement.id,
        command: "/ccb:su-cancel --payload {}",
        status: "submitted"
      },
      {
        projectId: second.project.id,
        jobId: `job-stale-reactivate-${randomUUID()}`,
        anchorId: "slot-2",
        subjectType: "requirement",
        subjectId: second.requirement.id,
        command: "/ccb:su-cancel --payload {}",
        status: "submitted"
      }
    ]
  });
  const app = buildApp({ enableFileWatcher: false });

  try {
    const blocked = await app.inject({
      method: "POST",
      url: `/api/projects/${first.project.id}/requirements/${first.requirement.id}/anchor-dispatch`,
      payload: {
        command: "su-flow",
        payload: {
          step: "analysis"
        }
      }
    });
    assert.equal(blocked.statusCode, 409, blocked.body);
    assert.equal(blocked.json().code, "requirement_cancelled");

    const cancelAllowed = await app.inject({
      method: "POST",
      url: `/api/projects/${first.project.id}/requirements/${first.requirement.id}/anchor-dispatch`,
      payload: {
        command: "su-cancel",
        payload: {}
      }
    });
    assert.equal(cancelAllowed.statusCode, 202, cancelAllowed.body);

    const reactivateAllowed = await app.inject({
      method: "POST",
      url: `/api/projects/${second.project.id}/requirements/${second.requirement.id}/anchor-dispatch`,
      payload: {
        command: "su-reactivate",
        payload: {}
      }
    });
    assert.equal(reactivateAllowed.statusCode, 202, reactivateAllowed.body);
  } finally {
    await app.close();
  }
});

test("POST /api/projects/:projectId/requirements/:requirementId/anchor-dispatch supersedes same-scope pending work when su-cancel is queued", async () => {
  const { project, requirement } = await createRequirementFixture();
  const task = await prisma.task.create({
    data: {
      projectId: project.id,
      requirementId: requirement.id,
      taskKey: `subtask-${randomUUID()}`,
      title: "Pending child task",
      status: "reviewing",
      currentNode: "dispatch"
    }
  });
  const otherRequirement = await prisma.requirement.create({
    data: {
      projectId: project.id,
      title: "Other requirement",
      description: "Other scope",
      status: "planning"
    }
  });
  await prisma.anchorDispatchQueue.createMany({
    data: [
      {
        projectId: project.id,
        jobId: "job-requirement-pending",
        anchorId: "slot-1",
        subjectType: "requirement",
        subjectId: requirement.id,
        command: "/ccb:su-flow --payload {}",
        status: "pending"
      },
      {
        projectId: project.id,
        jobId: "job-subtask-pending",
        anchorId: "slot-1",
        subjectType: "subtask",
        subjectId: task.id,
        command: "/ccb:su-dispatch --payload {}",
        status: "pending"
      },
      {
        projectId: project.id,
        jobId: "job-submitted",
        anchorId: "slot-1",
        subjectType: "requirement",
        subjectId: requirement.id,
        command: "/ccb:su-flow --payload {}",
        status: "submitted"
      },
      {
        projectId: project.id,
        jobId: "job-other-scope",
        anchorId: "slot-2",
        subjectType: "requirement",
        subjectId: otherRequirement.id,
        command: "/ccb:su-flow --payload {}",
        status: "pending"
      }
    ]
  });
  const app = buildApp({ enableFileWatcher: false });

  try {
    const response = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/requirements/${requirement.id}/anchor-dispatch`,
      payload: {
        command: "su-cancel",
        payload: {
          reason: "not needed"
        }
      }
    });

    assert.equal(response.statusCode, 202, response.body);
    const rows = await prisma.anchorDispatchQueue.findMany({
      where: {
        jobId: {
          in: ["job-requirement-pending", "job-subtask-pending", "job-submitted", "job-other-scope", response.json().jobId]
        }
      }
    });
    const byJobId = new Map(rows.map((row) => [row.jobId, row]));
    assert.equal(byJobId.get("job-requirement-pending")?.status, "superseded");
    assert.equal(byJobId.get("job-subtask-pending")?.status, "superseded");
    assert.equal(byJobId.get("job-submitted")?.status, "submitted");
    assert.equal(byJobId.get("job-other-scope")?.status, "pending");
    assert.equal(byJobId.get(response.json().jobId)?.status, "pending");
  } finally {
    await app.close();
  }
});

test("POST /api/projects/:projectId/requirements/:requirementId/anchor-dispatch ignores paused legacy planning anchors and uses the sticky slot", async () => {
  const { project, requirement } = await createRequirementFixture();
  await prisma.anchorAllocation.create({
    data: {
      anchorId: "anchor_requirement_dispatch_paused",
      anchorPath: join(project.localPath, `requirement-${requirement.id}`),
      projectId: project.id,
      socketPath: "/tmp/requirement-dispatch-paused.sock",
      runtimePaused: true,
      subjectType: "requirement",
      subjectId: requirement.id,
      subjectKey: requirement.title,
      mode: "planning",
      state: "ready"
    }
  });
  const app = buildApp({ enableFileWatcher: false });

  try {
    const response = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/requirements/${requirement.id}/anchor-dispatch`,
      payload: {
        command: "su-flow",
        payload: {
          step: "analysis"
        }
      }
    });

    assert.equal(response.statusCode, 202);
    assert.equal(response.json().slotId, "slot-1");
    assert.equal(await prisma.anchorDispatchQueue.count({ where: { anchorId: "slot-1" } }), 1);
    assert.equal(await prisma.eventJournal.count({ where: { eventType: "slot_queued_request" } }), 1);
  } finally {
    await app.close();
  }
});

test("POST /api/tasks/:taskId/anchor-dispatch enqueues a command for the parent requirement slot", async () => {
  const { task } = await createSubtaskFixture();
  const app = buildApp({ enableFileWatcher: false });

  try {
    const response = await app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/anchor-dispatch`,
      payload: {
        command: "su-dispatch",
        payload: {}
      }
    });

    assert.equal(response.statusCode, 202);
    const body = response.json();
    assert.match(body.jobId, /^job_[a-f0-9]{12}$/);
    assert.equal(body.anchorId, "slot-1");
    assert.equal(body.slotId, "slot-1");
    assert.equal(body.subjectId, task.id);
    assert.equal(body.taskId, task.id);
    assert.equal(body.status, "queued");
    assert.equal(typeof body.queuedAt, "string");

    const queued = await prisma.anchorDispatchQueue.findUniqueOrThrow({ where: { jobId: body.jobId } });
    assert.equal(queued.anchorId, "slot-1");
    assert.equal(queued.subjectType, "subtask");
    assert.equal(queued.subjectId, task.id);
    assert.equal(queued.status, "pending");
    const structured = parseQueuedPayload(queued.command);
    assert.equal(structured.command, "su-dispatch");
    assert.deepEqual(structured.payload, {
      language: "中文",
      subject: "subtask",
      task_id: task.id,
      task_key: task.taskKey
    });

    const event = await prisma.eventJournal.findFirstOrThrow({
      where: {
        eventType: "slot_queued_request",
        subjectType: "subtask",
        subjectId: task.id
      }
    });
    const payload = JSON.parse(event.payloadJson) as { jobId: string; command: string; dispatchPayload?: unknown };
    assert.equal(payload.jobId, body.jobId);
    assert.equal(payload.command, queued.command);
    assert.deepEqual(payload.dispatchPayload, structured.payload);
  } finally {
    await app.close();
  }
});

test("POST /api/tasks/:taskId/anchor-dispatch applies dispatch readiness only to su-dispatch", async () => {
  const { task } = await createSubtaskFixture();
  await prisma.task.update({
    where: {
      id: task.id
    },
    data: {
      currentNode: "review",
      status: "reviewing"
    }
  });
  const app = buildApp({ enableFileWatcher: false });

  try {
    const blocked = await app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/anchor-dispatch`,
      payload: {
        command: "su-dispatch",
        payload: {}
      }
    });
    assert.equal(blocked.statusCode, 409);
    assert.equal(blocked.json().code, "subtask_dispatch_ineligible");
    assert.equal(blocked.json().message, "子任务不在 dispatch 节点");

    const allowedReviewCommand = await app.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/anchor-dispatch`,
      payload: {
        command: "su-review",
        payload: {}
      }
    });
    assert.equal(allowedReviewCommand.statusCode, 202, allowedReviewCommand.body);
  } finally {
    await app.close();
  }
});

test("GET subtask batch candidates uses dispatch readiness fail-closed gate", async () => {
  const { project, requirement, task } = await createSubtaskFixture();
  const doneTask = await prisma.task.create({
    data: {
      projectId: project.id,
      requirementId: requirement.id,
      taskKey: `subtask-done-${randomUUID()}`,
      title: "Done SubTask",
      status: "done",
      currentNode: "archive",
      runtimeState: "completed"
    }
  });
  const reviewTask = await prisma.task.create({
    data: {
      projectId: project.id,
      requirementId: requirement.id,
      taskKey: `subtask-review-${randomUUID()}`,
      title: "Review SubTask",
      status: "reviewing",
      currentNode: "review",
      runtimeState: "running"
    }
  });
  const app = buildApp({ enableFileWatcher: false });

  try {
    const response = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/requirements/${requirement.id}/subtasks/batch-candidates`
    });

    assert.equal(response.statusCode, 200, response.body);
    const candidates = response.json().candidates as Array<{ taskId: string; eligible: boolean; ineligibleReason: string | null }>;
    const byTaskId = new Map(candidates.map((candidate) => [candidate.taskId, candidate]));
    assert.equal(byTaskId.get(task.id)?.eligible, true);
    assert.equal(byTaskId.get(task.id)?.ineligibleReason, null);
    assert.equal(byTaskId.get(doneTask.id)?.eligible, false);
    assert.equal(byTaskId.get(doneTask.id)?.ineligibleReason, "子任务已结束");
    assert.equal(byTaskId.get(reviewTask.id)?.eligible, false);
    assert.equal(byTaskId.get(reviewTask.id)?.ineligibleReason, "子任务不在 dispatch 节点");
  } finally {
    await app.close();
  }
});

test("POST /api/anchors/:anchorId/runtime/resume is deprecated for Requirement planning anchors", async () => {
  const { project, requirement } = await createRequirementFixture();
  const anchorPath = join(project.localPath, `requirement-${requirement.id}`);
  await prisma.requirement.update({
    where: { id: requirement.id },
    data: {
      status: "planning",
      planningRuntimeState: "paused",
      planningAnchorId: "anchor_requirement_resume"
    }
  });
  await prisma.anchorAllocation.create({
    data: {
      anchorId: "anchor_requirement_resume",
      anchorPath,
      projectId: project.id,
      socketPath: null,
      subjectType: "requirement",
      subjectId: requirement.id,
      subjectKey: requirement.title,
      mode: "planning",
      state: "ready",
      runtimePaused: true
    }
  });
  const app = buildApp({ enableFileWatcher: false });

  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/anchors/anchor_requirement_resume/runtime/resume",
      payload: {}
    });

    assert.equal(response.statusCode, 410);
    const row = await prisma.anchorAllocation.findUniqueOrThrow({ where: { anchorId: "anchor_requirement_resume" } });
    assert.equal(row.runtimePaused, true);
    assert.equal(row.socketPath, null);
    const updatedRequirement = await prisma.requirement.findUniqueOrThrow({ where: { id: requirement.id } });
    assert.equal(updatedRequirement.planningRuntimeState, "paused");
  } finally {
    await app.close();
  }
});

test("POST /api/anchors/:anchorId/runtime/resume is deprecated for SubTask execution anchors", async () => {
  const { project, task } = await createSubtaskFixture();
  const anchorPath = join(project.localPath, `task-${task.id}`);
  await prisma.anchorAllocation.create({
    data: {
      anchorId: "anchor_subtask_resume",
      anchorPath,
      projectId: project.id,
      socketPath: null,
      subjectType: "subtask",
      subjectId: task.id,
      subjectKey: task.taskKey,
      mode: "execution",
      state: "ready",
      runtimePaused: true
    }
  });
  const app = buildApp({ enableFileWatcher: false });

  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/anchors/anchor_subtask_resume/runtime/resume",
      payload: {}
    });

    assert.equal(response.statusCode, 410);
    const row = await prisma.anchorAllocation.findUniqueOrThrow({ where: { anchorId: "anchor_subtask_resume" } });
    assert.equal(row.runtimePaused, true);
    assert.equal(row.socketPath, null);
  } finally {
    await app.close();
  }
});

test("POST /api/anchors/:anchorId/runtime/resume is deprecated without restarting unsupported legacy anchors", async () => {
  const { project } = await createRequirementFixture();
  await prisma.anchorAllocation.create({
    data: {
      anchorId: "anchor_unknown_resume",
      anchorPath: join(project.localPath, "unknown-anchor"),
      projectId: project.id,
      socketPath: null,
      subjectType: "workspace",
      subjectId: "workspace-1",
      subjectKey: "workspace-1",
      mode: "planning",
      state: "ready",
      runtimePaused: true
    }
  });
  const app = buildApp({ enableFileWatcher: false });

  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/anchors/anchor_unknown_resume/runtime/resume",
      payload: {}
    });

    assert.equal(response.statusCode, 410);
  } finally {
    await app.close();
  }
});

test("POST /api/anchors/:anchorId/reset is deprecated for Requirement planning anchors", async () => {
  const { project, requirement } = await createRequirementFixture();
  const anchorPath = join(project.localPath, `requirement-${requirement.id}`);
  await prisma.anchorAllocation.create({
    data: {
      anchorId: "anchor_requirement_reset",
      anchorPath,
      projectId: project.id,
      socketPath: "/tmp/requirement-reset.sock",
      subjectType: "requirement",
      subjectId: requirement.id,
      subjectKey: requirement.title,
      mode: "planning",
      state: "ready"
    }
  });
  const app = buildApp({ enableFileWatcher: false });

  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/anchors/anchor_requirement_reset/reset",
      payload: {}
    });

    assert.equal(response.statusCode, 410);
    assert.equal(await prisma.anchorAllocation.count({ where: { anchorId: "anchor_requirement_reset" } }), 1);
  } finally {
    await app.close();
  }
});

test("POST /api/anchors/:anchorId/reset is deprecated for SubTask execution anchors", async () => {
  const { project, task } = await createSubtaskFixture();
  const anchorPath = join(project.localPath, `task-${task.id}`);
  await prisma.anchorAllocation.create({
    data: {
      anchorId: "anchor_subtask_reset",
      anchorPath,
      projectId: project.id,
      socketPath: "/tmp/subtask-reset.sock",
      subjectType: "subtask",
      subjectId: task.id,
      subjectKey: task.taskKey,
      mode: "execution",
      state: "ready"
    }
  });
  const app = buildApp({ enableFileWatcher: false });

  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/anchors/anchor_subtask_reset/reset",
      payload: {}
    });

    assert.equal(response.statusCode, 410);
    assert.equal(await prisma.anchorAllocation.count({ where: { anchorId: "anchor_subtask_reset" } }), 1);
  } finally {
    await app.close();
  }
});

test("POST /api/projects/:projectId/requirements/:requirementId/anchor/reset is deprecated without cleanup", async () => {
  const { project, requirement } = await createRequirementFixture();
  const app = buildApp({ enableFileWatcher: false });

  try {
    const response = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/requirements/${requirement.id}/anchor/reset`,
      payload: {}
    });

    assert.equal(response.statusCode, 410);
    assert.equal(await prisma.anchorAllocation.count({ where: { subjectType: "requirement", subjectId: requirement.id } }), 0);
  } finally {
    await app.close();
  }
});

test("POST /api/anchors/:anchorId/reset is deprecated without cleaning unsupported legacy anchors", async () => {
  const { project } = await createRequirementFixture();
  await prisma.anchorAllocation.create({
    data: {
      anchorId: "anchor_unknown_reset",
      anchorPath: join(project.localPath, "unknown-anchor"),
      projectId: project.id,
      socketPath: "/tmp/unknown-reset.sock",
      subjectType: "workspace",
      subjectId: "workspace-1",
      subjectKey: "workspace-1",
      mode: "planning",
      state: "ready"
    }
  });
  const app = buildApp({ enableFileWatcher: false });

  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/anchors/anchor_unknown_reset/reset",
      payload: {}
    });

    assert.equal(response.statusCode, 410);
    assert.equal(await prisma.anchorAllocation.count({ where: { anchorId: "anchor_unknown_reset" } }), 1);
  } finally {
    await app.close();
  }
});
