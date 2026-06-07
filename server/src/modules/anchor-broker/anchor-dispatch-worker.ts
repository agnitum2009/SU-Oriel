import { randomUUID } from "node:crypto";

import type { AnchorDispatchQueue, PrismaClient } from "@prisma/client";

import { prisma } from "../../db/prisma.js";
import { CcbdClientService } from "../ccbd-client/ccbd-client.service.js";
import { emitEventInTransaction } from "../events/event-journal.service.js";
import type { ManagedConfigMutationLock } from "../project-ccbd/managed-config-mutation-lock.js";
import { claudeAgentForSlot } from "../slot-binding/job-slot-router.js";
import { isSlotId } from "../slot-binding/slot-binding.service.js";
import {
  DEFAULT_SLOT_RESIZE_LOCK_WAIT_TIMEOUT_MS,
  isSlotResizeLockTimeoutError,
  runWithSlotResizeLock
} from "../slot-resize/resize-lock.js";
import { AnchorBrokerError, AnchorNotFoundError } from "./anchor-broker.errors.js";
import type { AskAcrossAnchorInput } from "./ask-router.service.js";
import { AskRouterService } from "./ask-router.service.js";
import { MultiAnchorBrokerService } from "./broker.service.js";
import {
  waitForClaudeTuiReady as defaultWaitForClaudeTuiReady,
  type ClaudeTuiReadinessResult
} from "./claude-pane-readiness.js";

export interface AnchorDispatchWorkerHandle {
  stop: () => Promise<void>;
}

export interface AnchorDispatchWorkerLogger {
  debug?: (payload: unknown, message?: string) => void;
  info?: (payload: unknown, message?: string) => void;
  warn?: (payload: unknown, message?: string) => void;
  error?: (payload: unknown, message?: string) => void;
}

export interface StartAnchorDispatchWorkerOptions {
  pollIntervalMs?: number;
  batchSize?: number;
  prismaClient?: PrismaClient;
  askRouter?: Pick<AskRouterService, "askAcrossAnchor">;
  waitForClaudeTuiReady?: (anchorPath: string) => Promise<ClaudeTuiReadinessResult>;
  logger?: AnchorDispatchWorkerLogger;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  resizeLock?: ManagedConfigMutationLock;
  resizeLockWaitTimeoutMs?: number;
}

export interface AnchorDispatchWorkerTickResult {
  count: number;
  submitted: number;
  failed: number;
}

interface WorkerConfig {
  pollIntervalMs: number;
  batchSize: number;
  prismaClient: PrismaClient;
  askRouter: Pick<AskRouterService, "askAcrossAnchor">;
  waitForClaudeTuiReady: (anchorPath: string) => Promise<ClaudeTuiReadinessResult>;
  logger?: AnchorDispatchWorkerLogger;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  resizeLock?: ManagedConfigMutationLock;
  resizeLockWaitTimeoutMs: number;
}

type DispatchProject = {
  id: string;
  localPath: string;
  slotCount: number;
  taskKey?: string | null;
};

const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_BATCH_SIZE = 20;

export function startAnchorDispatchWorker(options: StartAnchorDispatchWorkerOptions = {}): AnchorDispatchWorkerHandle {
  const config = normalizeOptions(options);
  let stopRequested = false;

  const loopPromise = (async () => {
    while (!stopRequested) {
      try {
        await runAnchorDispatchWorkerTickWithConfig(config);
      } catch (error) {
        config.logger?.error?.(
          { event: "anchor_dispatch_worker.tick.failed", error: errorMessage(error) },
          "anchor_dispatch_worker.tick.failed"
        );
      }

      if (!stopRequested) {
        await config.sleep(config.pollIntervalMs);
      }
    }
  })();

  return {
    stop: async () => {
      stopRequested = true;
      await loopPromise;
    }
  };
}

export async function runAnchorDispatchWorkerTick(
  options: StartAnchorDispatchWorkerOptions = {}
): Promise<AnchorDispatchWorkerTickResult> {
  return await runAnchorDispatchWorkerTickWithConfig(normalizeOptions(options));
}

function normalizeOptions(options: StartAnchorDispatchWorkerOptions): WorkerConfig {
  const prismaClient = options.prismaClient ?? prisma;
  const broker = new MultiAnchorBrokerService(prismaClient);
  const ccbdClient = new CcbdClientService({
    anchorSocketResolver: async (anchorId) => await broker.resolveAnchor(anchorId)
  });

  return {
    pollIntervalMs: options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    batchSize: options.batchSize ?? DEFAULT_BATCH_SIZE,
    prismaClient,
    askRouter: options.askRouter ?? new AskRouterService(broker, ccbdClient),
    waitForClaudeTuiReady: options.waitForClaudeTuiReady ?? defaultWaitForClaudeTuiReady,
    logger: options.logger,
    now: options.now ?? (() => new Date()),
    sleep: options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    resizeLock: options.resizeLock,
    resizeLockWaitTimeoutMs: options.resizeLockWaitTimeoutMs ?? DEFAULT_SLOT_RESIZE_LOCK_WAIT_TIMEOUT_MS
  };
}

