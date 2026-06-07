import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, test } from "vitest";

import { prisma } from "../../db/prisma.js";
import {
  reindexBreakdownDraftForRequirement,
  reindexRequirementScope,
  reindexRequirementDesignDocFromMarkdown
} from "./requirement-reindex.service.js";

const PROJECT_PREFIX = "requirement-reindex-";
const createdRoots: string[] = [];

async function createProjectFixture() {
  const localPath = join(tmpdir(), `${PROJECT_PREFIX}${randomUUID()}`);
  await mkdir(localPath, { recursive: true });
  createdRoots.push(localPath);
  const project = await prisma.project.create({
    data: {
      name: `${PROJECT_PREFIX}${randomUUID()}`,
      localPath
    }
  });
  return { project, localPath };
}

async function createRequirement(projectId: string, id: string, planDocPath: string | null = null) {
  return await prisma.requirement.create({
    data: {
      id,
      projectId,
      title: `Requirement ${id}`,
      description: "fixture requirement",
      status: "planning",
      planDocPath
    }
  });
}

async function writeDesignDoc(projectRoot: string, requirementId: string, relativePath: string) {
  const absolutePath = join(projectRoot, relativePath);
  await mkdir(join(absolutePath, ".."), { recursive: true });
  await writeFile(
    absolutePath,
    `---\ndoc_type: technical_design\nrequirement_id: ${requirementId}\ntitle: Design ${requirementId}\n---\n\n# Design\n\nBody.\n`,
    "utf8"
  );
  return absolutePath;
}

async function writeRequirementDoc(projectRoot: string, requirementId: string, title = `Requirement ${requirementId}`) {
  const relativePath = `docs/02_需求设计/${requirementId}-需求.md`;
  const absolutePath = join(projectRoot, relativePath);
  await mkdir(join(absolutePath, ".."), { recursive: true });
  await writeFile(
    absolutePath,
    [
      "---",
      "doc_type: requirement",
      `id: ${requirementId}`,
      `title: ${title}`,
      "status: planning",
      "---",
      "",
      "## 需求描述",
      "",
      "需求级 reindex fixture.",
      ""
    ].join("\n"),
    "utf8"
  );
  return absolutePath;
}

async function writeDevTaskDoc(projectRoot: string, requirementId: string, taskId: string, title = "Scoped Dev Task") {
  const relativePath = `docs/03_开发计划/${taskId}-开发任务.md`;
  const absolutePath = join(projectRoot, relativePath);
  await mkdir(join(absolutePath, ".."), { recursive: true });
  await writeFile(
    absolutePath,
    [
      "---",
      "doc_type: dev_task",
      `task_id: ${taskId}`,
      `title: ${title}`,
      "status: reviewing",
      "current_node: dispatch",
      "node_substate: awaiting_codex_pickup",
      "priority: high",
      `requirement_id: ${requirementId}`,
      "section_id: pr1-scoped-reindex",
      "order: 1",
      "implementation_owner: ccb_codex",
      "dependencies: []",
      `source_breakdown_draft: docs/.ccb/drafts/breakdown/${requirementId}.json`,
      `source_draft_hash: ${"a".repeat(64)}`,
      "created_at: 2026-05-22T10:00:00.000Z",
      "---",
      "",
      "## Scoped Reindex",
      "",
      "- Project this dev_task into the Task table for the requirement detail page.",
      "- Keep the fixture long enough for schema validation.",
      ""
    ].join("\n"),
    "utf8"
  );
  return absolutePath;
}

function draftFixture(projectId: string, requirementId: string) {
  return {
    schema_version: "breakdown-draft-v0.2",
    status: "draft",
    project_id: projectId,
    requirement_id: requirementId,
    carrier_task_id: requirementId,
    carrier_task_key: requirementId,
    base_task_revision: null,
    generated_at: "2026-05-25T00:00:00.000Z",
    updated_at: "2026-05-25T00:00:00.000Z",
    generated_by: "ai_session",
    generation_source: {
      cc_agent: "slot1_claude"
    },
    plan: {
      title: "Plan",
      summary: "Summary",
      spec_outline_md: "## Outline"
    },
    subtasks: [
      {
        section_id: "S1",
        order: 1,
        title: "Slice 1",
        summary: "Do the first slice",
        spec_section_md: "## Slice 1",
        priority: "medium",
        implementation_owner: "claude",
        dependencies: [],
        include: true
      }
    ],
    review_history: [
      {
        at: "2026-05-25T00:00:00.000Z",
        actor: "ai",
        action: "created"
      }
    ]
  };
}

