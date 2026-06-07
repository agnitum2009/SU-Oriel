import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import type { PrismaClient } from "@prisma/client";

import { prisma } from "../../db/prisma.js";
import { CcbdClientService } from "../ccbd-client/ccbd-client.service.js";
import type { CcbdProjectView } from "../ccbd-client/ccbd-client.types.js";
import {
  collectSlotAgentOverridesJson,
  MANAGED_CCB_CONFIG_RELATIVE_PATH,
  parseSlotAgentOverridesJson,
  projectSlotTopology,
  renderManagedCcbConfig
} from "../project-ccbd/managed-config.service.js";
import {
  defaultManagedConfigMutationLock,
  type ManagedConfigMutationLock
} from "../project-ccbd/managed-config-mutation-lock.js";
import {
  MAX_PROJECT_SLOT_COUNT,
  MIN_PROJECT_SLOT_COUNT,
  agentNamesForSlot,
  type SlotId
} from "../slot-topology/slot-topology.service.js";
import type { SlotContextResetResult, SlotContextResetter } from "../slot-binding/slot-context-reset.service.js";
import { SlotContextResetService } from "../slot-binding/slot-context-reset.service.js";
import type { CcbReloadResult } from "./reload-cli.js";
import { runCcbReload } from "./reload-cli.js";

export type SlotResizeMode = "reloaded" | "offline_desired";
export type SlotResizeDirection = "grow" | "shrink";

export type SlotResizeSuccess = {
  ok: true;
  direction: SlotResizeDirection;
  mode: SlotResizeMode;
  projectId: string;
  previousSlotCount: number;
  nextSlotCount: number;
  reload: CcbReloadResult | null;
  reset: SlotContextResetResult | null;
};

export type SlotResizeFailure = {
  ok: false;
  direction: SlotResizeDirection;
  projectId: string;
  previousSlotCount: number | null;
  reason: string;
  details?: Record<string, unknown>;
  reload?: CcbReloadResult | null;
};

export type SlotResizeResult = SlotResizeSuccess | SlotResizeFailure;

export type SlotShrinkEligibilitySummary = {
  projectId: string;
  slotCount: number;
  tailSlotId: SlotId | null;
  canShrink: boolean;
  eligible: boolean;
  checks: {
    slotBindingIdle: boolean;
    queueClear: boolean;
    runtimeIdle: boolean;
  };
  reasons: string[];
  details: Record<string, unknown>;
};

type ResizeProject = {
  id: string;
  localPath: string;
  slotCount: number;
  slotAgentOverridesJson: string | null;
};

export type SlotResizeReloadRunner = (input: { projectRoot: string }) => Promise<CcbReloadResult>;

export type SlotResizeRuntime = {
  isOnline(projectRoot: string): Promise<boolean>;
  waitForSlotActive(input: { projectRoot: string; slotId: SlotId; timeoutMs?: number }): Promise<boolean>;
  hasActiveSlotJob(input: { projectRoot: string; slotId: SlotId }): Promise<boolean>;
};

export type SlotResizeServiceOptions = {
  client?: PrismaClient;
  lock?: ManagedConfigMutationLock;
  reload?: SlotResizeReloadRunner;
  runtime?: SlotResizeRuntime;
  contextResetterFactory?: (projectRoot: string) => SlotContextResetter;
  activeWaitTimeoutMs?: number;
};

type BlockingQueueRow = {
  jobId: string;
  status: string;
  command: string;
};

export class SlotResizeService {
  private readonly client: PrismaClient;
  private readonly lock: ManagedConfigMutationLock;
  private readonly reload: SlotResizeReloadRunner;
  private readonly runtime: SlotResizeRuntime;
  private readonly contextResetterFactory: (projectRoot: string) => SlotContextResetter;

  constructor(private readonly options: SlotResizeServiceOptions = {}) {
    this.client = options.client ?? prisma;
    this.lock = options.lock ?? defaultManagedConfigMutationLock;
    this.reload = options.reload ?? (async ({ projectRoot }) => await runCcbReload({ projectRoot }));
    this.runtime = options.runtime ?? defaultSlotResizeRuntime();
    this.contextResetterFactory =
      options.contextResetterFactory ??
      ((projectRoot) => new SlotContextResetService(new CcbdClientService({ projectRoot })));
  }

