import { execFile as execFileCallback } from "node:child_process";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

import type { PrismaClient } from "@prisma/client";

import { prisma } from "../../db/prisma.js";
import type { CcbdClientServiceLike, CcbdProjectView } from "../ccbd-client/ccbd-client.types.js";
import { CcbdClientService } from "../ccbd-client/ccbd-client.service.js";
import type { SlotId } from "./slot-binding.service.js";

export const SLOT_CONTEXT_RESET_COMMAND = "/new";
const execFile = promisify(execFileCallback);

export type SlotContextResetTrigger = "bind" | "release";

export type SlotContextResetInput = {
  projectId: string;
  slotId: SlotId;
  requirementId?: string | null;
  trigger: SlotContextResetTrigger;
  command?: string;
};

export type SlotContextResetAgentResult = {
  agent: string;
  status: "sent" | "skipped" | "failed";
  paneId?: string | null;
  reason?: string;
};

export type SlotContextResetResult = {
  projectId: string;
  slotId: SlotId;
  trigger: SlotContextResetTrigger;
  command: string;
  agentNames: string[];
  results: SlotContextResetAgentResult[];
  sent: number;
  skipped: number;
  failed: number;
  status: "ok" | "partial" | "skipped" | "failed";
};

export type SlotContextResetter = {
  resetSlotContext(input: SlotContextResetInput): Promise<SlotContextResetResult>;
};

type TmuxCommandRunner = (socketPath: string, args: string[]) => Promise<void>;
type SlotContextResetClient = Pick<CcbdClientServiceLike, "projectView">;

export interface SlotContextResetStore {
  findProjectLocalPath(projectId: string): Promise<string | null>;
}

export type SlotContextResetClientFactory = (projectRoot: string) => SlotContextResetClient;

export type SlotContextResetServiceOptions = {
  store?: SlotContextResetStore;
  clientFactory?: SlotContextResetClientFactory;
  runTmux?: TmuxCommandRunner;
};

export class PrismaSlotContextResetStore implements SlotContextResetStore {
  constructor(private readonly client: PrismaClient = prisma) {}

  async findProjectLocalPath(projectId: string): Promise<string | null> {
    const project = await this.client.project.findUnique({
      where: { id: projectId },
      select: { localPath: true }
    });
    return project?.localPath ?? null;
  }
}

export class SlotContextResetService implements SlotContextResetter {
  private readonly store: SlotContextResetStore;
  private readonly clientFactory: SlotContextResetClientFactory;
  private readonly runTmuxRunner?: TmuxCommandRunner;

  constructor(options: SlotContextResetServiceOptions = {}) {
    this.store = options.store ?? new PrismaSlotContextResetStore();
    this.clientFactory = options.clientFactory ?? ((projectRoot) => new CcbdClientService({ projectRoot }));
    this.runTmuxRunner = options.runTmux;
  }

  async resetSlotContext(input: SlotContextResetInput): Promise<SlotContextResetResult> {
    const command = input.command ?? SLOT_CONTEXT_RESET_COMMAND;
    let localPath: string | null;
    try {
      localPath = normalizeString(await this.store.findProjectLocalPath(input.projectId));
    } catch (error) {
      return buildResult(input, command, [], [
        {
          agent: "*",
          status: "failed",
          reason: `project_local_path_lookup_failed: ${errorMessage(error)}`
        }
      ]);
    }
    if (!localPath) {
      return buildResult(input, command, [], [
        {
          agent: "*",
          status: "failed",
          reason: "project_local_path_missing"
        }
      ]);
    }

    const client = this.clientFactory(localPath);
    let view: CcbdProjectView;
    try {
      view = await client.projectView();
    } catch (error) {
      return buildResult(input, command, [], [
        {
          agent: "*",
          status: "failed",
          reason: `project_view_failed: ${errorMessage(error)}`
        }
      ]);
    }
    const viewProjectRoot = normalizeString(view.project?.root);
    if (!viewProjectRoot || !(await sameCanonicalPath(viewProjectRoot, localPath))) {
      return buildResult(input, command, [], [
        {
          agent: "*",
          status: "failed",
          reason: "project_root_mismatch"
        }
      ]);
    }

    const window = (view.windows ?? []).find((candidate) => candidate.name === input.slotId);
    const agentNames = uniqueStrings(window?.agents ?? []);
    if (agentNames.length === 0) {
      return buildResult(input, command, [], [
        {
          agent: "*",
          status: "skipped",
          reason: "slot_window_agents_missing"
        }
      ]);
    }

    const socketPath = normalizeString(view.namespace?.socket_path);
    if (!socketPath) {
      return buildResult(
        input,
        command,
        agentNames,
        agentNames.map((agent) => ({
          agent,
          status: "failed",
          reason: "tmux_socket_missing"
        }))
      );
    }

    const agentsByName = new Map((view.agents ?? []).map((agent) => [agent.name, agent]));
    const results: SlotContextResetAgentResult[] = [];
    for (const agentName of agentNames) {
      const paneId = normalizePaneId(agentsByName.get(agentName)?.pane_id);
      if (!paneId) {
        results.push({
          agent: agentName,
          status: "skipped",
          reason: "pane_missing"
        });
        continue;
      }
      try {
        await this.sendSlashCommand(socketPath, paneId, command);
        results.push({
          agent: agentName,
          status: "sent",
          paneId
        });
      } catch (error) {
        results.push({
          agent: agentName,
          status: "failed",
          paneId,
          reason: errorMessage(error)
        });
      }
    }

    return buildResult(input, command, agentNames, results);
  }

