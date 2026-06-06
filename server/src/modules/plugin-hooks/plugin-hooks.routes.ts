import { isAbsolute, resolve } from "node:path";

import type { PrismaClient } from "@prisma/client";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import { prisma } from "../../db/prisma.js";
import {
  checkPluginJournalWatermark,
  startProjectScan as defaultScanProject
} from "../../indexer/project-indexer.js";
import {
  reindexBreakdownDraftForRequirement as defaultReindexBreakdownDraftForRequirement,
  reindexRequirementDesignDocFromMarkdown as defaultReindexRequirementDesignDocFromMarkdown,
  reindexRequirementFromMarkdown as defaultReindexRequirementFromMarkdown
} from "../requirement/requirement-reindex.service.js";
import { updateSlotActivityForCapabilityOutcome } from "../slot-binding/slot-binding.service.js";

const LOCAL_IPS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const DEFAULT_DEBOUNCE_MS = 200;
const DEFAULT_JOURNAL_RECONCILE_COOLDOWN_MS = 30_000;

type ScanProjectFn = (prismaClient: PrismaClient, projectId: string) => Promise<unknown>;
type ReindexRequirementFromMarkdownFn = (
  prismaClient: PrismaClient,
  projectId: string,
  requirementId: string
) => Promise<unknown>;
type ReindexRequirementDesignDocFromMarkdownFn = (
  prismaClient: PrismaClient,
  projectId: string,
  filePath: string,
  requirementId: string
) => Promise<unknown>;
type ReindexBreakdownDraftForRequirementFn = (
  prismaClient: PrismaClient,
  projectId: string,
  requirementId: string,
  filePath?: string
) => Promise<unknown>;

export interface PluginHookRouteDependencies {
  prismaClient?: PrismaClient;
  scanProject?: ScanProjectFn;
  reindexRequirementFromMarkdown?: ReindexRequirementFromMarkdownFn;
  reindexRequirementDesignDocFromMarkdown?: ReindexRequirementDesignDocFromMarkdownFn;
  reindexBreakdownDraftForRequirement?: ReindexBreakdownDraftForRequirementFn;
  debounceMs?: number;
  journalReconcileCooldownMs?: number;
}

const pluginEventSchema = z
  .object({
    type: z.string().trim().min(1),
    subject_type: z.string().trim().min(1),
    subject_id: z.string().trim().min(1),
    payload: z.record(z.unknown()),
    idempotency_key: z.string().trim().min(1).nullable().optional(),
    emitted_at: z.string().datetime(),
    source_actor: z.string().trim().min(1)
  })
  .passthrough();

const pluginHookEnvelopeSchema = z
  .object({
    schema_version: z.literal("plugin-hook-v0.1"),
    source: z.literal("ccb-claude-plugin"),
    project_root: z
      .string()
      .trim()
      .min(1)
      .refine((value) => isAbsolute(value), "project_root must be an absolute path"),
    journal_path: z.string().trim().min(1),
    event_hash: z.string().regex(/^[a-f0-9]{64}$/),
    event: pluginEventSchema
  })
  .strict();