  async grow(projectId: string): Promise<SlotResizeResult> {
    return await this.lock.runExclusive(projectId, async () => {
      const project = await this.findProject(projectId);
      if (!project) {
        return failure("grow", projectId, null, "project_missing");
      }
      if (project.slotCount >= MAX_PROJECT_SLOT_COUNT) {
        return failure("grow", projectId, project.slotCount, "slot_count_max", { max: MAX_PROJECT_SLOT_COUNT });
      }

      const previousSlotCount = project.slotCount;
      const nextSlotCount = previousSlotCount + 1;
      const nextSlotId = `slot-${nextSlotCount}` as SlotId;
      const oldConfigText = await readManagedConfig(project.localPath);
      const nextConfigText = renderProjectConfig(project, nextSlotCount, oldConfigText, project.slotAgentOverridesJson);

      try {
        await writeManagedConfig(project.localPath, nextConfigText);
      } catch (error) {
        await restoreManagedConfig(project.localPath, oldConfigText);
        return failure("grow", projectId, previousSlotCount, "config_write_failed", { error: errorMessage(error) });
      }

      const online = await this.runtime.isOnline(project.localPath);
      if (!online) {
        try {
          await this.client.project.update({
            where: { id: project.id },
            data: { slotCount: nextSlotCount }
          });
          return success("grow", "offline_desired", project, nextSlotCount, null, null);
        } catch (error) {
          await restoreManagedConfig(project.localPath, oldConfigText);
          return failure("grow", projectId, previousSlotCount, "db_update_failed", { error: errorMessage(error) });
        }
      }

      let reloadResult: CcbReloadResult;
      try {
        reloadResult = await this.reload({ projectRoot: project.localPath });
      } catch (error) {
        await restoreManagedConfig(project.localPath, oldConfigText);
        return failure("grow", projectId, previousSlotCount, "reload_failed", { error: errorMessage(error) });
      }
      if (!isPublishedReload(reloadResult)) {
        await restoreManagedConfig(project.localPath, oldConfigText);
        return failure("grow", projectId, previousSlotCount, "reload_rejected", undefined, reloadResult);
      }

      await this.client.project.update({
        where: { id: project.id },
        data: { slotCount: nextSlotCount }
      });

      const active = await this.runtime.waitForSlotActive({
        projectRoot: project.localPath,
        slotId: nextSlotId,
        timeoutMs: this.options.activeWaitTimeoutMs
      });
      if (!active) {
        return failure("grow", projectId, previousSlotCount, "slot_activation_timeout", { slotId: nextSlotId }, reloadResult);
      }
      const reset = await this.contextResetterFactory(project.localPath).resetSlotContext({
        projectId: project.id,
        slotId: nextSlotId,
        trigger: "bind"
      });
      return success("grow", "reloaded", project, nextSlotCount, reloadResult, reset);
    });
  }

  async shrink(projectId: string): Promise<SlotResizeResult> {
    return await this.lock.runExclusive(projectId, async () => {
      const project = await this.findProject(projectId);
      if (!project) {
        return failure("shrink", projectId, null, "project_missing");
      }
      if (project.slotCount <= MIN_PROJECT_SLOT_COUNT) {
        return failure("shrink", projectId, project.slotCount, "slot_count_min", { min: MIN_PROJECT_SLOT_COUNT });
      }

      const previousSlotCount = project.slotCount;
      const nextSlotCount = previousSlotCount - 1;
      const tailSlotId = `slot-${previousSlotCount}` as SlotId;
      const eligibility = await this.inspectShrinkEligibility(project, tailSlotId);
      if (!eligibility.eligible) {
        return failure(
          "shrink",
          projectId,
          previousSlotCount,
          eligibility.reasons[0] ?? "slot_not_shrinkable",
          eligibility.details
        );
      }

      const oldConfigText = await readManagedConfig(project.localPath);
      const nextOverridesJson = mergeSlotAgentOverrides(
        project.slotAgentOverridesJson,
        oldConfigText,
        previousSlotCount,
        tailSlotId
      );
      const nextConfigText = renderProjectConfig(project, nextSlotCount, oldConfigText, nextOverridesJson);
      const online = await this.runtime.isOnline(project.localPath);

      try {
        await this.client.project.update({
          where: { id: project.id },
          data: {
            slotCount: nextSlotCount,
            slotAgentOverridesJson: nextOverridesJson
          }
        });
      } catch (error) {
        return failure("shrink", projectId, previousSlotCount, "db_update_failed", { error: errorMessage(error) });
      }

      try {
        await writeManagedConfig(project.localPath, nextConfigText);
      } catch (error) {
        await this.restoreProject(project, oldConfigText);
        return failure("shrink", projectId, previousSlotCount, "config_write_failed", { error: errorMessage(error) });
      }

      if (!online) {
        return success("shrink", "offline_desired", project, nextSlotCount, null, null);
      }

      const stillActive = await this.runtime.hasActiveSlotJob({ projectRoot: project.localPath, slotId: tailSlotId });
      if (stillActive) {
        await this.restoreProject(project, oldConfigText);
        return failure("shrink", projectId, previousSlotCount, "runtime_job_active", { slotId: tailSlotId });
      }

      let reloadResult: CcbReloadResult;
      try {
        reloadResult = await this.reload({ projectRoot: project.localPath });
      } catch (error) {
        await this.restoreProject(project, oldConfigText);
        return failure("shrink", projectId, previousSlotCount, "reload_failed", { error: errorMessage(error) });
      }
      if (!isPublishedReload(reloadResult)) {
        await this.restoreProject(project, oldConfigText);
        return failure("shrink", projectId, previousSlotCount, "reload_rejected", undefined, reloadResult);
      }
      return success("shrink", "reloaded", project, nextSlotCount, reloadResult, null);
    });
  }