async function runAnchorDispatchWorkerTickWithConfig(
  config: WorkerConfig
): Promise<AnchorDispatchWorkerTickResult> {
  const rows = await config.prismaClient.anchorDispatchQueue.findMany({
    where: {
      projectId: {
        not: null
      },
      status: "pending",
      anchorId: {
        not: "slot-unassigned"
      }
    },
    orderBy: {
      queuedAt: "asc"
    },
    take: config.batchSize
  });

  if (rows.length === 0) {
    config.logger?.debug?.({ event: "anchor_dispatch_worker.tick.empty" }, "anchor_dispatch_worker.tick.empty");
    return { count: 0, submitted: 0, failed: 0 };
  }

  let submitted = 0;
  let failed = 0;
  for (const row of rows) {
    const result = await processAnchorDispatchRow(config, row);
    if (result === "submitted") {
      submitted++;
    } else {
      failed++;
    }
  }

  config.logger?.info?.(
    { event: "anchor_dispatch_worker.tick.processed", count: rows.length, submitted, failed },
    "anchor_dispatch_worker.tick.processed"
  );
  return { count: rows.length, submitted, failed };
}

async function processAnchorDispatchRow(
  config: WorkerConfig,
  row: AnchorDispatchQueue
): Promise<"submitted" | "failed"> {
  try {
    const projectId = row.projectId;
    if (!projectId) {
      throw new Error("dispatch project scope missing");
    }
    if (isSlotId(row.anchorId)) {
      const project = await resolveProjectForDispatchSubject(config.prismaClient, row, projectId);
      if (!project) {
        throw new Error(`dispatch subject not found: ${row.subjectType}:${row.subjectId}`);
      }
      if (!isSlotId(row.anchorId, project.slotCount)) {
        throw new Error(`slot ${row.anchorId} is outside project topology`);
      }
      return await runWithSlotResizeLock(
        project.id,
        async () => await processSlotDispatchRow(config, row, project),
        {
          lock: config.resizeLock,
          timeoutMs: config.resizeLockWaitTimeoutMs
        }
      );
    }
    const askInput = await buildAskInput(config.prismaClient, row, projectId);
    const anchor = await config.prismaClient.anchorAllocation.findUnique({
      where: {
        anchorId: row.anchorId
      }
    });
    if (!anchor || anchor.state === "destroyed") {
      throw new AnchorNotFoundError(row.anchorId);
    }
    if (anchor.projectId && anchor.projectId !== projectId) {
      throw new Error(`dispatch anchor project mismatch: ${row.anchorId}`);
    }

    const readiness = await config.waitForClaudeTuiReady(anchor.anchorPath);
    const readinessWarning = !readiness.ready;
    if (readinessWarning) {
      config.logger?.warn?.(
        { anchorId: row.anchorId, elapsedMs: readiness.elapsedMs, lastTitles: readiness.lastTitles },
        "anchor dispatch readiness probe timed out; submitting command anyway"
      );
    }

    const result = await config.askRouter.askAcrossAnchor(askInput);
    await config.prismaClient.$transaction(async (tx) => {
      await tx.anchorDispatchQueue.update({
        where: {
          id: row.id
        },
        data: {
          status: "submitted",
          submittedAt: config.now(),
          readinessWarning,
          errorMessage: null
        }
      });
      await emitEventInTransaction(tx, {
        event_id: randomUUID(),
        event_type: "anchor_dispatch_submitted",
        subject_type: row.subjectType === "requirement" ? "requirement" : "subtask",
        subject_id: row.subjectId,
        anchor_id: row.anchorId,
        emitted_at: config.now().toISOString(),
        source_actor: "system",
        source_component: "console",
        correlation_id: row.jobId,
        payload: {
          jobId: row.jobId,
          ...(result.traceRef ? { traceRef: result.traceRef } : {}),
          readinessWarning
        }
      });
    });
    return "submitted";
  } catch (error) {
    await recordAnchorDispatchFailure(config, row, error);
    return "failed";
  }
}

