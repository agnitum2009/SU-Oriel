import { createHash } from "node:crypto";

import type { PrismaClient } from "@prisma/client";

import { prisma } from "../../db/prisma.js";
import { AttentionInboxService, type AttentionInboxServiceLike } from "../attention-inbox/attention-inbox.service.js";
import { ensureManagedCcbConfig, projectSlotTopology } from "../project-ccbd/managed-config.service.js";

const ACTIVE_TIP_STATES = ["bound", "busy", "unhealthy", "recovering"] as const;
export const DEFAULT_SLOT_TIPS_SYNC_INTERVAL_MS = 30_000;
export const SLOT_TIP_TITLE_MAX_CHARS = 24;

type SlotTipsConfigWriter = typeof ensureManagedCcbConfig;

type SlotTipsLogger = {
  warn?: (input: Record<string, unknown>, message: string) => void;
};

type SlotTipsProjectionOptions = {
  attentionService?: Pick<AttentionInboxServiceLike, "computeAttention">;
};

type SlotTipsSyncOptions = {
  client?: PrismaClient;
  logger?: SlotTipsLogger;
  attentionService?: Pick<AttentionInboxServiceLike, "computeAttention">;
  writeManagedConfig?: SlotTipsConfigWriter;
};

type SlotTipsPeriodicSyncOptions = SlotTipsSyncOptions & {
  intervalMs?: number;
  syncSlotTipsFn?: typeof syncSlotTips;
};

export type SlotTipsSyncResult = {
  projectId: string;
  projectRoot: string | null;
  tips: string[];
  status: "ok" | "skipped" | "failed";
  reason?: string;
};

const projectLocks = new Map<string, Promise<void>>();
const lastWrittenTipHashes = new Map<string, string>();
type SlotTipsTimer = ReturnType<typeof setInterval>;

export class SlotTipsPeriodicSyncService {
  private readonly timers = new Map<string, SlotTipsTimer>();

  constructor(private readonly options: SlotTipsPeriodicSyncOptions = {}) {}

  start(projectId: string, options: SlotTipsSyncOptions = {}): void {
    if (this.timers.has(projectId)) {
      return;
    }

    const timer = setInterval(() => this.tick(projectId, options), this.options.intervalMs ?? DEFAULT_SLOT_TIPS_SYNC_INTERVAL_MS);
    timer.unref?.();
    this.timers.set(projectId, timer);
  }

  stop(projectId: string): void {
    const timer = this.timers.get(projectId);
    if (!timer) {
      return;
    }
    clearInterval(timer);
    this.timers.delete(projectId);
  }

  dispose(): void {
    for (const projectId of this.timers.keys()) {
      this.stop(projectId);
    }
  }

  private async tick(projectId: string, options: SlotTipsSyncOptions): Promise<void> {
    const run = this.options.syncSlotTipsFn ?? syncSlotTips;
    try {
      await run(projectId, {
        client: options.client ?? this.options.client,
        logger: options.logger ?? this.options.logger,
        attentionService: options.attentionService ?? this.options.attentionService,
        writeManagedConfig: options.writeManagedConfig ?? this.options.writeManagedConfig
      });
    } catch (error) {
      (options.logger ?? this.options.logger)?.warn?.(
        {
          event: "slot_tips.periodic_sync.failed",
          projectId,
          err: error
        },
        "periodic slot tips sync failed; continuing"
      );
    }
  }
}

export const defaultSlotTipsPeriodicSyncService = new SlotTipsPeriodicSyncService();

export async function computeSlotTipsProjection(
  client: PrismaClient,
  projectId: string,
  options: SlotTipsProjectionOptions = {}
): Promise<string[]> {
  const [rows, attention] = await Promise.all([
    client.slotBinding.findMany({
      where: {
        projectId,
        requirementId: {
          not: null
        },
        state: {
          in: [...ACTIVE_TIP_STATES]
        }
      },
      include: {
        requirement: {
          select: {
            title: true
          }
        }
      }
    }),
    (options.attentionService ?? new AttentionInboxService(client)).computeAttention(projectId)
  ]);

  const attentionRequirementIds = new Set(
    attention.items
      .filter((item) => item.severity === "attention" && item.requirementId)
      .map((item) => item.requirementId as string)
  );

  return rows
    .filter((row) => row.requirement)
    .sort((left, right) => slotOrder(left.slotId) - slotOrder(right.slotId))
    .map((row) => {
      const title = truncateTipTitle(row.requirement?.title ?? "");
      const hasAttention = row.requirementId ? attentionRequirementIds.has(row.requirementId) : false;
      return hasAttention ? `${row.slotId}: ⚠️待你决策 ${title}` : `${row.slotId}: ${title}`;
    });
}

export async function syncSlotTips(
  projectId: string,
  options: SlotTipsSyncOptions = {}
): Promise<SlotTipsSyncResult> {
  const client = options.client ?? prisma;
  const writeManagedConfig = options.writeManagedConfig ?? ensureManagedCcbConfig;
  return await withProjectLock(projectId, async () => {
    try {
      const project = await client.project.findUnique({
        where: { id: projectId },
        select: { localPath: true, slotCount: true, slotAgentOverridesJson: true }
      });
      if (!project) {
        return {
          projectId,
          projectRoot: null,
          tips: [],
          status: "skipped",
          reason: "project_missing"
        };
      }

      const tips = await computeSlotTipsProjection(client, projectId, { attentionService: options.attentionService });
      const hashKey = `${projectId}:${project.localPath}`;
      const nextHash = hashTips(tips);
      if (lastWrittenTipHashes.get(hashKey) === nextHash) {
        return {
          projectId,
          projectRoot: project.localPath,
          tips,
          status: "skipped",
          reason: "content_unchanged"
        };
      }

      await writeManagedConfig({
        projectId,
        projectRoot: project.localPath,
        topology: projectSlotTopology(project.slotCount),
        slotAgentOverridesJson: project.slotAgentOverridesJson,
        sidebarViewTips: tips
      });
      lastWrittenTipHashes.set(hashKey, nextHash);
      return {
        projectId,
        projectRoot: project.localPath,
        tips,
        status: "ok"
      };
    } catch (error) {
      options.logger?.warn?.(
        {
          event: "slot_tips.sync.failed",
          projectId,
          err: error
        },
        "slot tips sync failed; continuing main slot flow"
      );
      return {
        projectId,
        projectRoot: null,
        tips: [],
        status: "failed",
        reason: errorMessage(error)
      };
    }
  });
}

function truncateTipTitle(title: string): string {
  const text = title.trim();
  const chars = [...text];
  if (chars.length <= SLOT_TIP_TITLE_MAX_CHARS) {
    return text;
  }
  return `${chars.slice(0, SLOT_TIP_TITLE_MAX_CHARS - 3).join("")}...`;
}

function hashTips(tips: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify(tips), "utf8").digest("hex");
}

function slotOrder(slotId: string): number {
  const match = slotId.match(/^slot-(\d+)$/);
  return match?.[1] ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

async function withProjectLock<T>(projectId: string, work: () => Promise<T>): Promise<T> {
  const previous = projectLocks.get(projectId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const next = previous.catch(() => undefined).then(() => current);
  projectLocks.set(projectId, next);

  await previous.catch(() => undefined);
  try {
    return await work();
  } finally {
    release();
    if (projectLocks.get(projectId) === next) {
      projectLocks.delete(projectId);
    }
  }
}

function errorMessage(error: unknown): string {
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
    return error.message.slice(0, 200);
  }
  return String(error).slice(0, 200);
}