afterEach(async () => {
  await prisma.project.deleteMany({
    where: {
      name: {
        startsWith: PROJECT_PREFIX
      }
    }
  });
  for (const root of createdRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

test("reindexRequirementDesignDocFromMarkdown projects one design file without clearing other requirements", async () => {
  const { project, localPath } = await createProjectFixture();
  await createRequirement(project.id, "req-design-1");
  await createRequirement(project.id, "req-design-2", "docs/03_开发计划/existing-design.md");
  const designPath = await writeDesignDoc(
    localPath,
    "req-design-1",
    "docs/03_开发计划/2026-05-25-req-design-1-技术设计.md"
  );

  const result = await reindexRequirementDesignDocFromMarkdown(prisma, project.id, designPath, "req-design-1");

  assert.deepEqual(result, {
    reindexed: true,
    requirementId: "req-design-1",
    planDocPath: "docs/03_开发计划/2026-05-25-req-design-1-技术设计.md"
  });
  const first = await prisma.requirement.findUniqueOrThrow({ where: { id: "req-design-1" } });
  const second = await prisma.requirement.findUniqueOrThrow({ where: { id: "req-design-2" } });
  assert.equal(first.planDocPath, "docs/03_开发计划/2026-05-25-req-design-1-技术设计.md");
  assert.equal(second.planDocPath, "docs/03_开发计划/existing-design.md");
});

test("reindexRequirementDesignDocFromMarkdown rejects path escapes and mismatched requirement ids", async () => {
  const { project, localPath } = await createProjectFixture();
  await createRequirement(project.id, "req-design-safe");
  const designPath = await writeDesignDoc(
    localPath,
    "another-requirement",
    "docs/03_开发计划/2026-05-25-mismatch-技术设计.md"
  );

  await assert.rejects(
    () => reindexRequirementDesignDocFromMarkdown(prisma, project.id, join(tmpdir(), "outside-design.md"), "req-design-safe"),
    /path escapes project root/
  );
  await assert.rejects(
    () => reindexRequirementDesignDocFromMarkdown(prisma, project.id, designPath, "req-design-safe"),
    /requirement_id mismatch/
  );
});

test("reindexRequirementScope covers requirement md, design doc, breakdown draft, and dev_task projection", async () => {
  const { project, localPath } = await createProjectFixture();
  await createRequirement(project.id, "req-scope-1");
  await writeRequirementDoc(localPath, "req-scope-1", "Scoped Reindex Requirement");
  await writeDesignDoc(localPath, "req-scope-1", "docs/03_开发计划/req-scope-1-技术设计.md");
  await writeDevTaskDoc(localPath, "req-scope-1", "subtask-scope-1");
  const draftDir = join(localPath, "docs", ".ccb", "drafts", "breakdown");
  await mkdir(draftDir, { recursive: true });
  await writeFile(
    join(draftDir, "req-scope-1.json"),
    `${JSON.stringify(
      {
        ...draftFixture(project.id, "req-scope-1"),
        status: "approved",
        approved_at: "2026-05-25T01:00:00.000Z",
        approved_by: "reviewer"
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = await reindexRequirementScope(prisma, project.id, "req-scope-1", { debounceMs: 0 });

  assert.equal(result.status, "success");
  assert.equal(result.deduped, false);
  assert.equal(result.requirementMarkdown?.upsertedCount, 1);
  assert.equal(result.designDocs.length, 1);
  assert.equal(result.breakdownDraft?.breakdownDraftPath, "docs/.ccb/drafts/breakdown/req-scope-1.json");
  assert.equal(result.devTasks.documentCount, 1);
  assert.equal(result.devTasks.taskCount, 1);
  assert.deepEqual(result.issues, []);

  const requirement = await prisma.requirement.findUniqueOrThrow({ where: { id: "req-scope-1" } });
  assert.equal(requirement.title, "Scoped Reindex Requirement");
  assert.equal(requirement.planDocPath, "docs/03_开发计划/req-scope-1-技术设计.md");
  assert.equal(requirement.breakdownDraftPath, "docs/.ccb/drafts/breakdown/req-scope-1.json");
  assert.equal(requirement.currentPlanningStep, "ready_to_materialize");

  const documents = await prisma.document.findMany({
    where: { projectId: project.id },
    orderBy: { path: "asc" }
  });
  assert.deepEqual(
    documents.map((document) => [document.kind, document.path]),
    [
      ["requirement", "docs/02_需求设计/req-scope-1-需求.md"],
      ["technical_design", "docs/03_开发计划/req-scope-1-技术设计.md"],
      ["dev_task", "docs/03_开发计划/subtask-scope-1-开发任务.md"]
    ]
  );

  const task = await prisma.task.findUniqueOrThrow({
    where: {
      projectId_taskKey: {
        projectId: project.id,
        taskKey: "subtask-scope-1"
      }
    }
  });
  assert.equal(task.requirementId, "req-scope-1");
  assert.equal(task.title, "Scoped Dev Task");
  assert.equal(task.currentNode, "dispatch");
  assert.equal(task.specSectionId, "pr1-scoped-reindex");
  assert.ok(task.primaryDocumentId);
});

test("reindexRequirementScope ignores template docs with placeholder requirement ids", async () => {
  const { project, localPath } = await createProjectFixture();
  await createRequirement(project.id, "req-template-target");
  await writeRequirementDoc(localPath, "req-template-target", "Template Target Requirement");
  const planDir = join(localPath, "docs", "03_开发计划");
  await mkdir(planDir, { recursive: true });
  await writeFile(
    join(planDir, "_模板_技术设计.md"),
    [
      "---",
      "doc_type: technical_design",
      "requirement_id: <由系统生成>",
      "title: Template Design",
      "---",
      "",
      "## 一、设计概述",
      "",
      "模板内容。"
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    join(planDir, "_模板_开发任务.md"),
    [
      "---",
      "doc_type: dev_task",
      "task_id: <由系统生成>",
      "title: Template Task",
      "status: reviewing",
      "current_node: dispatch",
      "node_substate: awaiting_codex_pickup",
      "priority: medium",
      "requirement_id: <由系统生成>",
      "section_id: template",
      "order: 1",
      "implementation_owner: ccb_codex",
      "dependencies: []",
      "source_breakdown_draft: docs/.ccb/drafts/breakdown/<requirement_id>.json",
      `source_draft_hash: ${"a".repeat(64)}`,
      "created_at: 2026-05-22T10:00:00.000Z",
      "---",
      "",
      "## 一、任务概述",
      "",
      "模板内容。"
    ].join("\n"),
    "utf8"
  );

  const result = await reindexRequirementScope(prisma, project.id, "req-template-target", { debounceMs: 0 });

  assert.equal(result.status, "success");
  assert.equal(result.designDocs.length, 0);
  assert.equal(result.devTasks.documentCount, 0);
  assert.equal(await prisma.document.count({ where: { projectId: project.id, path: { contains: "_模板_" } } }), 0);
});

test("reindexRequirementScope dedupes concurrent requests and reports stale task orphans without deleting them", async () => {
  const { project, localPath } = await createProjectFixture();
  await createRequirement(project.id, "req-scope-2");
  await writeRequirementDoc(localPath, "req-scope-2", "Concurrent Reindex Requirement");
  await prisma.task.create({
    data: {
      projectId: project.id,
      taskKey: "subtask-orphan-1",
      title: "Orphan task",
      status: "reviewing",
      requirementId: "req-scope-2"
    }
  });

  const [first, second] = await Promise.all([
    reindexRequirementScope(prisma, project.id, "req-scope-2", { debounceMs: 0 }),
    reindexRequirementScope(prisma, project.id, "req-scope-2", { debounceMs: 0 })
  ]);

  assert.equal(first.deduped, false);
  assert.equal(second.deduped, true);
  assert.equal(first.status, "partial");
  assert.equal(first.devTasks.orphanCount, 1);
  assert.equal(first.issues.some((issue) => issue.reason === "stale_task_projection_orphan"), true);
  assert.equal(await prisma.task.count({ where: { projectId: project.id, taskKey: "subtask-orphan-1" } }), 1);
});

test("reindexBreakdownDraftForRequirement projects and clears only the targeted requirement", async () => {
  const { project, localPath } = await createProjectFixture();
  await createRequirement(project.id, "req-draft-1");
  await createRequirement(project.id, "req-draft-2", null);
  await prisma.requirement.update({
    where: { id: "req-draft-2" },
    data: { breakdownDraftPath: "docs/.ccb/drafts/breakdown/req-draft-2.json" }
  });
  const draftDir = join(localPath, "docs", ".ccb", "drafts", "breakdown");
  await mkdir(draftDir, { recursive: true });
  await writeFile(
    join(draftDir, "req-draft-1.json"),
    `${JSON.stringify(draftFixture(project.id, "req-draft-1"), null, 2)}\n`,
    "utf8"
  );

  const projected = await reindexBreakdownDraftForRequirement(prisma, project.id, "req-draft-1");

  assert.deepEqual(projected, {
    reindexed: true,
    requirementId: "req-draft-1",
    breakdownDraftPath: "docs/.ccb/drafts/breakdown/req-draft-1.json",
    cleared: false
  });
  const first = await prisma.requirement.findUniqueOrThrow({ where: { id: "req-draft-1" } });
  const second = await prisma.requirement.findUniqueOrThrow({ where: { id: "req-draft-2" } });
  assert.equal(first.breakdownDraftPath, "docs/.ccb/drafts/breakdown/req-draft-1.json");
  assert.equal(second.breakdownDraftPath, "docs/.ccb/drafts/breakdown/req-draft-2.json");

  await rm(join(draftDir, "req-draft-1.json"));
  const cleared = await reindexBreakdownDraftForRequirement(prisma, project.id, "req-draft-1");
  assert.equal(cleared.cleared, true);
  const clearedFirst = await prisma.requirement.findUniqueOrThrow({ where: { id: "req-draft-1" } });
  const retainedSecond = await prisma.requirement.findUniqueOrThrow({ where: { id: "req-draft-2" } });
  assert.equal(clearedFirst.breakdownDraftPath, null);
  assert.equal(retainedSecond.breakdownDraftPath, "docs/.ccb/drafts/breakdown/req-draft-2.json");
});

test("reindexBreakdownDraftForRequirement ignores legacy project_id mismatches", async () => {
  const { project, localPath } = await createProjectFixture();
  await createRequirement(project.id, "req-draft-legacy");
  const draftDir = join(localPath, "docs", ".ccb", "drafts", "breakdown");
  await mkdir(draftDir, { recursive: true });
  const legacyConsumedDraft = {
    ...draftFixture("old-console-project", "req-draft-legacy"),
    status: "consumed",
    consumed_at: "2026-05-25T01:00:00.000Z",
    consumed_by: "ccb_claude",
    consumed_from_hash: "a".repeat(64)
  };
  await writeFile(
    join(draftDir, "req-draft-legacy.json"),
    `${JSON.stringify(legacyConsumedDraft, null, 2)}\n`,
    "utf8"
  );

  const projected = await reindexBreakdownDraftForRequirement(prisma, project.id, "req-draft-legacy");

  assert.deepEqual(projected, {
    reindexed: true,
    requirementId: "req-draft-legacy",
    breakdownDraftPath: "docs/.ccb/drafts/breakdown/req-draft-legacy.json",
    cleared: false
  });
  const requirement = await prisma.requirement.findUniqueOrThrow({ where: { id: "req-draft-legacy" } });
  assert.equal(requirement.breakdownDraftPath, "docs/.ccb/drafts/breakdown/req-draft-legacy.json");
  assert.equal(requirement.currentPlanningStep, "ready_to_materialize");
});
