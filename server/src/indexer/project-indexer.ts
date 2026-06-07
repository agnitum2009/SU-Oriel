import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { dirname, join, relative } from "node:path";

import type { Prisma, PrismaClient } from "@prisma/client";
import { ZodError } from "zod";

import { primitiveExecutor } from "../modules/primitive/primitive-wrapper.js";
import { breakdownDraftSchema, type BreakdownDraft } from "../modules/breakdown-draft/breakdown-draft.schema.js";
import { hashRequirementAnalysisInput } from "../modules/requirement/requirement-analysis-hash.js";
import { rollupAllRequirementsForProject } from "../modules/requirement/requirement-status-rollup.js";
import {
  reconcileCancelledRequirementProjectionsForProject,
  updateSlotActivityForCapabilityOutcome
} from "../modules/slot-binding/slot-binding.service.js";
import {
  getExplicitRequirementStatus,
  normalizeRequirementAnalysisProjectionFields,
  normalizeRequirementFields,
  parseDocument,
  parseRequirementSections,
  type ParsedDocumentRecord,
  type RequirementStatusValue
} from "./document-parser.js";
import { getDocsStructureResolverForProject, type DocsStructureResolver } from "./docs-structure-resolver.js";
import {
  DOC_MAP_TIER_ORDER,
  deriveDocumentGovernance,
  type DocMapTier
} from "./document-governance.js";
import {
  evaluateTemplateConformance,
  type TemplateConformanceWarning
} from "./template-conformance.js";

/**
 * 生成 requirement id（cuid-like：c + base36 时间戳 + hex 随机，25 字符）。
 * 与 prisma @default(cuid()) 风格相近，但不依赖 cuid 库。文件名后 6 字符做 collision 防御。
 */
export function generateRequirementId(): string {
  const ts = Date.now().toString(36);
  const rand = randomBytes(16).toString("hex");
  return ("c" + ts + rand).slice(0, 25);
}

const TASK_DOCUMENT_KINDS = new Set(["dev_task"]);
const VALID_TASK_CURRENT_NODES = new Set([
  "requirement_analysis",
  "technical_design",
  "task_breakdown",
  "dispatch",
  "implementation",
  "review",
  "archive"
]);

export const SCAN_PHASE_PIPELINE_JOB_TYPES = [
  "scan",
  "parse",
  "template_conformance",
  "requirement_sync",
  "reconcile",
  "plugin_journal_sync",
  "requirement_design_doc_sync",
  "breakdown_draft_sync",
  "requirement_rollup"
] as const;

export interface ScanProjectResult {
  documentCount: number;
  taskCount: number;
  docsRoot: string;
}

export interface ProjectScanPhaseView {
  phase: string | null;
  phaseStatus: string | null;
  phaseJobId: string | null;
  phaseErrorMessage: string | null;
}

export interface ProjectScanJobView {
  id: string;
  projectId: string;
  jobType: string;
  status: string;
  processedCount: number;
  totalCount: number;
  errorMessage: string | null;
  startedAt: string;
  finishedAt: string | null;
  updatedAt: string;
}

export interface StartProjectScanResult {
  started: boolean;
  projectSyncStatus: "scanning";
  job: ProjectScanJobView | null;
}

export type PluginJournalWatermarkCheckResult =
  | { status: "missing" | "empty"; journalPath: string }
  | { status: "invalid"; journalPath: string; issue: Record<string, unknown> }
  | { status: "current" | "lagging"; journalPath: string; eventId: string; line: number };

interface ScanProjectOptions {
  scanJobId?: string;
  markScanning?: boolean;
  rollupAllRequirementsForProject?: typeof rollupAllRequirementsForProject;
}

type SyncJobRecord = {
  id: string;
  projectId: string;
  jobType: string;
  status: string;
  processedCount: number;
  totalCount: number;
  errorMessage: string | null;
  startedAt: Date;
  finishedAt: Date | null;
  updatedAt: Date;
};

type ScanLogger = {
  error?: (payload: unknown, message?: string) => void;
};

class ProjectScanFailureRecordedError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ProjectScanFailureRecordedError";
  }
}

function isProjectScanFailureRecorded(error: unknown): boolean {
  return error instanceof ProjectScanFailureRecordedError;
}

const SCAN_PROGRESS_FILE_INTERVAL = 10;
const SCAN_PROGRESS_TIME_INTERVAL_MS = 250;

export interface CreateRequirementInput {
  requirementId?: string;
  title: string;
  description: string;
  outputMode?: "requirement_only" | "spec_only" | "spec_plan_task";
  splitMode?: "direct_pr";
  sourceTaskId?: string | null;
  verbatimSource?: string;
  claudeInterpretation?: string;
  ambiguities?: string;
  fidelityDiff?: string;
}

export interface GenerateRequirementTaskInput {
  taskKey?: string;
  title?: string;
  summary?: string;
}

export class RequirementTaskConflictError extends Error {
  constructor() {
    super("需求已生成任务");
  }
}

export class RequirementNotFoundError extends Error {
  constructor() {
    super("需求不存在");
  }
}

export interface DerivedTaskProjection {
  taskKey: string;
  title: string;
  summary: string | null;
  status: string;
  currentNode: string | null;
  nodeSubstate: string | null;
  runtimeState: string | null;
  lastTransitionId: string | null;
  priority: string;
  progress: number;
  primaryDocumentId: string | null;
  requirementId: string | null;
  specSectionId: string | null;
  implementationOwner: string | null;
  blockedReason: string | null;
  reviewStatus: string | null;
  verificationResultJson: string | null;
  reviewFollowupJson: string | null;
}

export type VerifyAnomalyCategory =
  | "archive_mixed_docs"
  | "id_conflict"
  | "invalid_current_node"
  | "archived_spec_active_task"
  | "canonical_archive_progress_mismatch"
  | "null_current_node_subtask"
  | "invalid_current_node_subtask"
  | "requirement_planning_step_missing"
  | "requirement_planning_step_invalid"
  | "requirement_plan_doc_missing"
  | "requirement_breakdown_draft_missing"
  | "requirement_rollup_mismatch"
  | "subtask_requirement_missing"
  | "anchor_subject_missing"
  | "anchor_mode_mismatch"
  | "stale_task_projection_orphan";

export interface VerifyAnomaly {
  category: VerifyAnomalyCategory;
  taskKey: string;
  detail: Record<string, unknown>;
}

interface DeriveTasksResult {
  tasks: DerivedTaskProjection[];
  anomalies: VerifyAnomaly[];
}

interface DocumentMapEntry {
  path: string;
  docType: string;
  title: string;
  task_id: string | null;
  tier: DocMapTier;
  requirementId: string | null;
  entityStatus: string | null;
  parseStatus: string;
  updatedAt: string;
}

function serializeProjectScanJob(job: SyncJobRecord): ProjectScanJobView {
  return {
    id: job.id,
    projectId: job.projectId,
    jobType: job.jobType,
    status: job.status,
    processedCount: job.processedCount,
    totalCount: job.totalCount,
    errorMessage: job.errorMessage,
    startedAt: job.startedAt.toISOString(),
    finishedAt: job.finishedAt?.toISOString() ?? null,
    updatedAt: job.updatedAt.toISOString()
  };
}

export async function getLatestProjectScanJob(
  prisma: PrismaClient,
  projectId: string
): Promise<ProjectScanJobView | null> {
  const job = await prisma.syncJob.findFirst({
    where: {
      projectId,
      jobType: "scan"
    },
    orderBy: [{ startedAt: "desc" }, { createdAt: "desc" }]
  });
  return job ? serializeProjectScanJob(job) : null;
}

function emptyScanPhase(): ProjectScanPhaseView {
  return {
    phase: null,
    phaseStatus: null,
    phaseJobId: null,
    phaseErrorMessage: null
  };
}

export async function deriveScanPhase(
  prisma: PrismaClient | Prisma.TransactionClient,
  projectId: string
): Promise<ProjectScanPhaseView> {
  const project = await prisma.project.findUnique({
    where: {
      id: projectId
    },
    select: {
      lastScanAt: true
    }
  });

  if (!project) {
    throw new Error("项目不存在");
  }

  const runStartedAfter = project.lastScanAt ?? new Date(0);
  const rootScan = await prisma.syncJob.findFirst({
    where: {
      projectId,
      jobType: "scan",
      startedAt: {
        gt: runStartedAfter
      }
    },
    orderBy: [{ startedAt: "desc" }, { createdAt: "desc" }]
  });

  if (!rootScan) {
    return emptyScanPhase();
  }

  const current = await prisma.syncJob.findFirst({
    where: {
      projectId,
      jobType: {
        in: [...SCAN_PHASE_PIPELINE_JOB_TYPES]
      },
      startedAt: {
        gte: rootScan.startedAt
      }
    },
    orderBy: [{ startedAt: "desc" }, { createdAt: "desc" }]
  });

  if (!current) {
    return {
      phase: "preparing",
      phaseStatus: null,
      phaseJobId: null,
      phaseErrorMessage: null
    };
  }

  return {
    phase: current.jobType,
    phaseStatus: current.status,
    phaseJobId: current.id,
    phaseErrorMessage: current.errorMessage
  };
}

