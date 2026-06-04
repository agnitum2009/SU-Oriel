import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";

import type { Document, PrismaClient } from "@prisma/client";

import { extractMarkdownBody } from "../../lib/markdown.js";
import { resolveProjectPath } from "../../lib/project-path.js";

export class TaskMarkdownNotFoundError extends Error {
  constructor(message = "任务文档不存在或尚未进入索引") {
    super(message);
  }
}

export interface TaskMarkdownBody {
  path: string;
  content: string;
}

type TaskMarkdownDocument = Pick<Document, "id" | "path">;

export async function loadTaskMarkdownBody(
  prisma: PrismaClient,
  projectId: string,
  taskId: string
): Promise<TaskMarkdownBody> {
  const task = await prisma.task.findFirst({
    where: {
      id: taskId,
      projectId
    },
    include: {
      project: true
    }
  });
  if (!task) {
    throw new TaskMarkdownNotFoundError();
  }

  const candidates: TaskMarkdownDocument[] = [];
  if (task.primaryDocumentId) {
    const primary = await prisma.document.findFirst({
      where: {
        id: task.primaryDocumentId,
        projectId,
        kind: "dev_task",
        taskKey: task.taskKey
      },
      select: {
        id: true,
        path: true
      }
    });
    if (primary) {
      candidates.push(primary);
    }
  }

  const selectedIds = candidates.map((document) => document.id);
  const fallback = await prisma.document.findMany({
    where: {
      projectId,
      taskKey: task.taskKey,
      kind: "dev_task",
      ...(selectedIds.length > 0 ? { NOT: { id: { in: selectedIds } } } : {})
    },
    orderBy: {
      path: "asc"
    },
    select: {
      id: true,
      path: true
    }
  });
  candidates.push(...fallback);

  for (const document of candidates) {
    try {
      if (isAbsolute(document.path)) {
        continue;
      }
      const { absolutePath } = resolveProjectPath(task.project.localPath, document.path);
      const raw = await readFile(absolutePath, "utf8");
      return {
        path: document.path,
        content: extractMarkdownBody(raw)
      };
    } catch {
      // 投影可能过期或路径脏；继续尝试下一个 canonical 候选。
    }
  }

  throw new TaskMarkdownNotFoundError();
}
