import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { PrismaClient } from "@prisma/client";

import { prisma } from "../../db/prisma.js";
import { CcbdLauncherService, type CcbdLaunchResult } from "../anchor-lifecycle/ccbd-launcher.service.js";
import {
  computeSlotTipsProjection,
  defaultSlotTipsPeriodicSyncService
} from "../slot-binding/slot-tips-projection.service.js";
import {
  ensureManagedCcbConfig,
  MANAGED_CCB_CONFIG_RELATIVE_PATH,
  renderManagedCcbConfig,
  type ManagedCcbConfigDrift
} from "./managed-config.service.js";

export type ProjectCcbdRuntimeStatus = "starting" | "ready" | "degraded" | "stopped";

export type ProjectCcbdRuntime = {
  projectId: string;
  projectRoot: string;
  socketPath: string;
  tmuxSocketPath: string;
  topologySignature: string;
  status: ProjectCcbdRuntimeStatus;
};

export type ProjectCcbdConfigStatus = {
  path: string;
  exists: boolean;
  coreSignature: string;
  drift: ManagedCcbConfigDrift | null;
};

export type ProjectCcbdStatus = {
  projectId: string;
  projectRoot: string;
  socketPath: string;
  tmuxSocketPath: string;
  startupBlocked: boolean;
  config: ProjectCcbdConfigStatus;
};

export type ProjectCcbdStartupRecoverySummary = {
  total: number;
  started: number;
  blocked: number;
  failed: number;
};

type ProjectCcbdLogger = {
  info?: (payload: unknown, message?: string) => void;
  warn?: (payload: unknown, message?: string) => void;
  error?: (payload: unknown, message?: string) => void;
};

type ProjectRecord = {
  id: string;
  localPath: string;
};

type EvaluatedConfig = {
  status: ProjectCcbdStatus;
  existingConfigText: string | null;
};

export type SlotTipsPeriodicSyncLifecycle = {
  start(projectId: string, options?: { client?: PrismaClient; logger?: ProjectCcbdLogger }): void;
  stop(projectId: string): void;
  dispose(): void;
};

export class ProjectCcbdConfigDriftError extends Error {
  readonly status: ProjectCcbdStatus;

  constructor(status: ProjectCcbdStatus) {
    super("project ccbd startup blocked by managed ccb.config drift");
    this.name = "ProjectCcbdConfigDriftError";
    this.status = status;
  }
}

export class ProjectCcbdManager {
  constructor(
    private readonly client: PrismaClient = prisma,
    private readonly launcher = new CcbdLauncherService(),
    private readonly slotTipsPeriodicSync: SlotTipsPeriodicSyncLifecycle = defaultSlotTipsPeriodicSyncService
  ) {}

  async ensureStarted(projectId: string): Promise<ProjectCcbdRuntime> {
    const project = await this.client.project.findUniqueOrThrow({
      where: { id: projectId },
      select: { id: true, localPath: true }
    });
    const evaluated = await this.evaluateConfig(project);
    if (evaluated.status.startupBlocked) {
      throw new ProjectCcbdConfigDriftError(evaluated.status);
    }

    const sidebarViewTips = await computeSlotTipsProjection(this.client, project.id);
    const config = await ensureManagedCcbConfig({
      projectId: project.id,
      projectRoot: project.localPath,
      existingConfigText: evaluated.existingConfigText,
      sidebarViewTips
    });
    const launch = await this.launcher.start(project.localPath);
    this.slotTipsPeriodicSync.start(project.id, { client: this.client });
    return toRuntime(project.id, project.localPath, config.coreSignature, launch);
  }

  async confirmRestore(projectId: string): Promise<{ runtime: ProjectCcbdRuntime; status: ProjectCcbdStatus }> {
    const project = await this.client.project.findUniqueOrThrow({
      where: { id: projectId },
      select: { id: true, localPath: true }
    });
    const evaluated = await this.evaluateConfig(project);
    const sidebarViewTips = await computeSlotTipsProjection(this.client, project.id);
    const config = await ensureManagedCcbConfig({
      projectId: project.id,
      projectRoot: project.localPath,
      existingConfigText: evaluated.existingConfigText,
      sidebarViewTips
    });
    const launch = await this.launcher.start(project.localPath);
    this.slotTipsPeriodicSync.start(project.id, { client: this.client });
    const runtime = toRuntime(project.id, project.localPath, config.coreSignature, launch);
    const status = await this.getStatus(project.id);
    return { runtime, status };
  }

