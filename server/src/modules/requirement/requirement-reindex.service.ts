import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import type { PrismaClient } from "@prisma/client";
import { ZodError } from "zod";

import { breakdownDraftSchema, type BreakdownDraft } from "../breakdown-draft/breakdown-draft.schema.js";
import { parseDocument, type ParsedDocumentRecord } from "../../indexer/document-parser.js";
import { getDocsStructureResolverForProject } from "../../indexer/docs-structure-resolver.js";
import {
  deriveTasks,
  syncRequirementsFromMarkdown,
  upsertDocumentProjectionAsync,
  upsertTaskProjectionAsync,
  type DeriveTaskDocument,
  type VerifyAnomaly
} from "../../indexer/project-indexer.js";
import { resolveProjectPath } from "../../lib/project-path.js";
import { primitiveExecutor } from "../primitive/primitive-wrapper.js";
import { findRequirementMarkdown, RequirementEditNotFoundError } from "./requirement-edit.service.js";

const DEFAULT_REQUIREMENT_REINDEX_DEBOUNCE_MS = 1_000;

export interface RequirementReindexResult {
  reindexed: boolean;
  upsertedCount: number;
  issues: Array<{ path: string; reason: string; detail?: string }>;
}

export interface RequirementDesignDocReindexResult {
  reindexed: boolean;
  requirementId: string;
  planDocPath: string;
}

export interface BreakdownDraftReindexResult {
  reindexed: boolean;
  requirementId: string;
  breakdownDraftPath: string | null;
  cleared: boolean;
}

export interface RequirementScopedReindexIssue {
  path: string;
  reason: string;
  detail?: string;
}

export interface RequirementDevTaskReindexResult {
  reindexed: boolean;
  requirementId: string;
  documentCount: number;
  taskCount: number;
  orphanCount: number;
  issues: RequirementScopedReindexIssue[];
}

export interface RequirementScopedReindexResult {
  reindexed: boolean;
  deduped: boolean;
  status: "success" | "partial";
  projectId: string;
  requirementId: string;
  requirementMarkdown: RequirementReindexResult | null;
  designDocs: RequirementDesignDocReindexResult[];
  breakdownDraft: BreakdownDraftReindexResult | null;
  devTasks: RequirementDevTaskReindexResult;
  issues: RequirementScopedReindexIssue[];
}

interface RequirementScopedReindexOptions {
  debounceMs?: number;
}

const inFlightRequirementReindexes = new Map<string, Promise<RequirementScopedReindexResult>>();
const recentRequirementReindexes = new Map<string, { completedAt: number; result: RequirementScopedReindexResult }>();

export async function reindexRequirementFromMarkdown(
  prisma: PrismaClient,
  projectId: string,
  requirementId: string
): Promise<RequirementReindexResult> {
  const project = await prisma.project.findUnique({
    where: {
      id: projectId
    },
    select: {
      localPath: true
    }
  });
  if (!project) {
    throw new RequirementEditNotFoundError("项目不存在");
  }

  const md = await findRequirementMarkdown(project.localPath, requirementId);
  const parsed = parseDocument({
    relativePath: md.relativePath,
    content: md.content,
    mtime: (await stat(md.absolutePath)).mtime
  });

  const result = await prisma.$transaction(async (tx) => {
    await upsertDocumentProjectionAsync(tx, projectId, parsed);
    return await syncRequirementsFromMarkdown(tx, projectId, project.localPath, [parsed], [md.absolutePath]);
  });

  return {
    reindexed: result.upsertedCount > 0,
    upsertedCount: result.upsertedCount,
    issues: result.issues
  };
}

