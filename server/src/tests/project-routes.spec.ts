import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { FastifyInstance } from "fastify";
import { afterAll, test } from "vitest";

import { buildApp } from "../app.js";
import { prisma } from "../db/prisma.js";
import { FileWatcherService } from "../fs/file-watcher-service.js";
import { startProjectScan } from "../indexer/project-indexer.js";
import { PrismaProjectStore } from "../modules/project/project.store.prisma.js";

const execFileAsync = promisify(execFile);

async function resetDatabase(): Promise<void> {
  await prisma.reviewIntent.deleteMany();
  await prisma.taskWorkspace.deleteMany();
  await prisma.syncJob.deleteMany();
  await prisma.requirement.deleteMany();
  await prisma.task.deleteMany();
  await prisma.document.deleteMany();
  await prisma.project.deleteMany();
}

async function createFixtureProject(options: { git?: boolean } = {}): Promise<{ projectRoot: string; statePath: string }> {
  const projectRoot = join(tmpdir(), `ccb-console-fixture-${Date.now()}-${randomUUID()}`);
  const docsRoot = join(projectRoot, "docs", ".ccb");
  const devTaskRoot = join(projectRoot, "docs", "03_开发计划");
  const statePath = join(devTaskRoot, "user-login-开发任务.md");

  await mkdir(devTaskRoot, { recursive: true });
  await mkdir(join(docsRoot, "plans", "active"), { recursive: true });
  await mkdir(join(docsRoot, "tasks", "active"), { recursive: true });

  await writeFile(
    join(devTaskRoot, "user-login-开发任务.md"),
    `---
doc_type: dev_task
task_id: task-user-login
title: 用户登录能力
status: reviewing
current_node: implementation
node_substate: coding
last_transition_id: dispatch__accepted__to__implementation
revision: 1
priority: high
requirement_id: req-user-login
section_id: pr1-user-login
order: 1
implementation_owner: ccb_codex
dependencies: []
source_breakdown_draft: docs/.ccb/drafts/breakdown/req-user-login.json
source_draft_hash: ${"a".repeat(64)}
created_at: 2026-05-28T10:00:00.000Z
review_status: passed
verification_result: {"build":"passed","test":"passed","timestamp":"2026-04-23T00:00:00.000Z"}
review_followup: ["补充回归记录","通知归档"]
nodes_executed: ["requirement_analysis","technical_design","implementation"]
approval_records: [{"gate":"step1_approval","status":"approved","timestamp":"2026-04-23T00:01:00.000Z"}]
consult_round_ids: ["R1","R2"]
---

# 用户登录能力

实现控制台的账号登录入口，并保持最小交互闭环。

- 提供登录入口、状态展示和错误提示。
- 保持任务文档可被 dev_task schema 验证。
`,
    "utf8"
  );

  await writeFile(
    join(docsRoot, "plans", "active", "user-login.md"),
    `---
task_id: task-user-login
title: 用户登录实施计划
status: active
kind: plan
---

# 用户登录实施计划

1. 增加表单
2. 连接鉴权接口
3. 增加错误提示
`,
    "utf8"
  );

  await writeFile(
    join(docsRoot, "tasks", "active", "user-login.md"),
    `---
task_id: task-user-login
title: 用户登录任务卡
status: active
priority: high
phase: implementing
progress: 60
kind: task
---

# 用户登录任务卡

当前已经完成页面设计，正在补服务端接口。
`,
    "utf8"
  );

  if (options.git) {
    await initGitRepository(projectRoot);
  }

  return { projectRoot, statePath };
}

async function createIndexerCoverageProject(): Promise<{ projectRoot: string }> {
  const projectRoot = join(tmpdir(), `ccb-indexer-coverage-${Date.now()}-${randomUUID()}`);
  const ccbDocsRoot = join(projectRoot, "docs", ".ccb");
  const devTaskRoot = join(projectRoot, "docs", "03_开发计划");

  await mkdir(devTaskRoot, { recursive: true });
  await mkdir(join(ccbDocsRoot, "state"), { recursive: true });
  await mkdir(join(projectRoot, "docs", "06_决策记录"), { recursive: true });
  await mkdir(join(projectRoot, "docs", "01_架构设计"), { recursive: true });
  await mkdir(join(projectRoot, "docs", "05_经验沉淀"), { recursive: true });

  await writeFile(
    join(devTaskRoot, "user-login-开发任务.md"),
    `---
doc_type: dev_task
task_id: task-user-login
title: 用户登录能力
status: reviewing
current_node: implementation
node_substate: coding
priority: high
requirement_id: req-user-login
section_id: pr1-user-login
order: 1
implementation_owner: ccb_codex
dependencies: []
source_breakdown_draft: docs/.ccb/drafts/breakdown/req-user-login.json
source_draft_hash: ${"a".repeat(64)}
created_at: 2026-05-28T10:00:00.000Z
---

# 用户登录能力

- 提供登录入口、状态展示和错误提示。
- 保持任务文档可被 dev_task schema 验证。
`,
    "utf8"
  );

  await writeFile(
    join(ccbDocsRoot, "state", "user-login.md"),
    `---
task_id: task-user-login
title: 用户登录实时状态
status: active
kind: state
revision: 1
---

# 用户登录实时状态
`,
    "utf8"
  );

  await writeFile(
    join(projectRoot, "docs", "06_决策记录", "ADR-0001-test-decision.md"),
    `---
doc_type: adr
task_id: adr-should-not-be-task
title: ADR-0001 测试决策
status: accepted
---

# ADR-0001 测试决策
`,
    "utf8"
  );

  await writeFile(
    join(projectRoot, "docs", "01_架构设计", "console-design.md"),
    `---
doc_type: architecture
title: Console 设计说明
updated: 2026-05-28T10:00:00.000Z
---

# Console 设计说明
`,
    "utf8"
  );

  await writeFile(
    join(projectRoot, "docs", "05_经验沉淀", "reference-note.md"),
    `---
doc_type: lessons
title: 参考研究笔记
updated: 2026-05-28T10:00:00.000Z
---

# 参考研究笔记
`,
    "utf8"
  );

  return { projectRoot };
}