export async function registerPluginHookRoutes(
  app: FastifyInstance,
  dependencies: PluginHookRouteDependencies = {}
): Promise<void> {
  const db = dependencies.prismaClient ?? prisma;
  const scanProject = dependencies.scanProject ?? defaultScanProject;
  const reindexRequirementFromMarkdown =
    dependencies.reindexRequirementFromMarkdown ?? defaultReindexRequirementFromMarkdown;
  const reindexRequirementDesignDocFromMarkdown =
    dependencies.reindexRequirementDesignDocFromMarkdown ?? defaultReindexRequirementDesignDocFromMarkdown;
  const reindexBreakdownDraftForRequirement =
    dependencies.reindexBreakdownDraftForRequirement ?? defaultReindexBreakdownDraftForRequirement;
  const debounceMs = dependencies.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const journalReconcileCooldownMs =
    dependencies.journalReconcileCooldownMs ?? DEFAULT_JOURNAL_RECONCILE_COOLDOWN_MS;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const journalReconcileCooldowns = new Map<string, number>();

  app.addHook("onClose", async () => {
    for (const timer of timers.values()) {
      clearTimeout(timer);
    }
    timers.clear();
  });

  app.post("/api/plugin-hooks/event-journal", async (request, reply) => {
    if (!isLocalRequest(request)) {
      reply.status(403);
      return { message: "plugin hook 仅允许 localhost 调用" };
    }
    if (hasBrowserOriginHeaders(request)) {
      reply.status(403);
      return { message: "plugin hook 不接受浏览器 origin/referer 请求" };
    }

    const parsed = pluginHookEnvelopeSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.status(400);
      return {
        message: "plugin hook envelope 参数不合法",
        issues: parsed.error.issues
      };
    }

    const projectRoot = resolve(parsed.data.project_root);
    const project = await db.project.findFirst({
      where: {
        localPath: projectRoot
      },
      select: {
        id: true
      }
    });

    if (!project) {
      return {
        ok: true,
        projectFound: false,
        scanQueued: false
      };
    }

    if (parsed.data.event.type === "capability_outcome_applied") {
      const capabilityId = payloadString(parsed.data.event.payload, "capability_id") ?? null;
      const outcomeType = payloadString(parsed.data.event.payload, "outcome_type") ?? null;
      await updateSlotActivityForCapabilityOutcome(db, {
        projectId: project.id,
        subjectType: parsed.data.event.subject_type,
        subjectId: parsed.data.event.subject_id,
        emittedAt: new Date(parsed.data.event.emitted_at),
        capabilityId,
        outcomeType
      });
    }

    const artifactScanQueued = await dispatchArtifactReindex(parsed.data.event, project.id);
    const journalScanQueued = await shouldQueueJournalWatermarkScan(project.id, projectRoot);
    const scanQueued = artifactScanQueued || journalScanQueued;
    if (scanQueued) {
      queueProjectScan(project.id);
    }
    reply.status(202);
    return {
      ok: true,
      projectFound: true,
      scanQueued
    };
  });

  async function dispatchArtifactReindex(
    event: z.infer<typeof pluginEventSchema>,
    projectId: string
  ): Promise<boolean> {
    const artifact = classifyArtifactEvent(event);
    if (artifact.kind === "none") {
      return false;
    }
    if (artifact.kind === "unknown") {
      return true;
    }

    try {
      if (artifact.kind === "technical_design") {
        await reindexRequirementDesignDocFromMarkdown(db, projectId, artifact.path, artifact.requirementId);
        return false;
      }
      if (artifact.kind === "breakdown_draft") {
        await reindexBreakdownDraftForRequirement(db, projectId, artifact.requirementId, artifact.path);
        return false;
      }
      await reindexRequirementFromMarkdown(db, projectId, artifact.requirementId);
      return false;
    } catch (error) {
      app.log.warn(
        { err: error, projectId, eventType: event.type, subjectType: event.subject_type, subjectId: event.subject_id },
        "plugin hook artifact reindex failed; queued project scan fallback"
      );
      return true;
    }
  }

  async function shouldQueueJournalWatermarkScan(projectId: string, projectRoot: string): Promise<boolean> {
    let result;
    try {
      result = await checkPluginJournalWatermark(db, projectId, projectRoot);
    } catch (error) {
      app.log.warn(
        { err: error, projectId, event: "plugin_journal.watermark_check_failed" },
        "plugin journal watermark check failed; skipped project scan reconcile"
      );
      return false;
    }

    if (result.status === "current") {
      journalReconcileCooldowns.delete(journalWatermarkCooldownKey(projectId, result.journalPath, result.eventId));
      return false;
    }
    if (result.status === "lagging") {
      const key = journalWatermarkCooldownKey(projectId, result.journalPath, result.eventId);
      const now = Date.now();
      const lastQueuedAt = journalReconcileCooldowns.get(key);
      if (lastQueuedAt && now - lastQueuedAt < journalReconcileCooldownMs) {
        return false;
      }
      journalReconcileCooldowns.set(key, now);
      app.log.warn(
        { projectId, journalPath: result.journalPath, eventId: result.eventId, line: result.line },
        "plugin journal DB watermark lagging; queued project scan reconcile"
      );
      return true;
    }

    app.log.warn(
      { projectId, journalPath: result.journalPath, status: result.status, issue: "issue" in result ? result.issue : null },
      "plugin journal watermark unavailable; skipped project scan reconcile"
    );
    return false;
  }

  function queueProjectScan(projectId: string): void {
    const existing = timers.get(projectId);
    if (existing) {
      clearTimeout(existing);
    }
    const timer = setTimeout(() => {
      timers.delete(projectId);
      scanProject(db, projectId).catch((error: unknown) => {
        app.log.error({ err: error, projectId }, "plugin hook project scan start failed");
      });
    }, debounceMs);
    timer.unref?.();
    timers.set(projectId, timer);
  }
}

function journalWatermarkCooldownKey(projectId: string, journalPath: string, eventId: string): string {
  return `${projectId}:${journalPath}:${eventId}`;
}

function isLocalRequest(request: FastifyRequest): boolean {
  const ip = request.ip || request.socket.remoteAddress || "";
  return LOCAL_IPS.has(ip);
}

function hasBrowserOriginHeaders(request: FastifyRequest): boolean {
  return Boolean(request.headers.origin || request.headers.referer);
}

type ArtifactDispatch =
  | { kind: "none" }
  | { kind: "unknown" }
  | { kind: "requirement_md"; requirementId: string }
  | { kind: "technical_design"; requirementId: string; path: string }
  | { kind: "breakdown_draft"; requirementId: string; path?: string };

function classifyArtifactEvent(event: z.infer<typeof pluginEventSchema>): ArtifactDispatch {
  if (event.type.startsWith("breakdown_draft_")) {
    return event.subject_type === "requirement"
      ? { kind: "breakdown_draft", requirementId: event.subject_id, path: payloadString(event.payload, "path") }
      : { kind: "unknown" };
  }

  if (event.type !== "file_written") {
    return { kind: "none" };
  }

  const artifactType =
    payloadString(event.payload, "resource_type") ??
    payloadString(event.payload, "artifact_type") ??
    payloadString(event.payload, "doc_type");
  const path = payloadString(event.payload, "path");

  if (artifactType === "technical_design") {
    return event.subject_type === "requirement" && path
      ? { kind: "technical_design", requirementId: event.subject_id, path }
      : { kind: "unknown" };
  }

  if (artifactType === "breakdown_draft" || path?.includes("docs/.ccb/drafts/breakdown/")) {
    return event.subject_type === "requirement"
      ? { kind: "breakdown_draft", requirementId: event.subject_id, path }
      : { kind: "unknown" };
  }

  if (artifactType === "dev_task" || path?.includes("docs/03_开发计划/")) {
    return { kind: "unknown" };
  }

  const isRequirementPath = path?.includes("docs/02_需求设计/");
  if (
    event.subject_type === "requirement" &&
    (artifactType === "requirement_md" ||
      typeof event.payload.analysis_input_hash === "string" ||
      Boolean(isRequirementPath) ||
      (!artifactType && !path))
  ) {
    return { kind: "requirement_md", requirementId: event.subject_id };
  }

  return { kind: "unknown" };
}

function payloadString(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