export async function reindexRequirementDesignDocFromMarkdown(
  prisma: PrismaClient,
  projectId: string,
  filePath: string,
  expectedRequirementId: string
): Promise<RequirementDesignDocReindexResult> {
  const projectRoot = await loadProjectRoot(prisma, projectId);
  const { absolutePath, relativePath } = resolveProjectPath(projectRoot, filePath);
  if (!relativePath.startsWith("docs/03_开发计划/")) {
    throw new Error(`technical design path must be under docs/03_开发计划/: ${relativePath}`);
  }

  const content = await readFile(absolutePath, "utf8");
  const parsed = parseDocument({
    relativePath,
    content,
    mtime: (await stat(absolutePath)).mtime
  });
  await upsertDocumentProjectionAsync(prisma, projectId, parsed);
  if (parsed.parseStatus !== "success") {
    throw new Error(`technical design frontmatter invalid: ${parsed.parseError ?? parsed.parseStatus}`);
  }
  if (parsed.frontmatter.doc_type !== "technical_design") {
    throw new Error(`technical design doc_type mismatch: ${parsed.frontmatter.doc_type ?? ""}`);
  }
  const requirementId = parsed.frontmatter.requirement_id?.trim();
  if (!requirementId) {
    throw new Error("technical design requirement_id missing");
  }
  if (requirementId !== expectedRequirementId) {
    throw new Error(`technical design requirement_id mismatch: ${requirementId} != ${expectedRequirementId}`);
  }
  if (extractMarkdownBody(content).trim().length === 0) {
    throw new Error("technical design body is empty");
  }

  const requirement = await prisma.requirement.findFirst({
    where: {
      id: requirementId,
      projectId
    },
    select: {
      id: true
    }
  });
  if (!requirement) {
    throw new RequirementEditNotFoundError("需求不存在");
  }

  await primitiveExecutor.run({
    primitive: "requirement.reindex",
    mutationType: "prisma.requirement.update",
    run: async () =>
      await prisma.requirement.update({
        where: {
          id: requirement.id
        },
        data: {
          planDocPath: relativePath
        }
      })
  });

  return {
    reindexed: true,
    requirementId,
    planDocPath: relativePath
  };
}

export async function reindexRequirementScope(
  prisma: PrismaClient,
  projectId: string,
  requirementId: string,
  options: RequirementScopedReindexOptions = {}
): Promise<RequirementScopedReindexResult> {
  const key = `${projectId}:${requirementId}`;
  const debounceMs = options.debounceMs ?? DEFAULT_REQUIREMENT_REINDEX_DEBOUNCE_MS;
  const cached = recentRequirementReindexes.get(key);
  if (cached && Date.now() - cached.completedAt <= debounceMs) {
    return { ...cached.result, deduped: true };
  }

  const inFlight = inFlightRequirementReindexes.get(key);
  if (inFlight) {
    const result = await inFlight;
    return { ...result, deduped: true };
  }

  const promise = runRequirementScopeReindex(prisma, projectId, requirementId);
  inFlightRequirementReindexes.set(key, promise);
  try {
    const result = await promise;
    recentRequirementReindexes.set(key, { completedAt: Date.now(), result });
    trimRecentRequirementReindexCache();
    return result;
  } finally {
    inFlightRequirementReindexes.delete(key);
  }
}

async function runRequirementScopeReindex(
  prisma: PrismaClient,
  projectId: string,
  requirementId: string
): Promise<RequirementScopedReindexResult> {
  const projectRoot = await loadProjectRoot(prisma, projectId);
  const requirement = await prisma.requirement.findFirst({
    where: {
      id: requirementId,
      projectId
    },
    select: {
      id: true
    }
  });
  if (!requirement) {
    throw new RequirementEditNotFoundError("需求不存在");
  }

  const issues: RequirementScopedReindexIssue[] = [];
  let requirementMarkdown: RequirementReindexResult | null = null;
  try {
    requirementMarkdown = await reindexRequirementFromMarkdown(prisma, projectId, requirementId);
    issues.push(...requirementMarkdown.issues.map((issue) => ({ ...issue, reason: `requirement_${issue.reason}` })));
  } catch (error) {
    issues.push(issueFromError(`requirement:${requirementId}`, "requirement_reindex_failed", error));
  }

  const docs03 = await collectPlanMarkdownDocuments(projectRoot);
  const designDocs: RequirementDesignDocReindexResult[] = [];
  for (const doc of docs03.filter(
    (item) => item.frontmatter.doc_type === "technical_design" && item.frontmatter.requirement_id === requirementId
  )) {
    try {
      const designResult = await reindexRequirementDesignDocFromMarkdown(prisma, projectId, doc.path, requirementId);
      designDocs.push(designResult);
    } catch (error) {
      issues.push(issueFromError(doc.path, "technical_design_reindex_failed", error));
    }
  }

  let breakdownDraft: BreakdownDraftReindexResult | null = null;
  try {
    breakdownDraft = await reindexBreakdownDraftForRequirement(prisma, projectId, requirementId);
  } catch (error) {
    issues.push(issueFromError(`docs/.ccb/drafts/breakdown/${safeDraftFileName(requirementId)}`, "breakdown_draft_reindex_failed", error));
  }

  const devTasks = await reindexDevTasksForRequirement(prisma, projectId, projectRoot, requirementId, docs03);
  issues.push(...devTasks.issues);

  const reindexed = Boolean(
    requirementMarkdown?.reindexed ||
      designDocs.length > 0 ||
      breakdownDraft?.reindexed ||
      devTasks.reindexed
  );

  return {
    reindexed,
    deduped: false,
    status: issues.length > 0 ? "partial" : "success",
    projectId,
    requirementId,
    requirementMarkdown,
    designDocs,
    breakdownDraft,
    devTasks,
    issues
  };
}