  private async findProject(projectId: string): Promise<ResizeProject | null> {
    return await this.client.project.findUnique({
      where: { id: projectId },
      select: {
        id: true,
        localPath: true,
        slotCount: true,
        slotAgentOverridesJson: true
      }
    });
  }

  async getShrinkEligibility(projectId: string): Promise<SlotShrinkEligibilitySummary | null> {
    const project = await this.findProject(projectId);
    if (!project) {
      return null;
    }
    if (project.slotCount <= MIN_PROJECT_SLOT_COUNT) {
      return {
        projectId,
        slotCount: project.slotCount,
        tailSlotId: null,
        canShrink: false,
        eligible: false,
        checks: {
          slotBindingIdle: true,
          queueClear: true,
          runtimeIdle: true
        },
        reasons: ["slot_count_min"],
        details: { min: MIN_PROJECT_SLOT_COUNT }
      };
    }
    return await this.inspectShrinkEligibility(project, `slot-${project.slotCount}` as SlotId);
  }

  private async inspectShrinkEligibility(
    project: ResizeProject,
    slotId: SlotId
  ): Promise<SlotShrinkEligibilitySummary> {
    const binding = await this.client.slotBinding.findUnique({
      where: {
        projectId_slotId: {
          projectId: project.id,
          slotId
        }
      }
    });
    const queueRows = await findBlockingQueueRows(this.client, project.id, slotId);
    const online = await this.runtime.isOnline(project.localPath);
    const hasActiveRuntimeJob = online
      ? await this.runtime.hasActiveSlotJob({ projectRoot: project.localPath, slotId })
      : false;
    const slotBindingIdle = !binding || (binding.state === "idle" && binding.requirementId === null);
    const queueClear = queueRows.length === 0;
    const runtimeIdle = !hasActiveRuntimeJob;
    const reasons = [
      ...(!slotBindingIdle ? ["slot_not_idle"] : []),
      ...(!queueClear ? ["queue_not_empty"] : []),
      ...(!runtimeIdle ? ["runtime_job_active"] : [])
    ];
    const details: Record<string, unknown> = {
      slotId,
      runtimeOnline: online
    };
    if (binding) {
      details.binding = {
        state: binding.state,
        requirementId: binding.requirementId
      };
    }
    if (queueRows.length > 0) {
      details.queueRows = queueRows;
    }
    if (hasActiveRuntimeJob) {
      details.runtimeJobActive = true;
    }
    return {
      projectId: project.id,
      slotCount: project.slotCount,
      tailSlotId: slotId,
      canShrink: project.slotCount > MIN_PROJECT_SLOT_COUNT,
      eligible: slotBindingIdle && queueClear && runtimeIdle,
      checks: {
        slotBindingIdle,
        queueClear,
        runtimeIdle
      },
      reasons,
      details
    };
  }

  private async restoreProject(project: ResizeProject, oldConfigText: string | null): Promise<void> {
    await restoreManagedConfig(project.localPath, oldConfigText);
    await this.client.project.update({
      where: { id: project.id },
      data: {
        slotCount: project.slotCount,
        slotAgentOverridesJson: project.slotAgentOverridesJson
      }
    });
  }
}

function renderProjectConfig(
  project: ResizeProject,
  slotCount: number,
  existingConfigText: string | null,
  slotAgentOverridesJson: string | null
): string {
  const topology = projectSlotTopology(slotCount);
  return renderManagedCcbConfig({
    projectId: project.id,
    projectRoot: project.localPath,
    topology,
    existingConfigText,
    slotAgentOverridesJson
  }).configText;
}

function mergeSlotAgentOverrides(
  existingJson: string | null,
  configText: string | null,
  slotCount: number,
  tailSlotId: SlotId
): string | null {
  const topology = projectSlotTopology(slotCount);
  const existing = parseSlotAgentOverridesJson(existingJson, topology);
  const collectedJson = configText ? collectSlotAgentOverridesJson(configText, topology, [tailSlotId]) : null;
  const collected = parseSlotAgentOverridesJson(collectedJson, topology);
  const merged = { ...existing, ...collected };
  return Object.keys(merged).length > 0 ? JSON.stringify(merged) : null;
}