async function createProjectionBugfixProject(): Promise<{ projectRoot: string }> {
  const projectRoot = join(tmpdir(), `ccb-projection-bugfix-${Date.now()}-${randomUUID()}`);
  const ccbDocsRoot = join(projectRoot, "docs", ".ccb");
  const devTaskRoot = join(projectRoot, "docs", "03_开发计划");

  await mkdir(devTaskRoot, { recursive: true });
  await mkdir(join(ccbDocsRoot, "state"), { recursive: true });

  await writeFile(
    join(devTaskRoot, "weird-kind-开发任务.md"),
    `---
doc_type: dev_task
task_id: task-weird-kind
title: Path Wins Dev Task
status: reviewing
current_node: dispatch
node_substate: awaiting_codex_pickup
priority: medium
requirement_id: req-weird-kind
section_id: pr1-weird-kind
order: 1
implementation_owner: ccb_codex
dependencies: []
source_breakdown_draft: docs/.ccb/drafts/breakdown/req-weird-kind.json
source_draft_hash: ${"a".repeat(64)}
created_at: 2026-05-28T10:00:00.000Z
---

# Path Wins Dev Task

- Valid dev_task document used for projection coverage.
- The path and doc_type should classify this document as dev_task.
`,
    "utf8"
  );

  await writeFile(
    join(ccbDocsRoot, "state", "state-only-epic.md"),
    `---
task_id: state-only-epic
title: State Only Epic
status: epic_completed
kind: planning_container
currentNode: archive
runtimeState: completed
revision: 7
phase: archive
engineering_decidable_decisions:
  - id: ed-forward-compat
    decision_ref: dec-forward-compat
    touchpoint: U2_db_api_rename
---

# State Only Epic
`,
    "utf8"
  );

  await writeFile(
    join(ccbDocsRoot, "state", "archived-task.md"),
    `---
task_id: archived-task
title: Archived Task
status: archived
kind: state
currentNode: archive
runtimeState: completed
revision: 2
phase: archive
---

# Archived Task
`,
    "utf8"
  );

  await writeFile(
    join(ccbDocsRoot, "state", "unknown-status.md"),
    `---
task_id: unknown-status
title: Unknown Status
status: mystery_status
kind: state
currentNode: implementation
runtimeState: running
revision: 1
phase: archive
---

# Unknown Status
`,
    "utf8"
  );

  return { projectRoot };
}

async function initGitRepository(projectRoot: string): Promise<void> {
  await execFileAsync("git", ["init"], { cwd: projectRoot });
  await execFileAsync("git", ["config", "user.email", "ccb-console@example.local"], { cwd: projectRoot });
  await execFileAsync("git", ["config", "user.name", "CCB Console Test"], { cwd: projectRoot });
  await execFileAsync("git", ["add", "."], { cwd: projectRoot });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: projectRoot });
}

async function createScannedFixtureProject(
  app: FastifyInstance,
  options: { git?: boolean; name?: string } = {}
): Promise<{ projectId: string; taskId: string; taskKey: string; projectRoot: string; statePath: string }> {
  const { projectRoot, statePath } = await createFixtureProject({ git: options.git });
  const createResponse = await app.inject({
    method: "POST",
    url: "/api/projects",
    payload: {
      name: options.name ?? "CCB Console",
      localPath: projectRoot.replace(/\\/g, "/"),
      summary: "用于扩展 server 覆盖"
    }
  });

  assert.equal(createResponse.statusCode, 201);
  const projectId = createResponse.json().id as string;
  const scanResponse = await app.inject({
    method: "POST",
    url: `/api/projects/${projectId}/scan`
  });
  assert.equal(scanResponse.statusCode, 202);
  assert.equal(scanResponse.json().status, "scanning");
  await waitForProjectScanComplete(projectId);

  const tasksResponse = await app.inject({
    method: "GET",
    url: `/api/projects/${projectId}/tasks`
  });
  assert.equal(tasksResponse.statusCode, 200);
  assert.equal(tasksResponse.json().items.length >= 1, true);

  return {
    projectId,
    taskId: tasksResponse.json().items[0].id as string,
    taskKey: tasksResponse.json().items[0].taskKey as string,
    projectRoot,
    statePath
  };
}

async function testProjectScanStatusExposesPhaseFieldsAndRealCounts(): Promise<void> {
  const app = buildApp({
    projectStore: new PrismaProjectStore(prisma),
    fileWatcherService: null
  });

  await resetDatabase();
  const project = await prisma.project.create({
    data: {
      name: "scan-status fixture",
      localPath: join(tmpdir(), `ccb-scan-status-${Date.now()}-${randomUUID()}`),
      syncStatus: "scanning",
      lastScanAt: new Date("2026-06-02T00:59:00.000Z")
    }
  });
  const scanJob = await prisma.syncJob.create({
    data: {
      projectId: project.id,
      jobType: "scan",
      status: "running",
      processedCount: 4,
      totalCount: 10,
      startedAt: new Date("2026-06-02T01:00:00.000Z"),
      createdAt: new Date("2026-06-02T01:00:00.000Z")
    }
  });
  await prisma.syncJob.create({
    data: {
      projectId: project.id,
      jobType: "generate",
      status: "running",
      startedAt: new Date("2026-06-02T01:01:00.000Z"),
      createdAt: new Date("2026-06-02T01:01:00.000Z")
    }
  });

  const response = await app.inject({
    method: "GET",
    url: `/api/projects/${project.id}/scan-status`
  });

  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.projectId, project.id);
  assert.equal(body.projectSyncStatus, "scanning");
  assert.equal(body.status, "running");
  assert.equal(body.processedCount, 4);
  assert.equal(body.totalCount, 10);
  assert.equal(body.errorMessage, null);
  assert.equal(body.jobId, scanJob.id);
  assert.equal(typeof body.updatedAt, "string");
  assert.equal(Object.hasOwn(body, "phase"), true);
  assert.equal(Object.hasOwn(body, "phaseStatus"), true);
  assert.equal(Object.hasOwn(body, "phaseJobId"), true);
  assert.equal(Object.hasOwn(body, "phaseErrorMessage"), true);
  assert.equal(body.phase, "scan");
  assert.equal(body.phaseStatus, "running");
  assert.equal(body.phaseJobId, scanJob.id);
  assert.equal(body.phaseErrorMessage, null);

  await app.close();
}

async function waitForProjectScanComplete(
  projectId: string,
  expectedSyncStatus: "idle" | "failed" = "idle"
): Promise<void> {
  await waitForCondition(async () => {
    const project = await prisma.project.findUnique({
      where: {
        id: projectId
      },
      select: {
        syncStatus: true
      }
    });
    return project?.syncStatus === expectedSyncStatus;
  }, 5_000);
}

