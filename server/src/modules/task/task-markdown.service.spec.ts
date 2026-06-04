import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

import type { Document, Project, Task } from "@prisma/client";
import { afterEach, test } from "vitest";

import { prisma } from "../../db/prisma.js";
import { loadTaskMarkdownBody, TaskMarkdownNotFoundError } from "./task-markdown.service.js";

const createdProjectIds: string[] = [];
const createdTempPaths: string[] = [];

async function createTaskFixture(): Promise<{ project: Project; task: Task; projectRoot: string }> {
  const suffix = randomUUID();
  const projectRoot = await mkdtemp(join(tmpdir(), "ccb-task-markdown-"));
  createdTempPaths.push(projectRoot);
  const project = await prisma.project.create({
    data: {
      name: `task-markdown-${suffix}`,
      localPath: projectRoot
    }
  });
  createdProjectIds.push(project.id);
  const task = await prisma.task.create({
    data: {
      projectId: project.id,
      taskKey: `task-${suffix}`,
      title: "Markdown task",
      status: "reviewing"
    }
  });

  return { project, task, projectRoot };
}

async function createDevTaskDocument(input: {
  projectId: string;
  taskKey: string;
  path: string;
  projectRoot: string;
  content?: string;
}): Promise<Document> {
  if (input.content !== undefined) {
    const absolutePath = isAbsolute(input.path) ? input.path : join(input.projectRoot, input.path);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, input.content, "utf8");
  }

  return await prisma.document.create({
    data: {
      projectId: input.projectId,
      taskKey: input.taskKey,
      path: input.path,
      kind: "dev_task",
      title: input.path,
      status: "reviewing",
      frontmatterJson: JSON.stringify({ doc_type: "dev_task", task_id: input.taskKey }),
      contentHash: randomUUID(),
      mtime: new Date()
    }
  });
}

afterEach(async () => {
  for (const projectId of createdProjectIds.splice(0)) {
    await prisma.project.deleteMany({
      where: {
        id: projectId
      }
    });
  }
  await Promise.all(createdTempPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test("loadTaskMarkdownBody returns primary dev_task body without frontmatter", async () => {
  const { project, task, projectRoot } = await createTaskFixture();
  const primary = await createDevTaskDocument({
    projectId: project.id,
    taskKey: task.taskKey,
    projectRoot,
    path: "docs/03_开发计划/primary-开发任务.md",
    content: "---\ndoc_type: dev_task\n---\n## Primary\n\n正文"
  });
  await prisma.task.update({
    where: {
      id: task.id
    },
    data: {
      primaryDocumentId: primary.id
    }
  });

  const result = await loadTaskMarkdownBody(prisma, project.id, task.id);

  assert.equal(result.path, primary.path);
  assert.equal(result.content, "## Primary\n\n正文");
});

test("loadTaskMarkdownBody ignores dirty primary taskKey and falls back by taskKey", async () => {
  const { project, task, projectRoot } = await createTaskFixture();
  const dirtyPrimary = await createDevTaskDocument({
    projectId: project.id,
    taskKey: "other-task",
    projectRoot,
    path: "docs/03_开发计划/other-开发任务.md",
    content: "---\ndoc_type: dev_task\n---\n# Wrong"
  });
  const fallback = await createDevTaskDocument({
    projectId: project.id,
    taskKey: task.taskKey,
    projectRoot,
    path: "docs/03_开发计划/fallback-开发任务.md",
    content: "---\ndoc_type: dev_task\n---\n# Fallback"
  });
  await prisma.task.update({
    where: {
      id: task.id
    },
    data: {
      primaryDocumentId: dirtyPrimary.id
    }
  });

  const result = await loadTaskMarkdownBody(prisma, project.id, task.id);

  assert.equal(result.path, fallback.path);
  assert.equal(result.content, "# Fallback");
});

test("loadTaskMarkdownBody falls back when primary file is missing", async () => {
  const { project, task, projectRoot } = await createTaskFixture();
  const primary = await createDevTaskDocument({
    projectId: project.id,
    taskKey: task.taskKey,
    projectRoot,
    path: "docs/03_开发计划/missing-primary-开发任务.md"
  });
  const fallback = await createDevTaskDocument({
    projectId: project.id,
    taskKey: task.taskKey,
    projectRoot,
    path: "docs/03_开发计划/readable-fallback-开发任务.md",
    content: "---\ndoc_type: dev_task\n---\n# Readable fallback"
  });
  await prisma.task.update({
    where: {
      id: task.id
    },
    data: {
      primaryDocumentId: primary.id
    }
  });

  const result = await loadTaskMarkdownBody(prisma, project.id, task.id);

  assert.equal(result.path, fallback.path);
  assert.equal(result.content, "# Readable fallback");
});

test("loadTaskMarkdownBody rejects escaped and absolute document paths", async () => {
  const { project, task, projectRoot } = await createTaskFixture();
  const escapedName = `escaped-${randomUUID()}.md`;
  const escapedAbsolutePath = join(projectRoot, "..", escapedName);
  createdTempPaths.push(escapedAbsolutePath);
  await writeFile(escapedAbsolutePath, "# Escaped content", "utf8");
  const absoluteInsideRoot = join(projectRoot, "docs", "03_开发计划", "absolute-开发任务.md");

  await createDevTaskDocument({
    projectId: project.id,
    taskKey: task.taskKey,
    projectRoot,
    path: `../${escapedName}`
  });
  await createDevTaskDocument({
    projectId: project.id,
    taskKey: task.taskKey,
    projectRoot,
    path: absoluteInsideRoot,
    content: "# Absolute content"
  });

  await assert.rejects(
    () => loadTaskMarkdownBody(prisma, project.id, task.id),
    (error) => error instanceof TaskMarkdownNotFoundError
  );
});

test("loadTaskMarkdownBody returns NotFound when no readable dev_task document exists", async () => {
  const { project, task } = await createTaskFixture();

  await assert.rejects(
    () => loadTaskMarkdownBody(prisma, project.id, task.id),
    (error) => error instanceof TaskMarkdownNotFoundError
  );
});

test("loadTaskMarkdownBody keeps an empty markdown body as a successful result", async () => {
  const { project, task, projectRoot } = await createTaskFixture();
  const document = await createDevTaskDocument({
    projectId: project.id,
    taskKey: task.taskKey,
    projectRoot,
    path: "docs/03_开发计划/empty-开发任务.md",
    content: "---\ndoc_type: dev_task\n---\n"
  });

  const result = await loadTaskMarkdownBody(prisma, project.id, task.id);

  assert.equal(result.path, document.path);
  assert.equal(result.content, "");
});