export async function reindexDevTasksForRequirement(
  prisma: PrismaClient,
  projectId: string,
  projectRoot: string,
  requirementId: string,
  parsedPlanDocs?: ParsedDocumentRecord[]
): Promise<RequirementDevTaskReindexResult> {
  const issues: RequirementScopedReindexIssue[] = [];
  const planDocs = parsedPlanDocs ?? (await collectPlanMarkdownDocuments(projectRoot));
  const devTaskDocs = planDocs
    .filter((doc) => doc.frontmatter.doc_type === "dev_task" && doc.frontmatter.requirement_id === requirementId)
    .sort((left, right) => left.path.localeCompare(right.path));
  const retainedTaskKeys = new Set(devTaskDocs.map((doc) => doc.taskKey).filter(Boolean));
  const persistedTaskDocs: DeriveTaskDocument[] = [];

  for (const doc of devTaskDocs) {
    const persisted = await upsertDocumentProjectionAsync(prisma, projectId, doc);
    if (doc.parseStatus !== "success") {
      issues.push({
        path: doc.path,
        reason: "dev_task_parse_partial",
        detail: doc.parseError ?? "parseStatus != success"
      });
      continue;
    }

    persistedTaskDocs.push({
      id: persisted.id,
      taskKey: persisted.taskKey,
      path: persisted.path,
      kind: persisted.kind,
      title: persisted.title,
      status: persisted.status,
      summary: persisted.summary,
      contentHash: persisted.contentHash,
      frontmatterJson: persisted.frontmatterJson,
      updatedAt: persisted.updatedAt
    });
  }

  const derived = deriveTasks(persistedTaskDocs);
  for (const anomaly of derived.anomalies) {
    issues.push(issueFromAnomaly(anomaly));
    if (anomaly.category === "invalid_current_node") {
      retainedTaskKeys.add(anomaly.taskKey);
    }
  }

  for (const task of derived.tasks) {
    retainedTaskKeys.add(task.taskKey);
    await upsertTaskProjectionAsync(prisma, projectId, task);
  }

  const orphanTasks = await prisma.task.findMany({
    where: {
      projectId,
      requirementId,
      ...(retainedTaskKeys.size > 0
        ? {
            taskKey: {
              notIn: [...retainedTaskKeys]
            }
          }
        : {})
    },
    select: {
      id: true,
      taskKey: true,
      title: true,
      status: true
    },
    orderBy: {
      taskKey: "asc"
    }
  });
  for (const task of orphanTasks) {
    issues.push({
      path: `task:${task.taskKey}`,
      reason: "stale_task_projection_orphan",
      detail: `taskId=${task.id}; title=${task.title}; status=${task.status}`
    });
  }

  return {
    reindexed: devTaskDocs.length > 0 || orphanTasks.length > 0,
    requirementId,
    documentCount: devTaskDocs.length,
    taskCount: derived.tasks.length,
    orphanCount: orphanTasks.length,
    issues
  };
}

