import type { PrismaClient } from "@prisma/client";

import { prisma, ensureSqlitePragmas } from "./db/prisma.js";
import {
  startAnchorDispatchWorker as startAnchorDispatchWorkerLoop,
  type AnchorDispatchWorkerHandle,
  type AnchorDispatchWorkerLogger,
  type StartAnchorDispatchWorkerOptions
} from "./modules/anchor-broker/anchor-dispatch-worker.js";
import { recoverProjectCcbdsOnStartup as recoverProjectCcbdsOnStartupLoop } from "./modules/project-ccbd/project-ccbd-manager.js";
import { JobSlotRouter } from "./modules/slot-binding/job-slot-router.js";
import { SlotStaleDetector } from "./modules/slot-binding/slot-stale-detector.js";

export interface ProjectionServicesHandle {
  stop: () => Promise<void>;
}

export type ProjectionBootstrapLogger = AnchorDispatchWorkerLogger;

type AnchorDispatchWorkerStarter = (options: StartAnchorDispatchWorkerOptions) => AnchorDispatchWorkerHandle;
type SlotStaleDetectorHandle = { stop: () => Promise<void> };
type SlotQueueDrainHandle = { stop: () => Promise<void> };
type ProjectCcbdRecoveryStarter = (options: {
  prismaClient: PrismaClient;
  logger?: ProjectionBootstrapLogger;
}) => Promise<unknown>;
type SlotStaleDetectorStarter = (options: {
  prismaClient: PrismaClient;
  logger?: ProjectionBootstrapLogger;
}) => SlotStaleDetectorHandle;
type SlotQueueDrainStarter = (options: {
  prismaClient: PrismaClient;
  logger?: ProjectionBootstrapLogger;
}) => SlotQueueDrainHandle;

export interface StartProjectionServicesOptions {
  prismaClient?: PrismaClient;
  logger?: ProjectionBootstrapLogger;
  startAnchorDispatchWorker?: AnchorDispatchWorkerStarter;
  anchorDispatchWorkerOptions?: Omit<StartAnchorDispatchWorkerOptions, "prismaClient" | "logger">;
  recoverProjectCcbdsOnStartup?: ProjectCcbdRecoveryStarter;
  startSlotStaleDetector?: SlotStaleDetectorStarter;
  startSlotQueueDrain?: SlotQueueDrainStarter;
}

export async function startProjectionServices(
  options: StartProjectionServicesOptions = {}
): Promise<ProjectionServicesHandle> {
  const prismaClient = options.prismaClient ?? prisma;
  const logger = options.logger;
  const startAnchorWorker = options.startAnchorDispatchWorker ?? startAnchorDispatchWorkerLoop;
  const recoverProjectCcbdsOnStartup = options.recoverProjectCcbdsOnStartup ?? recoverProjectCcbdsOnStartupLoop;
  const startSlotStaleDetector = options.startSlotStaleDetector ?? startSlotStaleDetectorLoop;
  const startSlotQueueDrain = options.startSlotQueueDrain ?? startSlotQueueDrainLoop;

  // SQLite WAL / busy_timeout 必须在任何后台轮询发起查询前落库，
  // 否则首轮 drain/dispatch 可能跑在 PRAGMA 之前。
  await ensureSqlitePragmas();

  await recoverProjectCcbdsOnStartup({
    prismaClient,
    logger
  });

  const anchorDispatchWorkerHandle = startAnchorWorker({
    ...options.anchorDispatchWorkerOptions,
    prismaClient,
    logger
  });
  const slotStaleDetectorHandle = startSlotStaleDetector({
    prismaClient,
    logger
  });
  const slotQueueDrainHandle = startSlotQueueDrain({
    prismaClient,
    logger
  });

  let stopPromise: Promise<void> | null = null;
  return {
    stop: async () => {
      stopPromise ??= stopProjectionServices(anchorDispatchWorkerHandle, slotStaleDetectorHandle, slotQueueDrainHandle);
      await stopPromise;
    }
  };
}

function startSlotStaleDetectorLoop(options: {
  prismaClient: PrismaClient;
  logger?: ProjectionBootstrapLogger;
}): SlotStaleDetectorHandle {
  const detector = new SlotStaleDetector({
    prismaClient: options.prismaClient,
    logger: options.logger
  });
  const intervalMs = Number.parseInt(process.env.CCB_SLOT_STALE_DETECT_INTERVAL_MS ?? "300000", 10);
  const timer = setInterval(() => {
    detector.runOnce().catch((error) => {
      options.logger?.error?.(
        { event: "slot-stale-detector.failed", err: error },
        "slot stale detector failed"
      );
    });
  }, Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 300000);
  timer.unref?.();
  return {
    stop: async () => {
      clearInterval(timer);
    }
  };
}

function startSlotQueueDrainLoop(options: {
  prismaClient: PrismaClient;
  logger?: ProjectionBootstrapLogger;
}): SlotQueueDrainHandle {
  const router = new JobSlotRouter({
    prismaClient: options.prismaClient
  });
  const intervalMs = Number.parseInt(process.env.CCB_SLOT_QUEUE_DRAIN_INTERVAL_MS ?? "500", 10);
  const delay = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 500;
  const runOnce = async () => {
    const projectIds = await findProjectIdsWithUnassignedQueue(options.prismaClient);
    for (const projectId of projectIds) {
      const result = await router.tick(projectId);
      if (result.submitted > 0 || result.failed > 0) {
        options.logger?.info?.(
          {
            event: "slot-queue-drain.tick.processed",
            projectId,
            result
          },
          "slot queue drain processed queued requests"
        );
      }
    }
  };
  const timer = setInterval(() => {
    runOnce().catch((error) => {
      options.logger?.error?.(
        { event: "slot-queue-drain.tick.failed", err: error },
        "slot queue drain failed"
      );
    });
  }, delay);
  timer.unref?.();
  void runOnce().catch((error) => {
    options.logger?.error?.(
      { event: "slot-queue-drain.initial.failed", err: error },
      "initial slot queue drain failed"
    );
  });
  return {
    stop: async () => {
      clearInterval(timer);
    }
  };
}

async function findProjectIdsWithUnassignedQueue(client: PrismaClient): Promise<string[]> {
  const rows = await client.anchorDispatchQueue.findMany({
    where: {
      status: "pending",
      anchorId: "slot-unassigned",
      projectId: {
        not: null
      }
    },
    select: {
      projectId: true
    },
    orderBy: {
      queuedAt: "asc"
    },
    take: 100
  });
  const projectIds = new Set<string>();
  for (const row of rows) {
    if (row.projectId) {
      projectIds.add(row.projectId);
    }
  }
  return [...projectIds];
}

async function stopProjectionServices(...handles: Array<{ stop: () => Promise<void> }>): Promise<void> {
  const results = await Promise.allSettled(handles.map((handle) => handle.stop()));
  const rejections = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  if (rejections.length === 1) {
    throw rejections[0].reason;
  }
  if (rejections.length > 1) {
    throw new AggregateError(
      rejections.map((result) => result.reason),
      "projection service shutdown failed"
    );
  }
}