  async stop(projectId: string): Promise<void> {
    const project = await this.client.project.findUnique({
      where: { id: projectId },
      select: { localPath: true }
    });
    try {
      if (project) {
        await this.launcher.kill(project.localPath);
      }
    } finally {
      this.slotTipsPeriodicSync.stop(projectId);
    }
  }

  dispose(): void {
    this.slotTipsPeriodicSync.dispose();
  }

  async recoverOnStartup(projectId: string): Promise<ProjectCcbdRuntime> {
    return await this.ensureStarted(projectId);
  }

  async getStatus(projectId: string): Promise<ProjectCcbdStatus> {
    const project = await this.client.project.findUniqueOrThrow({
      where: { id: projectId },
      select: { id: true, localPath: true }
    });
    return (await this.evaluateConfig(project)).status;
  }

  async resolveSocket(projectId: string): Promise<string | null> {
    const project = await this.client.project.findUnique({
      where: { id: projectId },
      select: { localPath: true }
    });
    return project ? join(project.localPath, ".ccb", "ccbd", "ccbd.sock") : null;
  }

  private async evaluateConfig(project: ProjectRecord): Promise<EvaluatedConfig> {
    const configPath = join(project.localPath, MANAGED_CCB_CONFIG_RELATIVE_PATH);
    const existingConfigText = await readFile(configPath, "utf8").catch(() => null);
    const renderResult = renderManagedCcbConfig({
      projectId: project.id,
      projectRoot: project.localPath,
      existingConfigText
    });
    const status: ProjectCcbdStatus = {
      projectId: project.id,
      projectRoot: project.localPath,
      socketPath: join(project.localPath, ".ccb", "ccbd", "ccbd.sock"),
      tmuxSocketPath: join(project.localPath, ".ccb", "ccbd", "tmux.sock"),
      startupBlocked: renderResult.drift?.requiresUserConfirmation === true,
      config: {
        path: configPath,
        exists: existingConfigText !== null,
        coreSignature: renderResult.coreSignature,
        drift: renderResult.drift
      }
    };
    return {
      status,
      existingConfigText
    };
  }
}

export async function recoverProjectCcbdsOnStartup(options: {
  prismaClient?: PrismaClient;
  manager?: Pick<ProjectCcbdManager, "recoverOnStartup">;
  logger?: ProjectCcbdLogger;
} = {}): Promise<ProjectCcbdStartupRecoverySummary> {
  const client = options.prismaClient ?? prisma;
  const manager = options.manager ?? new ProjectCcbdManager(client);
  const projects = await client.project.findMany({
    select: { id: true }
  });
  const summary: ProjectCcbdStartupRecoverySummary = {
    total: projects.length,
    started: 0,
    blocked: 0,
    failed: 0
  };

  for (const project of projects) {
    try {
      await manager.recoverOnStartup(project.id);
      summary.started++;
    } catch (error) {
      if (error instanceof ProjectCcbdConfigDriftError) {
        summary.blocked++;
        options.logger?.warn?.(
          {
            event: "project-ccbd.startup.blocked",
            projectId: project.id,
            drift: error.status.config.drift
          },
          "project ccbd startup blocked by managed config drift"
        );
        continue;
      }
      summary.failed++;
      options.logger?.error?.(
        {
          event: "project-ccbd.startup.failed",
          projectId: project.id,
          err: error
        },
        "project ccbd startup failed; server will continue"
      );
    }
  }

  options.logger?.info?.(
    {
      event: "project-ccbd.startup.recovered",
      summary
    },
    "project ccbd startup recovery completed"
  );
  return summary;
}

function toRuntime(
  projectId: string,
  projectRoot: string,
  topologySignature: string,
  launch: CcbdLaunchResult
): ProjectCcbdRuntime {
  return {
    projectId,
    projectRoot,
    socketPath: launch.socketPath,
    tmuxSocketPath: join(projectRoot, ".ccb", "ccbd", "tmux.sock"),
    topologySignature,
    status: "ready"
  };
}