export async function reindexBreakdownDraftForRequirement(
  prisma: PrismaClient,
  projectId: string,
  requirementId: string,
  filePath?: string
): Promise<BreakdownDraftReindexResult> {
  const projectRoot = await loadProjectRoot(prisma, projectId);
  const target = filePath
    ? resolveProjectPath(projectRoot, filePath)
    : {
        absolutePath: join(projectRoot, "docs", ".ccb", "drafts", "breakdown", safeDraftFileName(requirementId)),
        relativePath: `docs/.ccb/drafts/breakdown/${safeDraftFileName(requirementId)}`
      };
  if (!target.relativePath.startsWith("docs/.ccb/drafts/breakdown/") || !target.relativePath.endsWith(".json")) {
    throw new Error(`breakdown draft path must be under docs/.ccb/drafts/breakdown/: ${target.relativePath}`);
  }

  const requirement = await prisma.requirement.findFirst({
    where: {
      id: requirementId,
      projectId
    },
    select: {
      id: true
    }
  });
  if (!requirement) {
    throw new RequirementEditNotFoundError("需求不存在");
  }

  let content: string;
  try {
    content = await readFile(target.absolutePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    await primitiveExecutor.run({
      primitive: "requirement.reindex",
      mutationType: "prisma.requirement.update",
      run: async () =>
        await prisma.requirement.update({
          where: {
            id: requirement.id
          },
          data: {
            breakdownDraftPath: null,
            currentPlanningStep: "breakdown_draft",
            planningRuntimeState: "idle"
          }
        })
    });
    return {
      reindexed: true,
      requirementId,
      breakdownDraftPath: null,
      cleared: true
    };
  }

  let draft: BreakdownDraft;
  try {
    draft = breakdownDraftSchema.parse(JSON.parse(content));
  } catch (error) {
    const detail =
      error instanceof ZodError
        ? error.issues.map((issue) => issue.message).join("; ")
        : error instanceof Error
          ? error.message
          : String(error);
    throw new Error(`breakdown draft invalid: ${detail}`);
  }
  if (draft.requirement_id !== requirementId) {
    throw new Error(`breakdown draft requirement_id mismatch: ${draft.requirement_id} != ${requirementId}`);
  }

  const planningStep =
    draft.status === "approved" || draft.status === "consumed" ? "ready_to_materialize" : "breakdown_draft";
  await primitiveExecutor.run({
    primitive: "requirement.reindex",
    mutationType: "prisma.requirement.update",
    run: async () =>
      await prisma.requirement.update({
        where: {
          id: requirement.id
        },
        data: {
          currentPlanningStep: planningStep,
          planningRuntimeState: "idle",
          breakdownDraftPath: target.relativePath
        }
      })
  });

  return {
    reindexed: true,
    requirementId,
    breakdownDraftPath: target.relativePath,
    cleared: false
  };
}

function trimRecentRequirementReindexCache(): void {
  while (recentRequirementReindexes.size > 100) {
    const oldestKey = recentRequirementReindexes.keys().next().value;
    if (!oldestKey) return;
    recentRequirementReindexes.delete(oldestKey);
  }
}

async function collectPlanMarkdownDocuments(projectRoot: string): Promise<ParsedDocumentRecord[]> {
  const planRoot = join(projectRoot, "docs", "03_开发计划");
  const files = await collectMarkdownFiles(planRoot);
  const resolver = getDocsStructureResolverForProject(projectRoot);
  const documents: ParsedDocumentRecord[] = [];
  for (const absolutePath of files) {
    const content = await readFile(absolutePath, "utf8");
    documents.push(
      parseDocument({
        relativePath: relative(projectRoot, absolutePath).replace(/\\/g, "/"),
        content,
        mtime: (await stat(absolutePath)).mtime,
        resolver
      })
    );
  }
  return documents;
}

async function collectMarkdownFiles(rootPath: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(rootPath, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = join(rootPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectMarkdownFiles(entryPath)));
      continue;
    }
    if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      files.push(entryPath);
    }
  }
  return files.sort();
}

function issueFromError(path: string, reason: string, error: unknown): RequirementScopedReindexIssue {
  return {
    path,
    reason,
    detail: error instanceof Error ? error.message : String(error)
  };
}

function issueFromAnomaly(anomaly: VerifyAnomaly): RequirementScopedReindexIssue {
  return {
    path: `task:${anomaly.taskKey}`,
    reason: anomaly.category,
    detail: JSON.stringify(anomaly.detail)
  };
}

async function loadProjectRoot(prisma: PrismaClient, projectId: string): Promise<string> {
  const project = await prisma.project.findUnique({
    where: {
      id: projectId
    },
    select: {
      localPath: true
    }
  });
  if (!project) {
    throw new RequirementEditNotFoundError("项目不存在");
  }
  return resolve(project.localPath);
}

function extractMarkdownBody(content: string): string {
  const matched = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/);
  return matched ? matched[1] : content;
}

function safeDraftFileName(id: string): string {
  return `${id.replace(/[\\/]/g, "_")}.json`;
}