export async function startProjectScan(
  prisma: PrismaClient,
  projectId: string,
  logger?: ScanLogger
): Promise<StartProjectScanResult> {
  const claim = await prisma.project.updateMany({
    where: {
      id: projectId,
      syncStatus: {
        not: "scanning"
      }
    },
    data: {
      syncStatus: "scanning"
    }
  });

  let claimed: { started: boolean; job: SyncJobRecord | null };
  if (claim.count === 1) {
    claimed = {
      started: true,
      job: await createSyncJob(prisma, projectId, "scan")
    };
  } else {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: {
        id: true
      }
    });
    if (!project) {
      throw new Error("项目不存在");
    }
    claimed = {
      started: false,
      job: await prisma.syncJob.findFirst({
        where: {
          projectId,
          jobType: "scan",
          status: "running"
        },
        orderBy: [{ startedAt: "desc" }, { createdAt: "desc" }]
      })
    };
  }

  if (claimed.started && claimed.job) {
    void scanProject(prisma, projectId, { scanJobId: claimed.job.id, markScanning: false }).catch(async (error) => {
      const message = error instanceof Error ? error.message : "项目扫描失败";
      try {
        if (!isProjectScanFailureRecorded(error)) {
          await markProjectScanFailed(prisma, projectId, claimed.job!.id, message);
        }
      } catch (cleanupError) {
        logger?.error?.({ err: cleanupError, projectId }, "background project scan failure cleanup failed");
      }
      logger?.error?.({ err: error, projectId }, "background project scan failed");
    });
  }

  return {
    started: claimed.started,
    projectSyncStatus: "scanning",
    job: claimed.job ? serializeProjectScanJob(claimed.job) : await getLatestProjectScanJob(prisma, projectId)
  };
}