async function processSlotDispatchRow(
  config: WorkerConfig,
  row: AnchorDispatchQueue,
  project: DispatchProject
): Promise<"submitted" | "failed"> {
  const readiness = await config.waitForClaudeTuiReady(project.localPath);
  const readinessWarning = !readiness.ready;
  if (readinessWarning) {
    config.logger?.warn?.(
      { slotId: row.anchorId, elapsedMs: readiness.elapsedMs, lastTitles: readiness.lastTitles },
      "slot dispatch readiness probe timed out; submitting command anyway"
    );
  }

  const client = new CcbdClientService({ projectRoot: project.localPath });
  const taskId = row.subjectType === "subtask" && project.taskKey ? project.taskKey : row.subjectId;
  const result = await client.submit({
    toAgent: claudeAgentForSlot(row.anchorId),
    taskId,
    body: row.command,
    fromActor: "system",
    messageType: "ask"
  });

  await config.prismaClient.$transaction(async (tx) => {
    await tx.anchorDispatchQueue.update({
      where: { id: row.id },
      data: {
        status: "submitted",
        submittedAt: config.now(),
        readinessWarning,
        errorMessage: null
      }
    });
    await tx.slotBinding.updateMany({
      where: {
        projectId: project.id,
        slotId: row.anchorId
      },
      data: {
        state: "busy",
        busySince: config.now()
      }
    });
    await emitEventInTransaction(tx, {
      event_id: randomUUID(),
      event_type: "anchor_dispatch_submitted",
      subject_type: row.subjectType === "requirement" ? "requirement" : "subtask",
      subject_id: row.subjectId,
      anchor_id: row.anchorId,
      emitted_at: config.now().toISOString(),
      source_actor: "system",
      source_component: "console",
      correlation_id: row.jobId,
      payload: {
        jobId: row.jobId,
        ...(result.traceRef ? { traceRef: result.traceRef } : {}),
        readinessWarning
      }
    });
  });
  return "submitted";
}

async function buildAskInput(
  db: PrismaClient,
  row: AnchorDispatchQueue,
  projectId: string
): Promise<AskAcrossAnchorInput> {
  if (row.subjectType === "requirement") {
    const requirement = await db.requirement.findFirst({
      where: {
        id: row.subjectId,
        projectId
      },
      select: {
        id: true
      }
    });
    if (!requirement) {
      throw new Error(`dispatch subject not found: ${row.subjectType}:${row.subjectId}`);
    }
    return {
      targetAnchorId: row.anchorId,
      toAgent: "ccb_claude",
      taskId: row.subjectId,
      body: row.command
    };
  }

  if (row.subjectType === "subtask") {
    const task = await db.task.findFirst({
      where: {
        id: row.subjectId,
        projectId
      },
      select: {
        taskKey: true
      }
    });
    if (!task) {
      throw new Error(`dispatch subject not found: ${row.subjectType}:${row.subjectId}`);
    }
    return {
      targetAnchorId: row.anchorId,
      toAgent: "ccb_claude",
      taskId: task.taskKey,
      body: row.command
    };
  }

  throw new Error(`unsupported dispatch subjectType: ${row.subjectType}`);
}

async function resolveProjectForDispatchSubject(
  db: PrismaClient,
  row: AnchorDispatchQueue,
  projectId: string
): Promise<DispatchProject | null> {
  if (row.subjectType === "requirement") {
    const requirement = await db.requirement.findFirst({
      where: { id: row.subjectId, projectId },
      select: {
        project: {
          select: { id: true, localPath: true, slotCount: true }
        }
      }
    });
    return requirement?.project ?? null;
  }
  if (row.subjectType === "subtask") {
    const task = await db.task.findFirst({
      where: { id: row.subjectId, projectId },
      select: {
        taskKey: true,
        project: {
          select: { id: true, localPath: true, slotCount: true }
        }
      }
    });
    return task ? { ...task.project, taskKey: task.taskKey } : null;
  }
  return null;
}

async function recordAnchorDispatchFailure(
  config: WorkerConfig,
  row: AnchorDispatchQueue,
  error: unknown
): Promise<void> {
  const message = errorMessage(error);
  const errorCode = isSlotResizeLockTimeoutError(error)
    ? error.code
    : error instanceof AnchorBrokerError ? error.code : "ANCHOR_DISPATCH_FAILED";
  await config.prismaClient.$transaction(async (tx) => {
    await tx.anchorDispatchQueue.update({
      where: {
        id: row.id
      },
      data: {
        status: "failed",
        failedAt: config.now(),
        errorMessage: message
      }
    });
    await emitEventInTransaction(tx, {
      event_id: randomUUID(),
      event_type: "anchor_dispatch_failed",
      subject_type: row.subjectType === "requirement" ? "requirement" : "subtask",
      subject_id: row.subjectId,
      anchor_id: row.anchorId,
      emitted_at: config.now().toISOString(),
      source_actor: "system",
      source_component: "console",
      correlation_id: row.jobId,
      payload: {
        jobId: row.jobId,
        errorCode,
        errorMessage: message
      }
    });
  });
  config.logger?.warn?.(
    { event: "anchor_dispatch_worker.dispatch.failed", jobId: row.jobId, errorCode, error: message },
    "anchor_dispatch_worker.dispatch.failed"
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