  private async sendSlashCommand(socketPath: string, paneId: string, command: string): Promise<void> {
    await this.runTmux(socketPath, ["send-keys", "-t", paneId, "-X", "cancel"]).catch(() => undefined);
    await this.runTmux(socketPath, ["send-keys", "-t", paneId, "C-u"]);
    await this.runTmux(socketPath, ["send-keys", "-t", paneId, "-l", command]);
    await this.runTmux(socketPath, ["send-keys", "-t", paneId, "Enter"]);
  }

  private async runTmux(socketPath: string, args: string[]): Promise<void> {
    const runner = this.runTmuxRunner ?? defaultTmuxRunner;
    await runner(socketPath, args);
  }
}

let defaultResetter: SlotContextResetter | null = null;

export function createDefaultSlotContextResetter(): SlotContextResetter {
  defaultResetter ??= new SlotContextResetService();
  return defaultResetter;
}

export function summarizeSlotContextResetResult(result: SlotContextResetResult): Record<string, unknown> {
  return {
    projectId: result.projectId,
    slotId: result.slotId,
    trigger: result.trigger,
    command: result.command,
    status: result.status,
    sent: result.sent,
    skipped: result.skipped,
    failed: result.failed,
    results: result.results
  };
}

function buildResult(
  input: SlotContextResetInput,
  command: string,
  agentNames: string[],
  results: SlotContextResetAgentResult[]
): SlotContextResetResult {
  const sent = results.filter((result) => result.status === "sent").length;
  const skipped = results.filter((result) => result.status === "skipped").length;
  const failed = results.filter((result) => result.status === "failed").length;
  return {
    projectId: input.projectId,
    slotId: input.slotId,
    trigger: input.trigger,
    command,
    agentNames,
    results,
    sent,
    skipped,
    failed,
    status: resolveStatus({ sent, skipped, failed, total: results.length })
  };
}

function resolveStatus(input: { sent: number; skipped: number; failed: number; total: number }): SlotContextResetResult["status"] {
  if (input.failed > 0 && input.sent === 0) return "failed";
  if (input.sent > 0 && (input.failed > 0 || input.skipped > 0)) return "partial";
  if (input.sent > 0 && input.sent === input.total) return "ok";
  return "skipped";
}

async function defaultTmuxRunner(socketPath: string, args: string[]): Promise<void> {
  await execFile("tmux", ["-S", socketPath, ...args], {
    timeout: 2000,
    maxBuffer: 16 * 1024
  });
}

function uniqueStrings(values: string[]): string[] {
  const result: string[] = [];
  for (const value of values) {
    const normalized = normalizeString(value);
    if (normalized && !result.includes(normalized)) {
      result.push(normalized);
    }
  }
  return result;
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizePaneId(value: unknown): string | null {
  const text = normalizeString(value);
  return text.startsWith("%") ? text : null;
}

async function sameCanonicalPath(left: string, right: string): Promise<boolean> {
  return (await canonicalPath(left)) === (await canonicalPath(right));
}

async function canonicalPath(value: string): Promise<string> {
  const absolute = resolve(value);
  let canonical = absolute;
  try {
    canonical = await realpath(absolute);
  } catch {
    canonical = absolute;
  }
  return stripTrailingSlash(canonical.replace(/\\/g, "/"));
}

function stripTrailingSlash(value: string): string {
  const stripped = value.replace(/\/+$/, "");
  return stripped || "/";
}

function errorMessage(error: unknown): string {
  if (error && typeof error === "object") {
    const maybeError = error as { message?: unknown; stderr?: unknown };
    const stderr = typeof maybeError.stderr === "string" ? maybeError.stderr.trim() : "";
    if (stderr) return stderr.slice(0, 200);
    const message = typeof maybeError.message === "string" ? maybeError.message.trim() : "";
    if (message) return message.slice(0, 200);
  }
  return String(error).slice(0, 200);
}