async function testStartProjectScanEarlyFailureReleasesScanningClaim(): Promise<void> {
  const projectId = "project-early-failure";
  let syncStatus = "idle";
  let jobSequence = 0;
  let failedUpdateCount = 0;
  const syncJobUpdates: Array<{ status?: string; errorMessage?: string | null }> = [];

  const createJob = (input: { id: string; status: string }) => ({
    id: input.id,
    projectId,
    jobType: "scan",
    status: input.status,
    processedCount: 0,
    totalCount: 0,
    errorMessage: null,
    startedAt: new Date(),
    finishedAt: null,
    updatedAt: new Date()
  });

  const fakePrisma = {
    project: {
      updateMany: async () => {
        if (syncStatus === "scanning") {
          return { count: 0 };
        }
        syncStatus = "scanning";
        return { count: 1 };
      },
      findUnique: async () => ({
        id: projectId,
        localPath: "/tmp/project-early-failure",
        syncStatus
      }),
      update: async ({ data }: { data: { syncStatus: string } }) => {
        syncStatus = data.syncStatus;
        if (syncStatus === "failed") {
          failedUpdateCount += 1;
        }
        return { id: projectId, syncStatus };
      }
    },
    syncJob: {
      create: async ({ data }: { data: { status: string } }) => {
        jobSequence += 1;
        return createJob({ id: `sync-job-${jobSequence}`, status: data.status });
      },
      findFirst: async () => createJob({ id: `sync-job-${jobSequence}`, status: "running" }),
      findUniqueOrThrow: async () => {
        throw new Error("missing scan job before scan try");
      },
      update: async ({ data }: { data: { status?: string; errorMessage?: string | null } }) => {
        syncJobUpdates.push(data);
        return createJob({ id: `sync-job-${jobSequence}`, status: data.status ?? "running" });
      }
    }
  } as unknown as Parameters<typeof startProjectScan>[0];

  const firstStart = await startProjectScan(fakePrisma, projectId);
  assert.equal(firstStart.started, true);
  assert.equal(syncStatus, "scanning");

  await waitForCondition(async () => failedUpdateCount >= 1);
  assert.equal(syncStatus, "failed");
  assert.equal(syncJobUpdates.some((update) => update.status === "failed"), true);
  assert.equal(syncJobUpdates.some((update) => update.errorMessage === "missing scan job before scan try"), true);

  const retryStart = await startProjectScan(fakePrisma, projectId);
  assert.equal(retryStart.started, true);
  assert.equal(syncStatus, "scanning");
  await waitForCondition(async () => failedUpdateCount >= 2);
}