export async function scanProject(
  prisma: PrismaClient,
  projectId: string,
  options: ScanProjectOptions = {}
): Promise<ScanProjectResult> {
  const project = await prisma.project.findUnique({
    where: {
      id: projectId
    }
  });

  if (!project) {
    throw new Error("项目不存在");
  }

  if (options.markScanning !== false) {
    await prisma.project.update({
      where: { id: projectId },
      data: { syncStatus: "scanning" }
    });
  }

  const scanJob = options.scanJobId
    ? await prisma.syncJob.findUniqueOrThrow({
        where: {
          id: options.scanJobId
        }
      })
    : await createSyncJob(prisma, projectId, "scan");

  try {
    const projectDocsResolver = getDocsStructureResolverForProject(project.localPath);
    const docsRoot = resolveDocsRoot(project.localPath, projectDocsResolver);
    const markdownFiles = await collectMarkdownFiles(docsRoot, project.localPath, projectDocsResolver);
    const breakdownDraftFiles = await collectBreakdownDraftFiles(project.localPath);
    const parsedDocuments: ParsedDocumentRecord[] = [];
    const templateConformanceWarnings: TemplateConformanceWarning[] = [];
    const anomalies: VerifyAnomaly[] = [];

    const progress = createScanProgressUpdater(prisma, scanJob.id, markdownFiles.length);
    await progress.initialize();

    for (const [index, filePath] of markdownFiles.entries()) {
      const content = await readFile(filePath, "utf8");
      const stats = await import("node:fs/promises").then(({ stat }) => stat(filePath));
      const parsedDocument = parseDocument({
        relativePath: relative(project.localPath, filePath),
        content,
        mtime: stats.mtime,
        resolver: projectDocsResolver
      });
      parsedDocuments.push(parsedDocument);
      if (parsedDocument.parseStatus === "success") {
        const warning = evaluateTemplateConformance({
          path: parsedDocument.path,
          docType: parsedDocument.kind,
          content
        });
        if (warning) {
          templateConformanceWarnings.push(warning);
        }
      }
      await progress.maybeFlush(index + 1);
    }
    await progress.flush(markdownFiles.length);

    await writeDocumentMapArtifacts(project.localPath, parsedDocuments);

    await finishSyncJob(prisma, scanJob.id, "success", `扫描到 ${markdownFiles.length} 份 Markdown 文档`);

    const parseJob = await createSyncJob(prisma, projectId, "parse");
    const retainedPaths = parsedDocuments.map((item) => item.path);

    if (retainedPaths.length === 0) {
      await prisma.document.deleteMany({
        where: {
          projectId
        }
      });
    } else {
      await prisma.document.deleteMany({
        where: {
          projectId,
          path: {
            notIn: retainedPaths
          }
        }
      });
    }

    for (const document of parsedDocuments) {
      await upsertDocumentProjectionAsync(prisma, projectId, document);
    }

    const parseIssues = parsedDocuments.flatMap((document) =>
      document.parseIssues.map((issue) => ({
        path: document.path,
        parseStatus: document.parseStatus,
        issue
      }))
    );
    if (parseIssues.length > 0) {
      await finishSyncJob(
        prisma,
        parseJob.id,
        "partial",
        `解析完成，共落库 ${parsedDocuments.length} 份文档，issue=${parseIssues.length}`,
        JSON.stringify(parseIssues)
      );
    } else {
      await finishSyncJob(prisma, parseJob.id, "success", `解析完成，共落库 ${parsedDocuments.length} 份文档`);
    }

    const templateConformanceJob = await createSyncJob(prisma, projectId, "template_conformance");
    if (templateConformanceWarnings.length > 0) {
      await finishSyncJob(
        prisma,
        templateConformanceJob.id,
        "partial",
        `模板符合度检查完成，warning=${templateConformanceWarnings.length}`,
        JSON.stringify(templateConformanceWarnings)
      );
    } else {
      await finishSyncJob(
        prisma,
        templateConformanceJob.id,
        "success",
        "模板符合度检查通过"
      );
    }

    // Requirement md 是 Task.requirementId 的 FK 真相源。必须先同步 Requirement，
    // clean DB 首扫时 dev_task 才能在 Task 投影阶段保留 requirementId。
    const requirementSyncJob = await createSyncJob(prisma, projectId, "requirement_sync");
    try {
      const { upsertedCount, issues: requirementIssues } = await syncRequirementsFromMarkdown(
        prisma,
        projectId,
        project.localPath,
        parsedDocuments.filter((doc) => doc.kind === "requirement"),
        markdownFiles
      );
      if (requirementIssues.length > 0) {
        await finishSyncJob(
          prisma,
          requirementSyncJob.id,
          "partial",
          `requirement md 同步：upserted=${upsertedCount}，校验问题=${requirementIssues.length}`,
          JSON.stringify(requirementIssues)
        );
      } else {
        await finishSyncJob(
          prisma,
          requirementSyncJob.id,
          "success",
          `requirement md 同步完成，upserted=${upsertedCount}`
        );
      }
      await reconcileCancelledRequirementProjectionsForProject(prisma, projectId);
    } catch (error) {
      const message = error instanceof Error ? error.message : "requirement md 同步失败";
      await finishSyncJob(prisma, requirementSyncJob.id, "failed", "requirement md 同步失败", message);
      throw error;
    }

    const reconcileJob = await createSyncJob(prisma, projectId, "reconcile");
    const persistedDocuments = await prisma.document.findMany({
      where: {
        projectId
      },
      orderBy: {
        path: "asc"
      }
    });

    const deriveInput = selectTaskProjectionInputDocuments(persistedDocuments);
    anomalies.push(...deriveInput.anomalies);
    const derived = deriveTasks(deriveInput.documents);
    const { tasks: derivedTasks } = derived;
    anomalies.push(...derived.anomalies);

    const invalidCurrentNodeTaskKeys = anomalies
      .filter((anomaly) => anomaly.category === "invalid_current_node")
      .map((anomaly) => anomaly.taskKey);
    const retainedTaskKeys = Array.from(
      new Set([...derivedTasks.map((task) => task.taskKey), ...invalidCurrentNodeTaskKeys])
    );

    anomalies.push(...(await cleanupStaleTaskProjectionsAsync(prisma, projectId, retainedTaskKeys)));

    for (const task of derivedTasks) {
      await upsertTaskProjectionAsync(prisma, projectId, task);
    }

    const pluginJournalSyncJob = await createSyncJob(prisma, projectId, "plugin_journal_sync");
    try {
      const { projectedCount, issues: pluginJournalIssues } = await syncPluginEventJournal(
        prisma,
        projectId,
        project.localPath
      );
      if (pluginJournalIssues.length > 0) {
        await finishSyncJob(
          prisma,
          pluginJournalSyncJob.id,
          "partial",
          `plugin journal 同步：projected=${projectedCount}, issue=${pluginJournalIssues.length}`,
          JSON.stringify(pluginJournalIssues)
        );
      } else {
        await finishSyncJob(
          prisma,
          pluginJournalSyncJob.id,
          "success",
          `plugin journal 同步完成，projected=${projectedCount}`
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "plugin journal 同步失败";
      await finishSyncJob(prisma, pluginJournalSyncJob.id, "failed", "plugin journal 同步失败", message);
      throw error;
    }

    const requirementDesignDocSyncJob = await createSyncJob(prisma, projectId, "requirement_design_doc_sync");
    try {
      const { projectedCount, clearedCount, issues: designDocIssues } = await syncRequirementDesignDocsFromMarkdown(
        prisma,
        projectId,
        project.localPath,
        parsedDocuments
      );
      if (designDocIssues.length > 0) {
        await finishSyncJob(
          prisma,
          requirementDesignDocSyncJob.id,
          "partial",
          `requirement design doc 同步：projected=${projectedCount}, cleared=${clearedCount}, issue=${designDocIssues.length}`,
          JSON.stringify(designDocIssues)
        );
      } else {
        await finishSyncJob(
          prisma,
          requirementDesignDocSyncJob.id,
          "success",
          `requirement design doc 同步完成，projected=${projectedCount}, cleared=${clearedCount}`
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "requirement design doc 同步失败";
      await finishSyncJob(prisma, requirementDesignDocSyncJob.id, "failed", "requirement design doc 同步失败", message);
      throw error;
    }

    const breakdownDraftSyncJob = await createSyncJob(prisma, projectId, "breakdown_draft_sync");
    try {
      const { projectedCount, clearedCount, issues: breakdownDraftIssues } = await syncBreakdownDraftsFromFiles(
        prisma,
        projectId,
        project.localPath,
        breakdownDraftFiles
      );
      if (breakdownDraftIssues.length > 0) {
        await finishSyncJob(
          prisma,
          breakdownDraftSyncJob.id,
          "partial",
          `breakdown draft 同步：projected=${projectedCount}, cleared=${clearedCount}, issue=${breakdownDraftIssues.length}`,
          JSON.stringify(breakdownDraftIssues)
        );
      } else {
        await finishSyncJob(
          prisma,
          breakdownDraftSyncJob.id,
          "success",
          `breakdown draft 同步完成，projected=${projectedCount}, cleared=${clearedCount}`
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "breakdown draft 同步失败";
      await finishSyncJob(prisma, breakdownDraftSyncJob.id, "failed", "breakdown draft 同步失败", message);
      throw error;
    }

    const reconcileSummary =
      anomalies.length > 0
        ? `归并完成，共生成 ${derivedTasks.length} 个任务（anomaly=${anomalies.length}）`
        : `归并完成，共生成 ${derivedTasks.length} 个任务`;
    await finishSyncJob(
      prisma,
      reconcileJob.id,
      "success",
      reconcileSummary,
      anomalies.length > 0 ? JSON.stringify(anomalies) : undefined
    );

    await primitiveExecutor.run({
      primitive: "mark_project_scan_initialized",
      mutationType: "prisma.project.update",
      idempotencyKey: `${projectId}:mark_project_scan_initialized`,
      run: async () =>
        await prisma.project.update({
          where: {
            id: projectId
          },
          data: {
            docsRoot: relative(project.localPath, docsRoot).replace(/\\/g, "/"),
            initStatus: "initialized"
          }
        })
    });

    const requirementRollupJob = await createSyncJob(prisma, projectId, "requirement_rollup");
    try {
      const rollupResult = await (options.rollupAllRequirementsForProject ?? rollupAllRequirementsForProject)(
        prisma,
        projectId
      );
      await finishSyncJob(
        prisma,
        requirementRollupJob.id,
        "success",
        `requirement rollup 完成，checked=${rollupResult.checked}, updated=${rollupResult.updated}`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "requirement rollup 失败";
      await finishSyncJob(prisma, requirementRollupJob.id, "failed", "requirement rollup 失败", message);
      await markProjectSyncFailed(prisma, projectId, requirementRollupJob.id);
      throw new ProjectScanFailureRecordedError(message, { cause: error });
    }

    await primitiveExecutor.run({
      primitive: "mark_project_scan_idle",
      mutationType: "prisma.project.update",
      idempotencyKey: `${projectId}:mark_project_scan_idle:${requirementRollupJob.id}`,
      run: async () =>
        await prisma.project.update({
          where: {
            id: projectId
          },
          data: {
            syncStatus: "idle",
            lastScanAt: new Date()
          }
        })
    });

    return {
      documentCount: parsedDocuments.length,
      taskCount: derivedTasks.length,
      docsRoot
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "项目扫描失败";

    if (!isProjectScanFailureRecorded(error)) {
      await markProjectScanFailed(prisma, projectId, scanJob.id, message);
    }

    throw error;
  }
}

export async function upsertDocumentProjectionAsync(
  prisma: PrismaClient | Prisma.TransactionClient,
  projectId: string,
  document: ParsedDocumentRecord
) {
  return await prisma.document.upsert({
    where: {
      projectId_path: {
        projectId,
        path: document.path
      }
    },
    create: {
      projectId,
      taskKey: document.taskKey,
      path: document.path,
      kind: document.kind,
      title: document.title,
      status: document.status,
      frontmatterJson: JSON.stringify(document.frontmatter),
      summary: document.summary,
      contentHash: document.contentHash,
      mtime: document.mtime,
      parseStatus: document.parseStatus,
      parseError: document.parseError
    },
    update: {
      taskKey: document.taskKey,
      kind: document.kind,
      title: document.title,
      status: document.status,
      frontmatterJson: JSON.stringify(document.frontmatter),
      summary: document.summary,
      contentHash: document.contentHash,
      mtime: document.mtime,
      parseStatus: document.parseStatus,
      parseError: document.parseError
    }
  });
}

export async function upsertTaskProjectionAsync(
  prisma: PrismaClient,
  projectId: string,
  task: DerivedTaskProjection
): Promise<void> {
  const projection = await normalizeTaskProjectionForeignKeysAsync(prisma, projectId, task);
  // ADR-0034: projection 必须反映 canonical 当前态。idempotencyKey 必须随投影内容变化,
  // 否则 primitiveExecutor 的持久缓存(primitiveAudit)会让同一 taskKey 的投影只写一次,
  // 之后所有重扫的 upsert 被当重复跳过 → 已归档/状态变更的 dev_task 的 Task 行冻结在旧态。
  const projectionHash = createHash("sha256")
    .update(JSON.stringify(projection))
    .digest("hex")
    .slice(0, 24);
  await withProjectionRetry(
    async () =>
      await primitiveExecutor.run({
        primitive: "apply_task_projection_diff",
        mutationType: "prisma.task.upsert",
        idempotencyKey: `${projectId}:apply_task_projection_diff:upsert:${projection.taskKey}:${projectionHash}`,
        run: async () =>
          await prisma.task.upsert({
            where: {
              projectId_taskKey: {
                projectId,
                taskKey: projection.taskKey
              }
            },
            create: {
              projectId,
              ...projection
            },
            update: {
              ...projection
            }
          })
      })
  );
}

async function normalizeTaskProjectionForeignKeysAsync(
  prisma: PrismaClient,
  projectId: string,
  task: DerivedTaskProjection
): Promise<DerivedTaskProjection> {
  if (!task.requirementId) {
    return task;
  }

  const requirement = await prisma.requirement.findFirst({
    where: {
      id: task.requirementId,
      projectId
    },
    select: {
      id: true
    }
  });

  if (requirement) {
    return task;
  }

  return {
    ...task,
    requirementId: null
  };
}

export async function withProjectionRetry<T>(
  operation: () => Promise<T>,
  options: { maxAttempts?: number; delaysMs?: number[] } = {}
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3;
  const delaysMs = options.delaysMs ?? [25, 100, 250];
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts) break;
      await new Promise((resolve) => setTimeout(resolve, delaysMs[Math.min(attempt - 1, delaysMs.length - 1)]));
    }
  }
  throw lastError;
}

async function cleanupStaleTaskProjectionsAsync(
  prisma: PrismaClient,
  projectId: string,
  retainedTaskKeys: string[]
): Promise<VerifyAnomaly[]> {
  return await primitiveExecutor.run({
    primitive: "cleanup_stale_task_projections",
    mutationType: "reconcile.orphan_report",
    idempotencyKey: `${projectId}:cleanup_stale_task_projections:${retainedTaskKeys.length === 0 ? "none" : retainedTaskKeys.join(",")}`,
    run: async () => {
      const staleTasks = await prisma.task.findMany({
        where: {
          projectId,
          ...(retainedTaskKeys.length > 0
            ? {
                taskKey: {
                  notIn: retainedTaskKeys
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
      return staleTasks.map((task) => ({
        category: "stale_task_projection_orphan" as const,
        taskKey: task.taskKey,
        detail: {
          taskId: task.id,
          title: task.title,
          status: task.status,
          reason: "Task DB projection has no canonical dev_task document and was not deleted"
        }
      }));
    }
  });
}

export async function createRequirement(
  prisma: PrismaClient,
  projectId: string,
  input: CreateRequirementInput
): Promise<{ requirementId: string; generatedTaskId: string | null }> {
  const project = await prisma.project.findUnique({
    where: {
      id: projectId
    }
  });

  if (!project) {
    throw new Error("项目不存在");
  }

  return await createRequirementMdFirst(prisma, project.localPath, projectId, input);
}

/**
 * Slice 2 · docs 真源 md-first 路径
 *
 * 1. 生成 cuid-like id
 * 2. 拼文件名（含 id 后 6 字符 suffix）；文件已存在 → throw
 * 3. 渲染 md（与 export 脚本同 schema）
 * 4. writeFile（fs primitive）
 * 5. prisma.requirement.upsert（DB 失败下次 scan 自愈，md 是真源）
 */
async function createRequirementMdFirst(
  prisma: PrismaClient,
  projectRoot: string,
  projectId: string,
  input: CreateRequirementInput
): Promise<{ requirementId: string; generatedTaskId: string | null }> {
  const id = input.requirementId ?? generateRequirementId();
  const now = new Date();
  const resolvedRequirement = getDocsStructureResolverForProject(projectRoot).resolveDocType("requirement");
  const fileName = requirementFileName(input.title, id, resolvedRequirement.namingRule);
  const targetDir = join(projectRoot, resolvedRequirement.directory);
  const filePath = join(targetDir, fileName);

  // R1 must-fix #2：文件已存在硬失败，禁止静默覆盖
  if (existsSync(filePath)) {
    throw new Error(`requirement md 文件已存在: ${fileName}（不静默覆盖）`);
  }

  await mkdir(targetDir, { recursive: true });

  const content = renderRequirementMarkdown({
    id,
    title: input.title,
    createdAt: now,
    description: input.description,
    verbatimSource: input.verbatimSource ?? input.description,
    claudeInterpretation: input.claudeInterpretation ?? null,
    ambiguities: input.ambiguities ?? null,
    fidelityDiff: input.fidelityDiff ?? null
  });

  const generateJob = await createSyncJob(prisma, projectId, "generate");
  try {
    await writeGeneratedDoc(filePath, content, "utf8");

    // DB 写入用 input 原值保真（避免 splitMarkdownSections 对换行符 normalize 损失）。
    // 下次 scan 解析时若 round-trip 损失，由 scan 路径承担（md 是真源）。
    await primitiveExecutor.run({
      primitive: "apply_requirement_diff",
      mutationType: "prisma.requirement.create",
      idempotencyKey: `${projectId}:apply_requirement_diff:create:requirement_only:${id}`,
      run: async () =>
        await prisma.requirement.create({
          data: {
            id,
            projectId,
            title: input.title,
            description: input.description,
            status: "drafting",
            source: "manual",
            verbatimSource: input.verbatimSource ?? input.description,
            claudeInterpretation: input.claudeInterpretation ?? null,
            ambiguities: input.ambiguities ?? null,
            fidelityDiff: input.fidelityDiff ?? null,
            analysisInputHash: hashRequirementAnalysisInput(input.title, input.description),
            analysisStaleAt: null,
            currentPlanningStep: "analysis",
            planningRuntimeState: "idle",
            rollupProgress: 0,
            createdAt: now,
            updatedAt: now
          }
        })
    });

    await finishSyncJob(prisma, generateJob.id, "success", `需求已创建（md-first）：${input.title}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "需求 md-first 创建失败";
    await finishSyncJob(prisma, generateJob.id, "failed", "需求 md-first 创建失败", message);
    throw error;
  }

  return { requirementId: id, generatedTaskId: null };
}

interface RequirementMarkdownInput {
  id: string;
  title: string;
  status?: RequirementStatusValue;
  createdAt: Date;
  description: string;
  verbatimSource: string;
  claudeInterpretation: string | null;
  ambiguities: string | null;
  fidelityDiff: string | null;
}

const REQUIREMENT_BODY_TEMPLATE_HEADINGS = [
  "二、背景与目标",
  "三、讨论与决策",
  "四、功能 / 范围",
  "五、业务规则",
  "六、边界 / 不做项",
  "七、开放问题 / 假设",
  "八、拆分预览",
  "九、数据(草案)",
  "十、接口(草案)",
  "十一、界面 / 页面布局",
  "十二、交互 / 流程",
  "十三、风险"
];

function renderMarkdownSection(heading: string, content: string | null | undefined): string {
  const trimmed = content?.trim() ?? "";
  return trimmed.length > 0 ? `## ${heading}\n\n${trimmed}` : `## ${heading}`;
}

/** 渲染 requirement md（与 export 脚本共用单一来源）。 */
export function renderRequirementMarkdown(input: RequirementMarkdownInput): string {
  const fm = [
    "---",
    `id: ${input.id}`,
    `title: ${escapeYamlScalar(input.title)}`,
    "doc_type: requirement",
    `status: ${input.status ?? "drafting"}`,
    `created: ${input.createdAt.toISOString()}`,
    "---",
    "",
    ""
  ].join("\n");

  const sections: string[] = [];
  sections.push("> ⚠️ Requirement status canonical 在本 md，Console 仅投影展示。");
  sections.push(renderMarkdownSection("需求描述", input.description.trim() || "（待补充）"));
  sections.push(renderMarkdownSection("原话（verbatim）", input.verbatimSource.trim() || input.description.trim()));
  sections.push(...REQUIREMENT_BODY_TEMPLATE_HEADINGS.map((heading) => renderMarkdownSection(heading, null)));
  sections.push(renderMarkdownSection("Claude 解读", input.claudeInterpretation));
  sections.push(renderMarkdownSection("歧义点", input.ambiguities));
  sections.push(renderMarkdownSection("保真差异", input.fidelityDiff));

  return fm + sections.join("\n\n") + "\n";
}

function requirementFileName(title: string, requirementId: string, namingRule: string): string {
  const idSuffix = requirementId.slice(-6);
  const subject = `${slugify(title) || "requirement"}-${idSuffix}`;
  const fileName = namingRule
    .replace("<模块/主题>", subject)
    .replace("<文档类型>", "需求")
    .replace("<部分>", subject)
    .replace("<模块>", subject);
  return fileName.endsWith(".md") ? fileName : `${fileName}.md`;
}

function escapeYamlScalar(value: string): string {
  if (/[:#\-{}[\]&*!|>'"%@`?,]/.test(value) || /^\s|\s$/.test(value)) {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return value;
}

function extractMarkdownBody(content: string): string {
  const matched = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/);
  return matched ? matched[1] : content;
}

interface RequirementSyncIssue {
  path: string;
  reason: "missing_id" | "duplicate_id" | "invalid_field";
  detail?: string;
}

interface BreakdownDraftSyncIssue {
  path: string;
  reason: "invalid_json" | "invalid_schema" | "missing_requirement";
  detail?: string;
}

interface RequirementDesignDocSyncIssue {
  path: string;
  reason: "invalid_doc" | "empty_body" | "missing_requirement_id" | "missing_requirement";
  detail?: string;
}

/**
 * Slice 2 · scan 末段：把 requirement md 反向 upsert 到 DB Requirement。
 *
 * 校验:
 * - frontmatter.id 必填（缺 → skip + issue）
 * - 同次 scan id 唯一（重复 → 第二份起 skip + issue）
 * - status / source / output_mode / generated_task_id 用 normalize helper 规整
 * - 非法枚举 → 记录 issue 但不阻断单条 upsert；update 缺失/非法 status 时 preserve 现有 DB 值
 *
 * 顺序确定性：先按 path 排序保证 duplicate id 处理结果稳定（与 readdir 顺序无关）。
 *
 * 删除策略：scan 不主动 delete Requirement（保守）。
 */
export async function syncRequirementsFromMarkdown(
  prisma: PrismaClient | Prisma.TransactionClient,
  projectId: string,
  projectRoot: string,
  requirementDocs: ParsedDocumentRecord[],
  allMarkdownFiles: string[]
): Promise<{ upsertedCount: number; issues: RequirementSyncIssue[] }> {
  const issues: RequirementSyncIssue[] = [];
  const seen = new Set<string>();
  let upsertedCount = 0;

  // 文件路径 -> 原始 content 的映射（避免 re-read）
  const pathToContent = new Map<string, string>();
  const requirementPaths = new Set(requirementDocs.map((doc) => doc.path));
  for (const absPath of allMarkdownFiles) {
    const relPath = relative(projectRoot, absPath).replace(/\\/g, "/");
    if (requirementPaths.has(relPath)) {
      try {
        const content = await readFile(absPath, "utf8");
        pathToContent.set(relPath, content);
      } catch {
        // 忽略读失败的；下面 lookup 时会 fallback
      }
    }
  }

  // 按 path 排序保证 duplicate id 处理稳定
  const sortedDocs = [...requirementDocs].sort((a, b) => a.path.localeCompare(b.path));

  for (const reqDoc of sortedDocs) {
    const id = reqDoc.frontmatter.id?.trim();
    if (!id) {
      issues.push({ path: reqDoc.path, reason: "missing_id" });
      continue;
    }
    if (seen.has(id)) {
      issues.push({ path: reqDoc.path, reason: "duplicate_id", detail: `id=${id}` });
      continue;
    }
    seen.add(id);

    const normalized = normalizeRequirementFields(reqDoc.frontmatter);
    const explicitStatus = getExplicitRequirementStatus(reqDoc.frontmatter);
    for (const fieldIssue of normalized.issues) {
      issues.push({ path: reqDoc.path, reason: "invalid_field", detail: fieldIssue });
    }
    const analysisProjection = normalizeRequirementAnalysisProjectionFields(reqDoc.frontmatter);
    for (const fieldIssue of analysisProjection.issues) {
      issues.push({ path: reqDoc.path, reason: "invalid_field", detail: fieldIssue });
    }

    const rawContent = pathToContent.get(reqDoc.path) ?? "";
    const sections = parseRequirementSections(extractMarkdownBody(rawContent));

    const createdAt = parseDate(reqDoc.frontmatter.created) ?? reqDoc.mtime;
    const updatedAt = parseDate(reqDoc.frontmatter.updated) ?? reqDoc.mtime;
    const title = reqDoc.title;
    const currentAnalysisInputHash = hashRequirementAnalysisInput(title, sections.description);
    const existingRequirement = await prisma.requirement.findUnique({
      where: { id },
      select: {
        analysisInputHash: true,
        analysisStaleAt: true
      }
    });
    const projectedAnalysisMatchesCurrent = analysisProjection.analysisInputHash === currentAnalysisInputHash;
    const analysisUpdate =
      analysisProjection.analysisInputHash !== null
        ? {
            analysisInputHash: analysisProjection.analysisInputHash,
            analysisStaleAt:
              projectedAnalysisMatchesCurrent && analysisProjection.analysisAppliedAt
                ? null
                : projectedAnalysisMatchesCurrent
                  ? existingRequirement?.analysisStaleAt ?? null
                  : existingRequirement?.analysisStaleAt ?? new Date()
          }
        : existingRequirement?.analysisInputHash && existingRequirement.analysisInputHash !== currentAnalysisInputHash
          ? {
              analysisStaleAt: existingRequirement.analysisStaleAt ?? new Date()
            }
          : {};

    await prisma.requirement.upsert({
      where: { id },
      update: {
        title,
        description: sections.description,
        ...(explicitStatus ? { status: explicitStatus } : {}),
        verbatimSource: sections.verbatimSource || sections.description,
        claudeInterpretation: sections.claudeInterpretation,
        ambiguities: sections.ambiguities,
        fidelityDiff: sections.fidelityDiff,
        ...analysisUpdate,
        updatedAt
      },
      create: {
        id,
        projectId,
        title,
        description: sections.description,
        status: normalized.status,
        source: normalized.source,
        verbatimSource: sections.verbatimSource || sections.description,
        claudeInterpretation: sections.claudeInterpretation,
        ambiguities: sections.ambiguities,
        fidelityDiff: sections.fidelityDiff,
        analysisInputHash: analysisProjection.analysisInputHash ?? currentAnalysisInputHash,
        analysisStaleAt:
          analysisProjection.analysisInputHash && analysisProjection.analysisInputHash !== currentAnalysisInputHash
            ? new Date()
            : null,
        currentPlanningStep: "analysis",
        planningRuntimeState: "idle",
        rollupProgress: 0,
        createdAt,
        updatedAt
      }
    });
    upsertedCount += 1;
  }

  return { upsertedCount, issues };
}

export async function syncRequirementDesignDocsFromMarkdown(
  prisma: PrismaClient | Prisma.TransactionClient,
  projectId: string,
  projectRoot: string,
  markdownDocs: ParsedDocumentRecord[]
): Promise<{ projectedCount: number; clearedCount: number; issues: RequirementDesignDocSyncIssue[] }> {
  const issues: RequirementDesignDocSyncIssue[] = [];
  const retainedPaths = new Set<string>();
  let projectedCount = 0;
  const technicalDesignDirectory = getDocsStructureResolverForProject(projectRoot).resolveDocType(
    "technical_design"
  ).directory;
  const designDocs = markdownDocs
    .filter((doc) => doc.kind === "technical_design")
    .sort((a, b) => a.path.localeCompare(b.path));

  for (const doc of designDocs) {
    if (doc.parseStatus !== "success") {
      issues.push({ path: doc.path, reason: "invalid_doc", detail: doc.parseError ?? "parseStatus != success" });
      continue;
    }

    const requirementId = doc.frontmatter.requirement_id?.trim();
    if (!requirementId) {
      issues.push({ path: doc.path, reason: "missing_requirement_id" });
      continue;
    }

    const content = await readFile(join(projectRoot, doc.path), "utf8");
    if (extractMarkdownBody(content).trim().length === 0) {
      issues.push({ path: doc.path, reason: "empty_body" });
      continue;
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
      issues.push({ path: doc.path, reason: "missing_requirement", detail: `requirement_id=${requirementId}` });
      continue;
    }

    await primitiveExecutor.run({
      primitive: "apply_requirement_diff",
      mutationType: "prisma.requirement.update",
      run: async () =>
        await prisma.requirement.update({
          where: {
            id: requirement.id
          },
          data: {
            planDocPath: doc.path
          }
        })
    });
    retainedPaths.add(doc.path);
    projectedCount += 1;
  }

  const requirementsWithProjectedDesign = await prisma.requirement.findMany({
    where: {
      projectId,
      planDocPath: {
        startsWith: technicalDesignDirectory
      }
    },
    select: {
      id: true,
      planDocPath: true
    }
  });

  let clearedCount = 0;
  for (const requirement of requirementsWithProjectedDesign) {
    if (!requirement.planDocPath || retainedPaths.has(requirement.planDocPath)) {
      continue;
    }
    await primitiveExecutor.run({
      primitive: "apply_requirement_diff",
      mutationType: "prisma.requirement.update",
      run: async () =>
        await prisma.requirement.update({
          where: {
            id: requirement.id
          },
          data: {
            planDocPath: null
          }
        })
    });
    clearedCount += 1;
  }

  return { projectedCount, clearedCount, issues };
}

export async function syncBreakdownDraftsFromFiles(
  prisma: PrismaClient | Prisma.TransactionClient,
  projectId: string,
  projectRoot: string,
  draftFiles: string[]
): Promise<{ projectedCount: number; clearedCount: number; issues: BreakdownDraftSyncIssue[] }> {
  const issues: BreakdownDraftSyncIssue[] = [];
  const retainedPaths = new Set<string>();
  let projectedCount = 0;
  const breakdownDraftDirectory = getDocsStructureResolverForProject(projectRoot).resolveMachineLayerPath("breakdownDrafts");

  for (const absPath of [...draftFiles].sort()) {
    const relPath = relative(projectRoot, absPath).replace(/\\/g, "/");
    retainedPaths.add(relPath);

    let draft: BreakdownDraft;
    try {
      draft = breakdownDraftSchema.parse(JSON.parse(await readFile(absPath, "utf8")));
    } catch (error) {
      issues.push({
        path: relPath,
        reason: error instanceof SyntaxError ? "invalid_json" : "invalid_schema",
        detail:
          error instanceof ZodError
            ? error.issues.map((issue) => issue.message).join("; ")
            : error instanceof Error
              ? error.message
              : String(error)
      });
      continue;
    }

    const requirement = await prisma.requirement.findFirst({
      where: {
        id: draft.requirement_id,
        projectId
      },
      select: {
        id: true
      }
    });
    if (!requirement) {
      issues.push({ path: relPath, reason: "missing_requirement", detail: `requirement_id=${draft.requirement_id}` });
      continue;
    }

    const planningStep =
      draft.status === "approved" || draft.status === "consumed" ? "ready_to_materialize" : "breakdown_draft";
    await prisma.requirement.update({
      where: {
        id: requirement.id
      },
      data: {
        currentPlanningStep: planningStep,
        planningRuntimeState: "idle",
        breakdownDraftPath: relPath
      }
    });
    projectedCount += 1;
  }

  const staleRequirements = await prisma.requirement.findMany({
    where: {
      projectId,
      breakdownDraftPath: {
        startsWith: breakdownDraftDirectory
      }
    },
    select: {
      id: true,
      breakdownDraftPath: true
    }
  });

  let clearedCount = 0;
  for (const requirement of staleRequirements) {
    if (!requirement.breakdownDraftPath || retainedPaths.has(requirement.breakdownDraftPath)) {
      continue;
    }
    await prisma.requirement.update({
      where: {
        id: requirement.id
      },
      data: {
        breakdownDraftPath: null,
        currentPlanningStep: "breakdown_draft",
        planningRuntimeState: "idle"
      }
    });
    clearedCount += 1;
  }

  return { projectedCount, clearedCount, issues };
}

function parseDate(raw: string | undefined): Date | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const date = new Date(trimmed);
  return isNaN(date.getTime()) ? null : date;
}

export async function generateTaskFromRequirement(
  prisma: PrismaClient,
  projectId: string,
  requirementId: string,
  _input: GenerateRequirementTaskInput
): Promise<never> {
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
    throw new RequirementNotFoundError();
  }
  throw new RequirementTaskConflictError();
}

async function createSyncJob(prisma: PrismaClient, projectId: string, jobType: string) {
  return await primitiveExecutor.run({
    primitive: "create_sync_job",
    mutationType: "prisma.syncJob.create",
    idempotencyKey: null,
    run: async () =>
      await prisma.syncJob.create({
        data: {
          projectId,
          jobType,
          status: "running"
        }
      })
  });
}

function createScanProgressUpdater(prisma: PrismaClient, syncJobId: string, totalCount: number) {
  let lastPersisted = 0;
  let lastPersistedAt = 0;

  async function write(processedCount: number): Promise<void> {
    lastPersisted = processedCount;
    lastPersistedAt = Date.now();
    await prisma.syncJob.update({
      where: {
        id: syncJobId
      },
      data: {
        processedCount,
        totalCount
      }
    });
  }

  return {
    initialize: async () => {
      await write(0);
    },
    maybeFlush: async (processedCount: number) => {
      const enoughFiles = processedCount - lastPersisted >= SCAN_PROGRESS_FILE_INTERVAL;
      const enoughTime = Date.now() - lastPersistedAt >= SCAN_PROGRESS_TIME_INTERVAL_MS;
      if (processedCount < totalCount && !enoughFiles && !enoughTime) {
        return;
      }
      await write(processedCount);
    },
    flush: async (processedCount: number) => {
      if (processedCount !== lastPersisted) {
        await write(processedCount);
      }
    }
  };
}

async function markProjectScanFailed(
  prisma: PrismaClient,
  projectId: string,
  syncJobId: string,
  errorMessage: string
): Promise<void> {
  await finishSyncJob(prisma, syncJobId, "failed", "扫描阶段失败", errorMessage);
  await markProjectSyncFailed(prisma, projectId, syncJobId);
}

async function markProjectSyncFailed(
  prisma: PrismaClient,
  projectId: string,
  syncJobId: string
): Promise<void> {
  await primitiveExecutor.run({
    primitive: "mark_project_scan_failed",
    mutationType: "prisma.project.update",
    idempotencyKey: `${syncJobId}:mark_project_scan_failed`,
    run: async () =>
      await prisma.project.update({
        where: {
          id: projectId
        },
        data: {
          syncStatus: "failed"
        }
      })
  });
}

async function finishSyncJob(
  prisma: PrismaClient,
  syncJobId: string,
  status: "success" | "failed" | "partial",
  logSummary: string,
  errorMessage?: string
) {
  await primitiveExecutor.run({
    primitive: "finish_sync_job",
    mutationType: "prisma.syncJob.update",
    idempotencyKey: `${syncJobId}:finish_sync_job:${status}`,
    run: async () =>
      await prisma.syncJob.update({
        where: {
          id: syncJobId
        },
        data: {
          status,
          logSummary,
          errorMessage: errorMessage ?? null,
          finishedAt: new Date()
        }
      })
  });
}

function resolveDocsRoot(
  projectRoot: string,
  resolver: DocsStructureResolver = getDocsStructureResolverForProject(projectRoot)
): string {
  const docsRoot = join(projectRoot, resolver.humanDocsRoot);
  if (existsSync(docsRoot)) {
    return docsRoot;
  }

  throw new Error(`项目下未找到文档目录: ${resolver.humanDocsRoot}`);
}

async function collectMarkdownFiles(
  rootPath: string,
  projectRoot: string,
  resolver: DocsStructureResolver = getDocsStructureResolverForProject(projectRoot)
): Promise<string[]> {
  if (shouldIgnoreScanPath(rootPath, projectRoot, resolver)) {
    return [];
  }
  const entries = await readdir(rootPath, {
    withFileTypes: true
  });

  const files: string[] = [];

  for (const entry of entries) {
    const entryPath = join(rootPath, entry.name);
    if (entry.isDirectory()) {
      if (shouldIgnoreScanPath(entryPath, projectRoot, resolver)) {
        continue;
      }
      files.push(...(await collectMarkdownFiles(entryPath, projectRoot, resolver)));
      continue;
    }

    if (entry.isFile() && entry.name.toLowerCase().endsWith(".md") && !isTemplateMarkdownFile(entry.name)) {
      files.push(entryPath);
    }
  }

  return files;
}

function isTemplateMarkdownFile(fileName: string): boolean {
  return fileName.startsWith("_模板_");
}

async function collectBreakdownDraftFiles(projectRoot: string): Promise<string[]> {
  const rootPath = join(
    projectRoot,
    getDocsStructureResolverForProject(projectRoot).resolveMachineLayerPath("breakdownDrafts")
  );
  if (!existsSync(rootPath)) {
    return [];
  }
  return await collectJsonFiles(rootPath);
}

async function collectJsonFiles(rootPath: string): Promise<string[]> {
  const entries = await readdir(rootPath, {
    withFileTypes: true
  });
  const files: string[] = [];

  for (const entry of entries) {
    const entryPath = join(rootPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectJsonFiles(entryPath)));
      continue;
    }
    if (entry.isFile() && entry.name.toLowerCase().endsWith(".json")) {
      files.push(entryPath);
    }
  }

  return files;
}

async function syncPluginEventJournal(
  prisma: PrismaClient,
  projectId: string,
  projectRoot: string
): Promise<{ projectedCount: number; issues: Array<Record<string, unknown>> }> {
  const journalPath = join(
    projectRoot,
    getDocsStructureResolverForProject(projectRoot).resolveMachineLayerPath("eventJournal")
  );
  if (!existsSync(journalPath)) {
    return { projectedCount: 0, issues: [] };
  }

  const content = await readFile(journalPath, "utf8");
  const issues: Array<Record<string, unknown>> = [];
  let projectedCount = 0;

  for (const [index, line] of content.split(/\r?\n/).entries()) {
    const rawLine = line.trim();
    if (!rawLine) {
      continue;
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(rawLine) as Record<string, unknown>;
    } catch (error) {
      issues.push({
        line: index + 1,
        issue: error instanceof Error ? error.message : "invalid JSON"
      });
      continue;
    }

    const normalized = normalizePluginJournalEvent(parsed, rawLine, index + 1);
    if (!normalized.ok) {
      issues.push(normalized.issue);
      continue;
    }

    const anchorId = await resolvePluginJournalAnchorId(prisma, projectId, normalized.event);

    await withProjectionRetry(
      async () =>
        await primitiveExecutor.run({
          primitive: "project_plugin_event_journal",
          mutationType: "prisma.eventJournal.upsert",
          idempotencyKey: `${projectId}:project_plugin_event_journal:${normalized.event.eventId}`,
          run: async () =>
            await prisma.eventJournal.upsert({
              where: {
                eventId: normalized.event.eventId
              },
              create: {
                eventId: normalized.event.eventId,
                eventType: normalized.event.eventType,
                projectId,
                subjectType: normalized.event.subjectType,
                subjectId: normalized.event.subjectId,
                subjectKey: normalized.event.subjectKey,
                anchorId,
                payloadJson: JSON.stringify(normalized.event.payload),
                emittedAt: normalized.event.emittedAt,
                sourceActor: normalized.event.sourceActor,
                sourceComponent: "ccb-claude-plugin",
                causationId: normalized.event.causationId,
                correlationId: normalized.event.correlationId,
                idempotencyKey: normalized.event.idempotencyKey
              },
              update: {
                eventType: normalized.event.eventType,
                subjectType: normalized.event.subjectType,
                subjectId: normalized.event.subjectId,
                subjectKey: normalized.event.subjectKey,
                anchorId,
                payloadJson: JSON.stringify(normalized.event.payload),
                emittedAt: normalized.event.emittedAt,
                sourceActor: normalized.event.sourceActor,
                sourceComponent: "ccb-claude-plugin",
                causationId: normalized.event.causationId,
                correlationId: normalized.event.correlationId,
                idempotencyKey: normalized.event.idempotencyKey
              }
            })
        })
    );
    if (normalized.event.eventType === "capability_outcome_applied") {
      const capabilityId = typeof normalized.event.payload.capability_id === "string"
        ? normalized.event.payload.capability_id
        : null;
      const outcomeType = typeof normalized.event.payload.outcome_type === "string"
        ? normalized.event.payload.outcome_type
        : null;
      await updateSlotActivityForCapabilityOutcome(prisma, {
        projectId,
        subjectType: normalized.event.subjectType,
        subjectId: normalized.event.subjectId,
        emittedAt: normalized.event.emittedAt,
        capabilityId,
        outcomeType
      });
    }
    projectedCount += 1;
  }

  return { projectedCount, issues };
}

export async function checkPluginJournalWatermark(
  prisma: Pick<PrismaClient, "eventJournal">,
  projectId: string,
  projectRoot: string
): Promise<PluginJournalWatermarkCheckResult> {
  const journalPath = join(
    projectRoot,
    getDocsStructureResolverForProject(projectRoot).resolveMachineLayerPath("eventJournal")
  );
  if (!existsSync(journalPath)) {
    return { status: "missing", journalPath };
  }

  const content = await readFile(journalPath, "utf8");
  const lines = content.split(/\r?\n/);
  let watermark: { eventId: string; line: number } | null = null;

  for (const [index, line] of lines.entries()) {
    const rawLine = line.trim();
    if (!rawLine) {
      continue;
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(rawLine) as Record<string, unknown>;
    } catch (error) {
      return {
        status: "invalid",
        journalPath,
        issue: {
          line: index + 1,
          issue: error instanceof Error ? error.message : "invalid JSON"
        }
      };
    }

    const normalized = normalizePluginJournalEvent(parsed, rawLine, index + 1);
    if (!normalized.ok) {
      return { status: "invalid", journalPath, issue: normalized.issue };
    }
    watermark = { eventId: normalized.event.eventId, line: index + 1 };
  }

  if (!watermark) {
    return { status: "empty", journalPath };
  }

  const row = await prisma.eventJournal.findUnique({
    where: { eventId: watermark.eventId },
    select: { id: true, projectId: true }
  });
  if (row?.projectId === projectId) {
    return { status: "current", journalPath, eventId: watermark.eventId, line: watermark.line };
  }
  return { status: "lagging", journalPath, eventId: watermark.eventId, line: watermark.line };
}

async function resolvePluginJournalAnchorId(
  prisma: PrismaClient,
  projectId: string,
  event: {
    eventType: string;
    subjectType: string;
    subjectId: string;
    anchorId: string | null;
  }
): Promise<string | null> {
  if (event.anchorId) {
    return event.anchorId;
  }
  if (event.eventType !== "slot_stale" || event.subjectType !== "requirement") {
    return null;
  }
  const binding = await prisma.slotBinding.findFirst({
    where: {
      projectId,
      requirementId: event.subjectId
    },
    orderBy: {
      updatedAt: "desc"
    },
    select: {
      slotId: true
    }
  });
  return binding?.slotId ?? null;
}

function normalizePluginJournalEvent(
  event: Record<string, unknown>,
  rawLine: string,
  line: number
):
  | {
      ok: true;
      event: {
        eventId: string;
        eventType: string;
        subjectType: string;
        subjectId: string;
        subjectKey: string | null;
        anchorId: string | null;
        payload: Record<string, unknown>;
        emittedAt: Date;
        sourceActor: string | null;
        causationId: string | null;
        correlationId: string | null;
        idempotencyKey: string | null;
      };
    }
  | { ok: false; issue: Record<string, unknown> } {
  const eventType = normalizeText(event.type as string | undefined);
  const subjectType = normalizeText(event.subject_type as string | undefined);
  const subjectId = normalizeText(event.subject_id as string | undefined);
  const sourceActor = normalizeText(event.source_actor as string | undefined);
  const emittedAtRaw = normalizeText(event.emitted_at as string | undefined);
  const payload = event.payload;
  const emittedAt = emittedAtRaw ? new Date(emittedAtRaw) : null;
  const idempotencyKey = normalizeText(event.idempotency_key as string | undefined);

  if (
    !eventType ||
    !subjectType ||
    !subjectId ||
    !sourceActor ||
    !emittedAt ||
    Number.isNaN(emittedAt.getTime()) ||
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  ) {
    return {
      ok: false,
      issue: {
        line,
        issue: "invalid plugin EventJournal event",
        expected: "type/subject_type/subject_id/emitted_at/source_actor strings and payload object"
      }
    };
  }

  const eventHash = createHash("sha256")
    .update(idempotencyKey ? `idempotency:${idempotencyKey}` : rawLine)
    .digest("hex");
  return {
    ok: true,
    event: {
      eventId: `plugin:${eventHash}`,
      eventType,
      subjectType,
      subjectId,
      subjectKey: normalizeText(event.subject_key as string | undefined),
      anchorId: normalizeText(event.anchor_id as string | undefined),
      payload: payload as Record<string, unknown>,
      emittedAt,
      sourceActor,
      causationId: normalizeText(event.causation_id as string | undefined),
      correlationId: normalizeText(event.correlation_id as string | undefined),
      idempotencyKey
    }
  };
}

function shouldIgnoreScanPath(path: string, projectRoot: string, resolver: DocsStructureResolver): boolean {
  const relativePath = relative(projectRoot, path).replace(/\\/g, "/");
  const normalized = path.replace(/\\/g, "/").toLowerCase();
  return resolver.shouldIgnoreMachineLayerScanPath(relativePath) || normalized.includes("/v0-legacy-archive/");
}

async function writeDocumentMapArtifacts(projectRoot: string, documents: ParsedDocumentRecord[]): Promise<void> {
  const resolver = getDocsStructureResolverForProject(projectRoot);
  const generatedAt = new Date().toISOString();
  const entries = buildDocumentMapEntries(documents, generatedAt, resolver);
  const docMapPath = join(projectRoot, resolver.resolveDocType("doc_map").artifactPath);
  const cachePath = join(projectRoot, resolver.resolveMachineLayerPath("documentMapIndex"));
  const indexDir = dirname(cachePath);

  await mkdir(dirname(docMapPath), { recursive: true });
  await mkdir(indexDir, { recursive: true });
  await writeGeneratedDoc(docMapPath, renderDocumentMapMarkdown(entries, generatedAt), "utf8");
  await writeGeneratedDoc(
    cachePath,
    `${JSON.stringify(
      {
        schema_version: "document-map-index-v0.1",
        generated_at: generatedAt,
        source: "indexer",
        dev_task_paths_by_task_id: buildDevTaskPathIndex(entries),
        documents: entries
      },
      null,
      2
    )}\n`,
    "utf8"
  );
}

export function buildDevTaskPathIndex(entries: DocumentMapEntry[]): Record<string, string[]> {
  const index: Record<string, string[]> = {};
  for (const entry of entries) {
    if (entry.docType !== "dev_task" || !entry.task_id) continue;
    index[entry.task_id] = [...(index[entry.task_id] ?? []), entry.path];
  }
  return index;
}

export function buildDocumentMapEntries(
  documents: ParsedDocumentRecord[],
  generatedAt: string,
  resolver: DocsStructureResolver
): DocumentMapEntry[] {
  const humanDocs = documents.filter((doc) => resolver.isHumanDocsPath(doc.path));
  const requirementStatusById = new Map<string, string>();
  for (const doc of humanDocs) {
    if (doc.kind !== "requirement") continue;
    const id = doc.frontmatter.id?.trim();
    if (id) requirementStatusById.set(id, doc.frontmatter.status?.trim() || "drafting");
  }
  const archiveDirectory = resolver.resolveDocType("archive_index").directory;

  return humanDocs
    .map((doc) => {
      const resolved = resolver.availableDocTypes.includes(doc.kind) ? resolver.resolveDocType(doc.kind) : null;
      const governance = deriveDocumentGovernance(
        {
          kind: doc.kind,
          isArchivePath: doc.path.startsWith(archiveDirectory),
          taskKey: doc.taskKey,
          frontmatter: doc.frontmatter,
          parseStatus: doc.parseStatus
        },
        {
          requirementStatusById,
          docTypeInfo: resolved ? { hasStatus: resolved.hasStatus, followsEntity: resolved.followsEntity } : null
        }
      );
      return {
        path: doc.path,
        docType: doc.kind,
        title: doc.title,
        task_id: governance.taskId,
        tier: governance.tier,
        requirementId: governance.requirementId,
        entityStatus: governance.entityStatus,
        parseStatus: doc.parseStatus,
        updatedAt: parseDate(doc.frontmatter.updated)?.toISOString() ?? doc.mtime.toISOString() ?? generatedAt
      };
    })
    .sort((a, b) => {
      const tierDelta = DOC_MAP_TIER_ORDER.indexOf(a.tier) - DOC_MAP_TIER_ORDER.indexOf(b.tier);
      return tierDelta === 0 ? a.path.localeCompare(b.path) : tierDelta;
    });
}

function renderDocumentMapMarkdown(entries: DocumentMapEntry[], generatedAt: string): string {
  const sections = DOC_MAP_TIER_ORDER.map((tier) => {
    const tierEntries = entries.filter((entry) => entry.tier === tier);
    const rows =
      tierEntries.length > 0
        ? tierEntries.map((entry) =>
            [
              `| ${escapeMarkdownTable(entry.docType)}`,
              escapeMarkdownTable(entry.title),
              `\`${entry.path}\``,
              entry.requirementId ? `\`${entry.requirementId}\`` : "",
              entry.entityStatus ?? "",
              entry.parseStatus,
              "|"
            ].join(" | ")
          )
        : ["|  |  |  |  |  |  |"];
    return [`## ${tier}`, "", "| 类型 | 标题 | 路径 | 绑定需求 | 实体状态 | 健康度 |", "|---|---|---|---|---|---|", ...rows].join("\n");
  });

  return [
    "---",
    "doc_type: doc_map",
    "maintained_by: generated",
    `updated: ${generatedAt}`,
    "---",
    "",
    "# 文档地图",
    "",
    "> 由 Console indexer 自动生成；状态档位由位置与绑定实体状态派生。",
    "",
    ...sections,
    ""
  ].join("\n");
}

function escapeMarkdownTable(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

export type DeriveTaskDocument = {
  id: string;
  taskKey: string | null;
  path: string;
  kind: string;
  title: string;
  status: string | null;
  summary: string | null;
  contentHash: string;
  frontmatterJson: string | null;
  updatedAt?: Date | string | null;
};

type PersistedDeriveTaskDocument = DeriveTaskDocument & {
  parseStatus: string;
  parseError: string | null;
};

function selectTaskProjectionInputDocuments(documents: PersistedDeriveTaskDocument[]): {
  documents: DeriveTaskDocument[];
  anomalies: VerifyAnomaly[];
} {
  return {
    documents: documents.filter((document) => document.parseStatus === "success"),
    anomalies: []
  };
}

export function deriveTasks(documents: DeriveTaskDocument[]): DeriveTasksResult {
  const grouped = new Map<string, DeriveTaskDocument[]>();

  for (const document of documents) {
    if (!isTaskDocumentKind(document.kind)) {
      continue;
    }

    const taskKey = document.taskKey?.trim();
    if (!taskKey) {
      continue;
    }

    const bucket = grouped.get(taskKey) ?? [];
    bucket.push(document);
    grouped.set(taskKey, bucket);
  }

  const anomalies: VerifyAnomaly[] = [];

  const tasks: DerivedTaskProjection[] = [];

  for (const [taskKey, items] of grouped) {
    const devTaskDocument = items.find((item) => item.kind === "dev_task") ?? null;
    if (!devTaskDocument) {
      continue;
    }
    const frontmatter = parseJsonRecord(devTaskDocument.frontmatterJson);
    const rawRequirementId =
      normalizeText(frontmatter.requirement_id) ??
      normalizeText(frontmatter.requirementId);
    const specSectionId =
      normalizeText(frontmatter.section_id) ??
      normalizeText(frontmatter.specSectionId);
    const implementationOwner =
      normalizeImplementationOwner(frontmatter.implementation_owner) ??
      normalizeImplementationOwner(frontmatter.implementationOwner);
    const devTaskCurrentNode =
      normalizeText(frontmatter.currentNode) ?? normalizeText(frontmatter.current_node);
    const explicitStatus = normalizeText(devTaskDocument.status);
    const explicitPhase = normalizeText(frontmatter.phase);
    const frontmatterCurrentNode =
      normalizeText(frontmatter.currentNode) ?? normalizeText(frontmatter.current_node);
    let currentNode = frontmatterCurrentNode;
    const nodeSubstate = normalizeText(frontmatter.nodeSubstate) ?? normalizeText(frontmatter.node_substate);
    let runtimeState = normalizeText(frontmatter.runtimeState) ?? normalizeText(frontmatter.runtime_state);
    const lastTransitionId =
      normalizeText(frontmatter.lastTransitionId) ?? normalizeText(frontmatter.last_transition_id);
    const priority = normalizePriority(frontmatter.priority);
    const blockedReason = normalizeText(frontmatter.blocked_reason) ?? normalizeText(frontmatter.blockedReason);
    const reviewStatus =
      normalizeText(frontmatter.review_status) ??
      normalizeText(frontmatter.reviewStatus);
    const verificationResultJson = normalizeJsonProjection(
      frontmatter.verification_result ??
        frontmatter.verificationResult
    );
    const reviewFollowupJson = normalizeJsonProjection(
      frontmatter.review_followup ??
        frontmatter.reviewFollowup
    );
    const progress = normalizeTaskProgress(frontmatter.progress, explicitPhase, explicitStatus);

    let derivedStatus = normalizeTaskStatus(explicitStatus);

    if (devTaskDocument && devTaskCurrentNode && !VALID_TASK_CURRENT_NODES.has(devTaskCurrentNode)) {
      anomalies.push({
        category: "invalid_current_node",
        taskKey,
        detail: {
          observedValue: devTaskCurrentNode,
          path: devTaskDocument.path
        }
      });
      continue;
    }

    tasks.push({
      taskKey,
      title: devTaskDocument.title ?? taskKey,
      summary: devTaskDocument.summary ?? null,
      status: derivedStatus,
      currentNode,
      nodeSubstate,
      runtimeState,
      lastTransitionId,
      priority,
      progress,
      primaryDocumentId: devTaskDocument.id,
      requirementId: rawRequirementId,
      specSectionId,
      implementationOwner,
      blockedReason,
      reviewStatus,
      verificationResultJson,
      reviewFollowupJson
    });
  }

  return { tasks, anomalies };
}

function isTaskDocumentKind(kind: string): boolean {
  return TASK_DOCUMENT_KINDS.has(kind.trim().toLowerCase());
}

function normalizeStep(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string") {
    const match = value.trim().match(/^(\d+)/);
    if (match) {
      return Number.parseInt(match[1], 10);
    }
  }
  return null;
}

function normalizeTaskStatus(status: string | null): string {
  const normalized = status?.toLowerCase();
  if (!normalized) return "reviewing";
  if (normalized === "reviewing" || normalized === "done" || normalized === "cancelled") return normalized;
  if (["active", "planning", "dispatch_ready", "dispatched", "implementing", "blocked", "paused"].includes(normalized)) {
    return "reviewing";
  }
  if (["done", "completed", "complete"].includes(normalized)) return "done";
  if (normalized === "archived") return "done";
  return "reviewing";
}

function normalizePriority(priority: string | undefined): string {
  const normalized = priority?.trim().toLowerCase();
  if (!normalized) return "medium";
  if (["low", "medium", "high", "urgent"].includes(normalized)) {
    return normalized;
  }
  return "medium";
}

function normalizeImplementationOwner(value: string | null | undefined): string | null {
  const normalized = normalizeText(value);
  if (normalized === "claude" || normalized === "ccb_codex") {
    return normalized;
  }
  return null;
}

function normalizeTaskProgress(progressValue: string | undefined, phase: string | null, status: string | null): number {
  const explicitProgress = Number(progressValue);
  if (Number.isFinite(explicitProgress)) {
    return Math.min(100, Math.max(0, explicitProgress));
  }

  const normalizedStatus = status?.toLowerCase();
  if (["done", "completed", "complete", "archived"].includes(normalizedStatus ?? "")) {
    return 100;
  }

  switch (phase) {
    case "requirement":
      return 10;
    case "planning":
      return 30;
    case "ready":
      return 45;
    case "implementing":
      return 60;
    case "reviewing":
      return 80;
    case "blocked":
      return 50;
    case "done":
    case "archived":
      return 100;
    default:
      return 20;
  }
}

async function writeGeneratedDoc(filePath: string, content: string, encoding: BufferEncoding): Promise<void> {
  const contentHash = createHash("sha256").update(content, encoding).digest("hex").slice(0, 24);
  await primitiveExecutor.run({
    primitive: "write_generated_doc",
    mutationType: "fs.writeFile",
    idempotencyKey: `write_generated_doc:${filePath}:${contentHash}`,
    run: async () => {
      await writeFile(filePath, content, encoding);
      return { path: filePath, contentHash };
    }
  });
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function parseJsonRecord(value: string | null | undefined): Record<string, string> {
  if (!value) {
    return {};
  }

  try {
    return JSON.parse(value) as Record<string, string>;
  } catch {
    return {};
  }
}

function normalizeText(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function normalizeJsonProjection(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }

  try {
    return JSON.stringify(JSON.parse(trimmed));
  } catch {
    return JSON.stringify(trimmed);
  }
}