async function findBlockingQueueRows(
  client: PrismaClient,
  projectId: string,
  slotId: SlotId
): Promise<BlockingQueueRow[]> {
  const rows = await client.anchorDispatchQueue.findMany({
    where: {
      projectId,
      anchorId: slotId,
      status: { in: ["pending", "submitted"] }
    },
    select: {
      jobId: true,
      status: true,
      command: true
    }
  });
  return rows.map((row) => ({
    jobId: row.jobId,
    status: row.status,
    command: row.command
  }));
}

async function readManagedConfig(projectRoot: string): Promise<string | null> {
  return await readFile(join(projectRoot, MANAGED_CCB_CONFIG_RELATIVE_PATH), "utf8").catch(() => null);
}

async function writeManagedConfig(projectRoot: string, text: string): Promise<void> {
  const configPath = join(projectRoot, MANAGED_CCB_CONFIG_RELATIVE_PATH);
  const configDir = join(projectRoot, ".ccb");
  const tempPath = join(configDir, `.ccb.config.resize.${process.pid}.${randomUUID()}.tmp`);
  await mkdir(configDir, { recursive: true });
  try {
    await writeFile(tempPath, text, "utf8");
    await rename(tempPath, configPath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function restoreManagedConfig(projectRoot: string, oldConfigText: string | null): Promise<void> {
  if (oldConfigText === null) {
    await rm(join(projectRoot, MANAGED_CCB_CONFIG_RELATIVE_PATH), { force: true });
    return;
  }
  await writeManagedConfig(projectRoot, oldConfigText);
}

function isPublishedReload(result: CcbReloadResult): boolean {
  return result.ok && result.status === "published" && result.safeToApply !== false;
}

function success(
  direction: SlotResizeDirection,
  mode: SlotResizeMode,
  project: ResizeProject,
  nextSlotCount: number,
  reload: CcbReloadResult | null,
  reset: SlotContextResetResult | null
): SlotResizeSuccess {
  return {
    ok: true,
    direction,
    mode,
    projectId: project.id,
    previousSlotCount: project.slotCount,
    nextSlotCount,
    reload,
    reset
  };
}

function failure(
  direction: SlotResizeDirection,
  projectId: string,
  previousSlotCount: number | null,
  reason: string,
  details?: Record<string, unknown>,
  reload?: CcbReloadResult | null
): SlotResizeFailure {
  return {
    ok: false,
    direction,
    projectId,
    previousSlotCount,
    reason,
    ...(details ? { details } : {}),
    ...(reload !== undefined ? { reload } : {})
  };
}

function defaultSlotResizeRuntime(): SlotResizeRuntime {
  return {
    isOnline: async (projectRoot) => {
      try {
        await new CcbdClientService({ projectRoot }).ping("ccbd");
        return true;
      } catch {
        return false;
      }
    },
    waitForSlotActive: async ({ projectRoot, slotId, timeoutMs = 5000 }) => {
      const deadline = Date.now() + timeoutMs;
      const [claudeAgent, codexAgent] = agentNamesForSlot(slotId);
      while (Date.now() <= deadline) {
        try {
          const view = await new CcbdClientService({ projectRoot }).projectView();
          if (slotIsActive(view, slotId, [claudeAgent, codexAgent])) {
            return true;
          }
        } catch {
          // Retry until timeout.
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return false;
    },
    hasActiveSlotJob: async ({ projectRoot, slotId }) => {
      const [claudeAgent, codexAgent] = agentNamesForSlot(slotId);
      const client = new CcbdClientService({ projectRoot });
      for (const agentName of [claudeAgent, codexAgent]) {
        const queue = await client.queue(agentName);
        if (hasActiveQueueState(queue)) {
          return true;
        }
      }
      return false;
    }
  };
}

function slotIsActive(view: CcbdProjectView, slotId: SlotId, agentNames: readonly string[]): boolean {
  const window = view.windows?.find((candidate) => candidate.name === slotId);
  if (!window) return false;
  const agentsByName = new Map((view.agents ?? []).map((agent) => [agent.name, agent]));
  return agentNames.every((agentName) => {
    const agent = agentsByName.get(agentName);
    return window.agents?.includes(agentName) && Boolean(agent?.pane_id);
  });
}

function hasActiveQueueState(value: unknown): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some(hasActiveQueueState);
  }
  const record = value as Record<string, unknown>;
  const status = typeof record.status === "string" ? record.status.toLowerCase() : "";
  const state = typeof record.state === "string" ? record.state.toLowerCase() : "";
  if (["running", "submitted", "active", "processing", "in_progress"].includes(status || state)) {
    return true;
  }
  return Object.values(record).some(hasActiveQueueState);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