async function testProjectDocumentTaskAndRequirementFlow(): Promise<void> {
  const app = buildApp({
    projectStore: new PrismaProjectStore(prisma)
  });

  await resetDatabase();
  const { projectRoot: fixtureProjectRoot, statePath } = await createFixtureProject({ git: true });

  const createResponse = await app.inject({
    method: "POST",
    url: "/api/projects",
    payload: {
      name: "CCB Console",
      localPath: fixtureProjectRoot.replace(/\\/g, "/"),
      summary: "用于管理本地 CCB 项目的控制台"
    }
  });

  assert.equal(createResponse.statusCode, 201);
  assert.deepEqual(
    {
      name: createResponse.json().name,
      localPath: createResponse.json().localPath,
      initStatus: createResponse.json().initStatus,
      syncStatus: createResponse.json().syncStatus
    },
    {
      name: "CCB Console",
      localPath: fixtureProjectRoot.replace(/\\/g, "/"),
      initStatus: "not_initialized",
      syncStatus: "scanning"
    }
  );

  const projectId = createResponse.json().id as string;

  const listResponse = await app.inject({
    method: "GET",
    url: "/api/projects"
  });

  assert.equal(listResponse.statusCode, 200);
  assert.equal(Array.isArray(listResponse.json().items), true);
  assert.equal(listResponse.json().items.length, 1);
  assert.equal(listResponse.json().items[0].name, "CCB Console");

  const scanResponse = await app.inject({
    method: "POST",
    url: `/api/projects/${projectId}/scan`
  });

  assert.equal(scanResponse.statusCode, 202);
  assert.equal(scanResponse.json().status, "scanning");

  await waitForProjectScanComplete(projectId);

  const scanStatusResponse = await app.inject({
    method: "GET",
    url: `/api/projects/${projectId}/scan-status`
  });
  assert.equal(scanStatusResponse.statusCode, 200);
  assert.equal(scanStatusResponse.json().projectSyncStatus, "idle");
  assert.equal(scanStatusResponse.json().processedCount, 3);
  assert.equal(scanStatusResponse.json().totalCount, 3);

  const healthyIndexResponse = await app.inject({
    method: "GET",
    url: `/api/projects/${projectId}/index-health`
  });

  assert.equal(healthyIndexResponse.statusCode, 200);
  assert.equal(healthyIndexResponse.json().documentCount, 3);
  assert.equal(healthyIndexResponse.json().taskCount, 1);
  assert.equal(healthyIndexResponse.json().requirementCount, 0);
  assert.equal(healthyIndexResponse.json().parseFailureCount, 0);

  const syncJobsResponse = await app.inject({
    method: "GET",
    url: `/api/projects/${projectId}/sync-jobs`
  });

  assert.equal(syncJobsResponse.statusCode, 200);
  assert.equal(syncJobsResponse.json().items.length >= 3, true);
  assert.equal(syncJobsResponse.json().items.some((item: { jobType: string }) => item.jobType === "scan"), true);
  assert.equal(syncJobsResponse.json().items.some((item: { jobType: string }) => item.jobType === "parse"), true);
  assert.equal(syncJobsResponse.json().items.some((item: { jobType: string }) => item.jobType === "reconcile"), true);

  const documentsResponse = await app.inject({
    method: "GET",
    url: `/api/projects/${projectId}/documents`
  });

  assert.equal(documentsResponse.statusCode, 200);
  assert.equal(documentsResponse.json().items.length, 3);
  assert.equal(documentsResponse.json().items[0].projectId, projectId);

  const firstDocumentId = documentsResponse.json().items[0].id as string;
  const documentDetailResponse = await app.inject({
    method: "GET",
    url: `/api/documents/${firstDocumentId}`
  });

  assert.equal(documentDetailResponse.statusCode, 200);
  assert.match(documentDetailResponse.json().content, /# /);
  assert.equal(typeof documentDetailResponse.json().frontmatter, "object");

  const tasksResponse = await app.inject({
    method: "GET",
    url: `/api/projects/${projectId}/tasks`
  });

  assert.equal(tasksResponse.statusCode, 200);
  assert.equal(tasksResponse.json().items.length, 1);
  assert.equal(tasksResponse.json().items[0].title, "用户登录能力");
  assert.equal(tasksResponse.json().items[0].phase, "实施");
  assert.equal(tasksResponse.json().items[0].progress, 20);

  const taskId = tasksResponse.json().items[0].id as string;
  const taskKey = tasksResponse.json().items[0].taskKey as string;
  const taskDetailResponse = await app.inject({
    method: "GET",
    url: `/api/tasks/${taskId}`
  });

  assert.equal(taskDetailResponse.statusCode, 200);
  assert.equal(taskDetailResponse.json().linkedDocuments.length, 1);
  assert.equal(taskDetailResponse.json().linkedRequirement, null);
  assert.equal("workspaces" in taskDetailResponse.json(), false);
  assert.equal(taskDetailResponse.json().reviewStatus, "passed");
  assert.deepEqual(taskDetailResponse.json().verificationResult, {
    build: "passed",
    test: "passed",
    timestamp: "2026-04-23T00:00:00.000Z"
  });
  assert.deepEqual(taskDetailResponse.json().reviewFollowup, ["补充回归记录", "通知归档"]);
  assert.deepEqual(taskDetailResponse.json().reviewIntents, []);
  assert.match(taskDetailResponse.json().linkedDocuments[0].path, /docs\/03_开发计划\/user-login-开发任务\.md$/);
  assert.equal(taskDetailResponse.json().linkedDocuments[0].kind, "dev_task");

  const reviewIntentResponses = [];
  for (const intentType of ["mark_review_pass", "request_replan", "request_escalate"]) {
    const response = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/review-intents`,
      payload: {
        intentType,
        payload: `intent comment for ${intentType}`
      }
    });

    assert.equal(response.statusCode, 201);
    assert.equal(response.json().taskId, taskId);
    assert.equal(response.json().taskKey, taskKey);
    assert.equal(response.json().intentType, intentType);
    assert.equal(response.json().payload, `intent comment for ${intentType}`);
    assert.equal(response.json().status, "pending");
    reviewIntentResponses.push(response);
  }

  const taskReviewIntentsResponse = await app.inject({
    method: "GET",
    url: `/api/tasks/${taskId}/review-intents`
  });

  assert.equal(taskReviewIntentsResponse.statusCode, 200);
  assert.equal(taskReviewIntentsResponse.json().items.length, 3);

  const cancelReviewIntentResponse = await app.inject({
    method: "DELETE",
    url: `/api/review-intents/${reviewIntentResponses[0].json().id as string}`
  });

  assert.equal(cancelReviewIntentResponse.statusCode, 200);
  assert.equal(cancelReviewIntentResponse.json().status, "cancelled");

  const taskWithIntentsResponse = await app.inject({
    method: "GET",
    url: `/api/tasks/${taskId}`
  });

  assert.equal(taskWithIntentsResponse.statusCode, 200);
  assert.equal(taskWithIntentsResponse.json().reviewIntents.length, 3);
  assert.equal(
    taskWithIntentsResponse.json().reviewIntents.some((intent: { status: string }) => intent.status === "cancelled"),
    true
  );

  const timelineBeforeWorkspaceResponse = await app.inject({
    method: "GET",
    url: `/api/tasks/${taskId}/timeline`
  });

  assert.equal(timelineBeforeWorkspaceResponse.statusCode, 200);
  assert.equal(timelineBeforeWorkspaceResponse.json().taskId, taskId);
  assert.equal(timelineBeforeWorkspaceResponse.json().events.length >= 4, true);
  assert.deepEqual(
    new Set(timelineBeforeWorkspaceResponse.json().events.map((event: { kind: string }) => event.kind)),
    new Set(["transition", "approval", "consult", "intent_create", "intent_cancel"])
  );
  assert.equal(eventsAreSortedDesc(timelineBeforeWorkspaceResponse.json().events), true);

  const workspaceResponse = await app.inject({
    method: "POST",
    url: `/api/tasks/${taskId}/workspaces`,
    payload: {
      baseRef: "HEAD"
    }
  });

  assert.equal(workspaceResponse.statusCode, 410);
  assert.match(workspaceResponse.json().message, /工作区建删入口已关闭/);

  const duplicateWorkspaceResponse = await app.inject({
    method: "POST",
    url: `/api/tasks/${taskId}/workspaces`
  });

  assert.equal(duplicateWorkspaceResponse.statusCode, 410);

  const cleanupWorkspaceResponse = await app.inject({
    method: "DELETE",
    url: "/api/task-workspaces/retired-workspace"
  });

  assert.equal(cleanupWorkspaceResponse.statusCode, 410);
  assert.match(cleanupWorkspaceResponse.json().message, /工作区建删入口已关闭/);

  const timelineAfterWorkspaceResponse = await app.inject({
    method: "GET",
    url: `/api/tasks/${taskId}/timeline`
  });

  assert.equal(timelineAfterWorkspaceResponse.statusCode, 200);
  const timelineKinds = new Set(timelineAfterWorkspaceResponse.json().events.map((event: { kind: string }) => event.kind));
  assert.equal(timelineKinds.has("workspace_create"), false);
  assert.equal(timelineKinds.has("workspace_cleanup"), false);
  assert.equal(eventsAreSortedDesc(timelineAfterWorkspaceResponse.json().events), true);

  await writeFile(
    statePath,
    `---
task_id: task-user-login
title: 用户登录实时状态
status: active
kind: state
currentNode: review
nodeSubstate: awaiting_review
runtimeState: waiting_user
lastTransitionId: implementation__complete__to__review
revision: 2
phase: reviewing
progress: 80
review_status: needs_followup
verification_result: {"build":"passed","test":"failed","timestamp":"2026-04-23T00:30:00.000Z"}
review_followup: ["补充失败测试日志"]
---

# 用户登录实时状态

当前任务已进入审查。
`,
    "utf8"
  );

  const staleIndexResponse = await app.inject({
    method: "GET",
    url: `/api/projects/${projectId}/index-health`
  });

  assert.equal(staleIndexResponse.statusCode, 200);

  await writeFile(
    statePath,
    `---
doc_type: dev_task
task_id: task-user-login
title: 用户登录能力
status: reviewing
current_node: implementation
node_substate: coding
last_transition_id: dispatch__accepted__to__implementation
revision: 3
priority: high
requirement_id: req-user-login
section_id: pr1-user-login
order: 1
implementation_owner: ccb_codex
dependencies: []
source_breakdown_draft: docs/.ccb/drafts/breakdown/req-user-login.json
source_draft_hash: ${"a".repeat(64)}
created_at: 2026-05-28T10:00:00.000Z
review_status: passed
verification_result: {"build":"passed","test":"passed","timestamp":"2026-04-23T00:40:00.000Z"}
review_followup: ["watcher 自动刷新完成"]
---

# 用户登录实时状态

当前任务已通过 watcher 自动刷新。

- watcher 写入 dev_task frontmatter 后应触发 scanProject。
- 这段正文保持足够长度，避免 dev_task schema 因正文过短进入 partial。
`,
    "utf8"
  );

  const fileWatcher = new FileWatcherService({
    prisma,
    debounceMs: 10,
    logger: silentLogger
  });
  fileWatcher.queueProjectFileEvent(projectId, "change", statePath);
  fileWatcher.queueProjectFileEvent(projectId, "change", statePath);

  await waitForCondition(async () => {
    const task = await prisma.task.findUnique({
      where: {
        id: taskId
      }
    });
    return task?.reviewFollowupJson?.includes("watcher 自动刷新完成") ?? false;
  });
  await fileWatcher.stop();

  const watcherRefreshedTaskResponse = await app.inject({
    method: "GET",
    url: `/api/tasks/${taskId}`
  });

  assert.equal(watcherRefreshedTaskResponse.statusCode, 200);
  assert.equal(watcherRefreshedTaskResponse.json().status, "reviewing");
  assert.equal(watcherRefreshedTaskResponse.json().phase, "实施");
  assert.equal(watcherRefreshedTaskResponse.json().currentNode, "implementation");
  assert.equal(watcherRefreshedTaskResponse.json().runtimeState, null);
  assert.equal(watcherRefreshedTaskResponse.json().reviewStatus, "passed");
  assert.deepEqual(watcherRefreshedTaskResponse.json().reviewFollowup, ["watcher 自动刷新完成"]);

  const rejectedPatchResponse = await app.inject({
    method: "PATCH",
    url: `/api/tasks/${taskId}`,
    payload: {
      currentNode: "review",
      unexpectedField: "unexpected"
    }
  });

  assert.equal(rejectedPatchResponse.statusCode, 400);
  const unknownKeyIssue = rejectedPatchResponse
    .json()
    .issues.find((issue: { code: string; keys?: string[] }) => issue.code === "unrecognized_keys");
  assert.ok(unknownKeyIssue);
  assert.deepEqual(new Set(unknownKeyIssue.keys), new Set(["currentNode", "unexpectedField"]));

  const updateTaskResponse = await app.inject({
    method: "PATCH",
    url: `/api/tasks/${taskId}`,
    payload: {
      priority: "urgent"
    }
  });

  assert.equal(updateTaskResponse.statusCode, 200);
  assert.equal(updateTaskResponse.json().status, "reviewing");
  assert.equal(updateTaskResponse.json().priority, "urgent");

  const requirementResponse = await app.inject({
    method: "POST",
    url: `/api/projects/${projectId}/requirements`,
    payload: {
      title: "增加通知中心",
      description: "希望在控制台中集中查看任务和扫描提醒。",
      outputMode: "requirement_only"
    }
  });

  assert.equal(requirementResponse.statusCode, 201, requirementResponse.body);
  assert.equal(requirementResponse.json().title, "增加通知中心");
  assert.equal(requirementResponse.json().verbatimSource, "希望在控制台中集中查看任务和扫描提醒。");
  assert.equal(requirementResponse.json().claudeInterpretation, null);
  assert.equal(requirementResponse.json().generatedTaskId, null);

  const requirementsResponse = await app.inject({
    method: "GET",
    url: `/api/projects/${projectId}/requirements`
  });

  assert.equal(requirementsResponse.statusCode, 200);
  assert.equal(requirementsResponse.json().items.length, 1);

  const tasksAfterRequirementResponse = await app.inject({
    method: "GET",
    url: `/api/projects/${projectId}/tasks`
  });

  assert.equal(tasksAfterRequirementResponse.statusCode, 200);
  assert.equal(tasksAfterRequirementResponse.json().items.length, 1);

  const multilineVerbatim = "用户原话第一行\r\n  第二行保留缩进\n第三行";
  const fidelityRequirementResponse = await app.inject({
    method: "POST",
    url: `/api/projects/${projectId}/requirements`,
    payload: {
      title: "保真录入测试",
      description: "用于验证四段保真字段。",
      outputMode: "requirement_only",
      verbatim_source: multilineVerbatim,
      claude_interpretation: "Claude 解读：保留用户原文。",
      ambiguities: "歧义：无",
      fidelity_diff: "差异：无"
    }
  });

  assert.equal(fidelityRequirementResponse.statusCode, 201);
  assert.equal(fidelityRequirementResponse.json().verbatimSource, multilineVerbatim);
  assert.equal(fidelityRequirementResponse.json().claudeInterpretation, "Claude 解读：保留用户原文。");
  assert.equal(fidelityRequirementResponse.json().ambiguities, "歧义：无");
  assert.equal(fidelityRequirementResponse.json().fidelityDiff, "差异：无");

  const fidelityListResponse = await app.inject({
    method: "GET",
    url: `/api/projects/${projectId}/requirements`
  });

  assert.equal(fidelityListResponse.statusCode, 200);
  assert.equal(fidelityListResponse.json().items[0].verbatimSource, multilineVerbatim);

  const retiredGenerateResponse = await app.inject({
    method: "POST",
    url: `/api/projects/${projectId}/requirements/${fidelityRequirementResponse.json().id as string}/generate-task`
  });

  assert.equal(retiredGenerateResponse.statusCode, 410);
  assert.match(retiredGenerateResponse.json().message, /SP-B15|需求详情页/);

  const generatedRequirementListResponse = await app.inject({
    method: "GET",
    url: `/api/projects/${projectId}/requirements`
  });

  const generatedRequirement = generatedRequirementListResponse
    .json()
    .items.find((item: { id: string }) => item.id === fidelityRequirementResponse.json().id);
  assert.equal(generatedRequirement.generatedTaskId, null);

  const legacyRequirement = await prisma.requirement.create({
    data: {
      projectId,
      title: "旧需求描述回退",
      description: "只有 description 的旧需求",
      status: "drafting",
      source: "manual"
    }
  });

  const fallbackGenerateResponse = await app.inject({
    method: "POST",
    url: `/api/projects/${projectId}/requirements/${legacyRequirement.id}/generate-task`
  });

  assert.equal(fallbackGenerateResponse.statusCode, 410);

  const { projectRoot: noGitProjectRoot } = await createFixtureProject();
  const noGitProjectResponse = await app.inject({
    method: "POST",
    url: "/api/projects",
    payload: {
      name: "No Git Project",
      localPath: noGitProjectRoot.replace(/\\/g, "/"),
      summary: "用于验证 worktree 错误"
    }
  });

  assert.equal(noGitProjectResponse.statusCode, 201);
  const noGitProjectId = noGitProjectResponse.json().id as string;
  const noGitScanResponse = await app.inject({
    method: "POST",
    url: `/api/projects/${noGitProjectId}/scan`
  });
  assert.equal(noGitScanResponse.statusCode, 202);
  await waitForProjectScanComplete(noGitProjectId);
  const noGitTasksResponse = await app.inject({
    method: "GET",
    url: `/api/projects/${noGitProjectId}/tasks`
  });
  const noGitTaskId = noGitTasksResponse.json().items[0].id as string;
  const noGitWorkspaceResponse = await app.inject({
    method: "POST",
    url: `/api/tasks/${noGitTaskId}/workspaces`
  });

  assert.equal(noGitWorkspaceResponse.statusCode, 410);
  assert.match(noGitWorkspaceResponse.json().message, /工作区建删入口已关闭/);

  const badProjectResponse = await app.inject({
    method: "POST",
    url: "/api/projects",
    payload: {
      name: "Broken Project",
      localPath: join(tmpdir(), `ccb-test-${randomUUID()}`, "not-exists-project"),
      summary: "用于验证扫描失败记录"
    }
  });

  assert.equal(badProjectResponse.statusCode, 201);
  const badProjectId = badProjectResponse.json().id as string;

  const badScanResponse = await app.inject({
    method: "POST",
    url: `/api/projects/${badProjectId}/scan`
  });

  assert.equal(badScanResponse.statusCode, 202);
  assert.equal(badScanResponse.json().status, "scanning");
  await waitForProjectScanComplete(badProjectId, "failed");

  const badScanStatusResponse = await app.inject({
    method: "GET",
    url: `/api/projects/${badProjectId}/scan-status`
  });
  assert.equal(badScanStatusResponse.statusCode, 200);
  assert.equal(badScanStatusResponse.json().projectSyncStatus, "failed");
  assert.equal(typeof badScanStatusResponse.json().errorMessage, "string");

  const badSyncJobsResponse = await app.inject({
    method: "GET",
    url: `/api/projects/${badProjectId}/sync-jobs`
  });

  assert.equal(badSyncJobsResponse.statusCode, 200);
  assert.equal(badSyncJobsResponse.json().items.some((item: { status: string }) => item.status === "failed"), true);
  assert.equal(typeof badSyncJobsResponse.json().items[0].errorMessage, "string");

  await app.close();
}

function eventsAreSortedDesc(events: Array<{ at: string }>): boolean {
  return events.every((event, index) => {
    if (index === 0) {
      return true;
    }
    return new Date(events[index - 1].at).getTime() >= new Date(event.at).getTime();
  });
}

async function waitForCondition(assertion: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await assertion()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("等待条件超时");
}

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
};

async function testRejectInvalidProjectCreation(): Promise<void> {
  const app = buildApp({
    projectStore: new PrismaProjectStore(prisma)
  });

  const response = await app.inject({
    method: "POST",
    url: "/api/projects",
    payload: {
      name: "",
      localPath: join(tmpdir(), `ccb-test-${randomUUID()}`)
    }
  });

  assert.equal(response.statusCode, 400);
  assert.equal(response.json().message, "项目创建参数不合法");

  await app.close();
}

async function testRequirementTaskRetiredWorkspaceAndIntentIntegration(): Promise<void> {
  const app = buildApp({
    projectStore: new PrismaProjectStore(prisma)
  });

  await resetDatabase();
  const { projectId } = await createScannedFixtureProject(app, {
    git: true,
    name: "Cross Module Project"
  });

  const requirementResponse = await app.inject({
    method: "POST",
    url: `/api/projects/${projectId}/requirements`,
    payload: {
      title: "跨模块链路测试",
      description: "验证需求生成任务后 workspace 入口退役且 review intent 仍可用。",
      outputMode: "requirement_only",
      verbatim_source: "用户希望从需求直接驱动任务执行。"
    }
  });
  assert.equal(requirementResponse.statusCode, 201);

  const generatedTask = await prisma.task.create({
    data: {
      projectId,
      requirementId: requirementResponse.json().id as string,
      taskKey: `task-cross-module-${randomUUID().slice(0, 8)}`,
      title: "跨模块任务",
      summary: "需求、子任务、工作空间退役、Review Intent 串联",
      status: "reviewing"
    }
  });
  const generatedTaskId = generatedTask.id;

  const workspaceResponse = await app.inject({
    method: "POST",
    url: `/api/tasks/${generatedTaskId}/workspaces`,
    payload: {
      baseRef: "HEAD"
    }
  });
  assert.equal(workspaceResponse.statusCode, 410);
  assert.match(workspaceResponse.json().message, /工作区建删入口已关闭/);

  const intentResponse = await app.inject({
    method: "POST",
    url: `/api/tasks/${generatedTaskId}/review-intents`,
    payload: {
      intentType: "request_replan",
      payload: "补充跨模块测试说明"
    }
  });
  assert.equal(intentResponse.statusCode, 201);

  const taskDetailResponse = await app.inject({
    method: "GET",
    url: `/api/tasks/${generatedTaskId}`
  });
  assert.equal(taskDetailResponse.statusCode, 200);
  assert.equal(taskDetailResponse.json().linkedRequirement.id, requirementResponse.json().id);
  assert.equal("workspaces" in taskDetailResponse.json(), false);
  assert.equal(taskDetailResponse.json().reviewIntents.length, 1);

  const timelineResponse = await app.inject({
    method: "GET",
    url: `/api/tasks/${generatedTaskId}/timeline`
  });
  assert.equal(timelineResponse.statusCode, 200);
  const kinds = new Set(timelineResponse.json().events.map((event: { kind: string }) => event.kind));
  assert.equal(kinds.has("workspace_create"), false);
  assert.equal(kinds.has("intent_create"), true);

  await app.close();
}

async function testReviewIntentBridgeConsumeContract(): Promise<void> {
  const app = buildApp({
    projectStore: new PrismaProjectStore(prisma)
  });

  await resetDatabase();
  const { taskId } = await createScannedFixtureProject(app, {
    git: true,
    name: "Review Intent Bridge Project"
  });

  const createResponse = await app.inject({
    method: "POST",
    url: `/api/tasks/${taskId}/review-intents`,
    payload: {
      intentType: "request_replan",
      payload: "请复核回归测试失败"
    }
  });
  assert.equal(createResponse.statusCode, 201);
  assert.equal(createResponse.json().attemptCount, 0);
  assert.equal(createResponse.json().lastError, null);
  assert.equal(createResponse.json().lastAttemptAt, null);
  assert.equal(createResponse.json().isStale, false);

  const pendingListResponse = await app.inject({
    method: "GET",
    url: `/api/tasks/${taskId}/review-intents?status=pending`
  });
  assert.equal(pendingListResponse.statusCode, 200);
  assert.equal(pendingListResponse.json().items.length, 1);

  const beforeTaskResponse = await app.inject({
    method: "GET",
    url: `/api/tasks/${taskId}`
  });
  const nodeSnapshot = {
    currentNode: beforeTaskResponse.json().currentNode,
    nodeSubstate: beforeTaskResponse.json().nodeSubstate,
    runtimeState: beforeTaskResponse.json().runtimeState,
    phase: beforeTaskResponse.json().phase,
    status: beforeTaskResponse.json().status,
    lastTransitionId: beforeTaskResponse.json().lastTransitionId
  };

  const consumeResponse = await app.inject({
    method: "POST",
    url: `/api/review-intents/${createResponse.json().id as string}/consume`,
    payload: {
      consumer: "su-review",
      result: "considered"
    }
  });
  assert.equal(consumeResponse.statusCode, 200);
  assert.equal(consumeResponse.json().success, true);
  assert.equal(consumeResponse.json().result, "consumed");
  assert.equal(consumeResponse.json().idempotent, false);
  assert.equal(consumeResponse.json().intent.status, "consumed");
  assert.equal(typeof consumeResponse.json().intent.consumedAt, "string");
  assert.equal(consumeResponse.json().intent.consumedBy, "su-review");
  assert.equal(consumeResponse.json().intent.lastError, null);

  const repeatConsumeResponse = await app.inject({
    method: "POST",
    url: `/api/review-intents/${createResponse.json().id as string}/consume`,
    payload: {
      consumer: "su-review",
      result: "considered"
    }
  });
  assert.equal(repeatConsumeResponse.statusCode, 200);
  assert.equal(repeatConsumeResponse.json().result, "already_consumed");
  assert.equal(repeatConsumeResponse.json().idempotent, true);
  assert.equal(repeatConsumeResponse.json().intent.consumedAt, consumeResponse.json().intent.consumedAt);

  const afterTaskResponse = await app.inject({
    method: "GET",
    url: `/api/tasks/${taskId}`
  });
  assert.deepEqual(
    {
      currentNode: afterTaskResponse.json().currentNode,
      nodeSubstate: afterTaskResponse.json().nodeSubstate,
      runtimeState: afterTaskResponse.json().runtimeState,
      phase: afterTaskResponse.json().phase,
      status: afterTaskResponse.json().status,
      lastTransitionId: afterTaskResponse.json().lastTransitionId
    },
    nodeSnapshot
  );

  const failureIntentResponse = await app.inject({
    method: "POST",
    url: `/api/tasks/${taskId}/review-intents`,
    payload: {
      intentType: "request_escalate",
      payload: "malformed-json"
    }
  });
  assert.equal(failureIntentResponse.statusCode, 201);

  for (const expectedAttempt of [1, 2, 3]) {
    const failureResponse = await app.inject({
      method: "POST",
      url: `/api/review-intents/${failureIntentResponse.json().id as string}/consume`,
      payload: {
        consumer: "su-review",
        result: "failed",
        failureReason: "parse",
        error: "payload parse failed"
      }
    });

    assert.equal(failureResponse.statusCode, 200);
    assert.equal(failureResponse.json().result, "failure_recorded");
    assert.equal(failureResponse.json().intent.status, "pending");
    assert.equal(failureResponse.json().intent.attemptCount, expectedAttempt);
    assert.match(failureResponse.json().intent.lastError, /parse: payload parse failed/);
    assert.equal(typeof failureResponse.json().intent.lastAttemptAt, "string");
    assert.equal(failureResponse.json().intent.isStale, expectedAttempt >= 3);
  }

  const cancelledIntentResponse = await app.inject({
    method: "DELETE",
    url: `/api/review-intents/${failureIntentResponse.json().id as string}`
  });
  assert.equal(cancelledIntentResponse.statusCode, 200);

  const cancelledConsumeResponse = await app.inject({
    method: "POST",
    url: `/api/review-intents/${failureIntentResponse.json().id as string}/consume`,
    payload: {
      consumer: "su-review",
      result: "considered"
    }
  });
  assert.equal(cancelledConsumeResponse.statusCode, 409);

  await app.close();
}

async function testGenerateTaskEndpointRetired(): Promise<void> {
  const app = buildApp({
    projectStore: new PrismaProjectStore(prisma)
  });

  await resetDatabase();
  const { projectId } = await createScannedFixtureProject(app, {
    git: false,
    name: "Duplicate Generate Project"
  });

  const requirementResponse = await app.inject({
    method: "POST",
    url: `/api/projects/${projectId}/requirements`,
    payload: {
      title: "重复生成测试",
      description: "第一次生成后第二次必须冲突。",
      outputMode: "requirement_only"
    }
  });
  assert.equal(requirementResponse.statusCode, 201);

  const firstGenerateResponse = await app.inject({
    method: "POST",
    url: `/api/projects/${projectId}/requirements/${requirementResponse.json().id as string}/generate-task`
  });
  assert.equal(firstGenerateResponse.statusCode, 410);
  assert.match(firstGenerateResponse.json().message, /SP-B15|需求详情页/);

  await app.close();
}

async function testMissingResourceRoutesReturnNotFound(): Promise<void> {
  const app = buildApp({
    projectStore: new PrismaProjectStore(prisma)
  });

  await resetDatabase();
  const missingId = "missing-record-id";

  const taskDetailResponse = await app.inject({
    method: "GET",
    url: `/api/tasks/${missingId}`
  });
  assert.equal(taskDetailResponse.statusCode, 404);

  const timelineResponse = await app.inject({
    method: "GET",
    url: `/api/tasks/${missingId}/timeline`
  });
  assert.equal(timelineResponse.statusCode, 404);

  const reviewIntentResponse = await app.inject({
    method: "POST",
    url: `/api/tasks/${missingId}/review-intents`,
    payload: {
      intentType: "request_replan"
    }
  });
  assert.equal(reviewIntentResponse.statusCode, 404);

  const workspaceResponse = await app.inject({
    method: "POST",
    url: `/api/tasks/${missingId}/workspaces`
  });
  assert.equal(workspaceResponse.statusCode, 410);
  assert.match(workspaceResponse.json().message, /工作区建删入口已关闭/);

  const indexHealthResponse = await app.inject({
    method: "GET",
    url: `/api/projects/${missingId}/index-health`
  });
  assert.equal(indexHealthResponse.statusCode, 404);

  const scanResponse = await app.inject({
    method: "POST",
    url: `/api/projects/${missingId}/scan`
  });
  assert.equal(scanResponse.statusCode, 404);
  assert.equal(scanResponse.json().message, "项目不存在，请重新创建或选择项目");

  await app.close();
}

async function testRouteValidationErrorsReturnBadRequest(): Promise<void> {
  const app = buildApp({
    projectStore: new PrismaProjectStore(prisma)
  });

  await resetDatabase();
  const { projectId, taskId } = await createScannedFixtureProject(app, {
    git: true,
    name: "Validation Project"
  });

  const badRequirementResponse = await app.inject({
    method: "POST",
    url: `/api/projects/${projectId}/requirements`,
    payload: {
      title: "",
      description: "",
      outputMode: "unknown"
    }
  });
  assert.equal(badRequirementResponse.statusCode, 400);

  const badGenerateResponse = await app.inject({
    method: "POST",
    url: `/api/projects/${projectId}/requirements/missing/generate-task`,
    payload: {
      taskKey: ""
    }
  });
  assert.equal(badGenerateResponse.statusCode, 410);

  const badWorkspaceResponse = await app.inject({
    method: "POST",
    url: `/api/tasks/${taskId}/workspaces`,
    payload: {
      cleanupPolicy: "delete_everything"
    }
  });
  assert.equal(badWorkspaceResponse.statusCode, 410);

  const badReviewIntentResponse = await app.inject({
    method: "POST",
    url: `/api/tasks/${taskId}/review-intents`,
    payload: {
      intentType: "approve_without_review"
    }
  });
  assert.equal(badReviewIntentResponse.statusCode, 400);

  const intentResponse = await app.inject({
    method: "POST",
    url: `/api/tasks/${taskId}/review-intents`,
    payload: {
      intentType: "request_replan"
    }
  });
  assert.equal(intentResponse.statusCode, 201);

  const badConsumeResponse = await app.inject({
    method: "POST",
    url: `/api/review-intents/${intentResponse.json().id as string}/consume`,
    payload: {
      consumer: "su-review",
      result: "considered",
      status: "archived"
    }
  });
  assert.equal(badConsumeResponse.statusCode, 400);

  await app.close();
}

async function testIndexerScansCcbAndNumberedDocsWithoutDecisionTasks(): Promise<void> {
  const app = buildApp({
    projectStore: new PrismaProjectStore(prisma)
  });

  await resetDatabase();
  const { projectRoot } = await createIndexerCoverageProject();
  const createResponse = await app.inject({
    method: "POST",
    url: "/api/projects",
    payload: {
      name: "Indexer Coverage Project",
      localPath: projectRoot.replace(/\\/g, "/"),
      summary: "用于验证 indexer 双范围扫描和任务派生过滤"
    }
  });
  assert.equal(createResponse.statusCode, 201);
  const projectId = createResponse.json().id as string;

  const scanResponse = await app.inject({
    method: "POST",
    url: `/api/projects/${projectId}/scan`
  });
  assert.equal(scanResponse.statusCode, 202);
  assert.equal(scanResponse.json().status, "scanning");
  await waitForProjectScanComplete(projectId);

  const documentsResponse = await app.inject({
    method: "GET",
    url: `/api/projects/${projectId}/documents`
  });
  assert.equal(documentsResponse.statusCode, 200);
  const documentPaths = documentsResponse.json().items.map((item: { path: string }) => item.path);
  assert.equal(documentPaths.includes("docs/03_开发计划/user-login-开发任务.md"), true);
  assert.equal(documentPaths.includes("docs/06_决策记录/ADR-0001-test-decision.md"), true);
  assert.equal(documentPaths.includes("docs/01_架构设计/console-design.md"), true);
  assert.equal(documentPaths.includes("docs/05_经验沉淀/reference-note.md"), true);

  const tasksResponse = await app.inject({
    method: "GET",
    url: `/api/projects/${projectId}/tasks`
  });
  assert.equal(tasksResponse.statusCode, 200);
  assert.deepEqual(
    tasksResponse.json().items.map((item: { taskKey: string }) => item.taskKey),
    ["task-user-login"]
  );

  await app.close();
}

async function testConsoleTaskProjectionBugfixRegressions(): Promise<void> {
  const app = buildApp({
    projectStore: new PrismaProjectStore(prisma)
  });

  await resetDatabase();
  const { projectRoot } = await createProjectionBugfixProject();
  const createResponse = await app.inject({
    method: "POST",
    url: "/api/projects",
    payload: {
      name: "Projection Bugfix Project",
      localPath: projectRoot.replace(/\\/g, "/"),
      summary: "用于验证 Console task projection 的 G1-G6 回归"
    }
  });
  assert.equal(createResponse.statusCode, 201);
  const projectId = createResponse.json().id as string;

  const scanResponse = await app.inject({
    method: "POST",
    url: `/api/projects/${projectId}/scan`
  });
  assert.equal(scanResponse.statusCode, 202);
  assert.equal(scanResponse.json().status, "scanning");
  await waitForProjectScanComplete(projectId);

  const healthResponse = await app.inject({
    method: "GET",
    url: `/api/projects/${projectId}/index-health`
  });
  assert.equal(healthResponse.statusCode, 200);
  assert.equal(healthResponse.json().taskCount, 1);

  const documentsResponse = await app.inject({
    method: "GET",
    url: `/api/projects/${projectId}/documents`
  });
  const weirdKindDocument = documentsResponse
    .json()
    .items.find((item: { path: string }) => item.path.endsWith("weird-kind-开发任务.md"));
  assert.equal(weirdKindDocument.kind, "dev_task");

  const tasksResponse = await app.inject({
    method: "GET",
    url: `/api/projects/${projectId}/tasks`
  });
  assert.equal(tasksResponse.statusCode, 200);
  assert.equal(tasksResponse.json().items.length, 1);
  const tasksByKey = new Map(tasksResponse.json().items.map((item: { taskKey: string }) => [item.taskKey, item]));

  assert.equal(tasksByKey.has("state-only-epic"), false);
  assert.equal(tasksByKey.has("unknown-status"), false);

  await app.close();
}

test("项目文档、任务与需求主链路保持可用", async () => {
  await testProjectDocumentTaskAndRequirementFlow();
}, 10_000);

test("scan-status exposes phase fields and real scan counts", async () => {
  await testProjectScanStatusExposesPhaseFieldsAndRealCounts();
});

test("startProjectScan 早抛失败会释放 scanning 并允许再次认领", async () => {
  await testStartProjectScanEarlyFailureReleasesScanningClaim();
});

test("非法项目创建参数返回 400", async () => {
  await testRejectInvalidProjectCreation();
});

test("需求生成任务后 workspace 入口退役且 review intent 可用", async () => {
  await testRequirementTaskRetiredWorkspaceAndIntentIntegration();
});

test("ReviewIntent bridge consume 契约保持 intent state machine 独立", async () => {
  await testReviewIntentBridgeConsumeContract();
});

test("generate-task endpoint returns 410 after SP-B15", async () => {
  await testGenerateTaskEndpointRetired();
});

test("缺失资源路由返回 404", async () => {
  await testMissingResourceRoutesReturnNotFound();
});

test("路由参数校验失败返回 400", async () => {
  await testRouteValidationErrorsReturnBadRequest();
});

test("indexer 同时扫描 .ccb 和主 docs 且不从 decision 派生任务", async () => {
  await testIndexerScansCcbAndNumberedDocsWithoutDecisionTasks();
});

test("Console 任务投影修复覆盖 G1-G6 与 F7 forward-compat", async () => {
  await testConsoleTaskProjectionBugfixRegressions();
});

afterAll(async () => {
  await prisma.$disconnect();
});
