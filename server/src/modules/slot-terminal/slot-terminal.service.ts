import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import type { PrismaClient, SlotBinding } from "@prisma/client";

import { prisma } from "../../db/prisma.js";
import { isSlotId, SlotBindingService } from "../slot-binding/slot-binding.service.js";
import { SlotTerminalNotFoundError, SlotTerminalTargetForbiddenError } from "./slot-terminal.errors.js";

const execFileAsync = promisify(execFile);
const TMUX_SOCKET_RELATIVE_PATH = join(".ccb", "ccbd", "tmux.sock");
const LIVE_BINDING_STATES = new Set(["bound", "busy", "unhealthy", "recovering"]);
const AGENT_GROUP_WINDOWS = ["main"] as const;

export const SLOT_TERMINAL_ROLES = ["claude", "codex"] as const;
export type SlotTerminalRole = (typeof SLOT_TERMINAL_ROLES)[number];
type AgentGroupWindow = (typeof AGENT_GROUP_WINDOWS)[number];

export type SlotTerminalPaneTarget = {
  role: SlotTerminalRole;
  target: string;
  paneIndex: number;
};

export type SlotTerminalPaneCandidate = SlotTerminalPaneTarget & {
  agentName: string;
};

export type SlotTerminalDescriptor = {
  slotId: string;
  sessionName: string;
  panes: SlotTerminalPaneTarget[];
};

export type SlotTerminalBinding = Pick<SlotBinding, "projectId" | "slotId" | "requirementId" | "state">;

export type SlotTerminalProject = {
  id: string;
  localPath: string;
  slotCount: number;
};

export interface SlotTerminalStore {
  findProject(projectId: string): Promise<SlotTerminalProject | null>;
  findProjectIdForRequirement(requirementId: string): Promise<string | null>;
  findBindingForRequirement(projectId: string, requirementId: string): Promise<SlotTerminalBinding | null>;
}

export interface SlotTerminalRuntimeResolver {
  resolveSlotPanes(input: { projectRoot: string; slotId: string }): Promise<{
    sessionName: string;
    panes: SlotTerminalPaneTarget[];
  }>;
  resolveSlotPaneCandidates(input: { projectRoot: string; slotId: string }): Promise<{
    sessionName: string;
    candidatesByRole: Map<SlotTerminalRole, SlotTerminalPaneCandidate[]>;
  }>;
}

export type SlotTerminalExecFileProcess = (
  command: string,
  args: string[]
) => Promise<{ stdout: string; stderr: string }>;

type RuntimeRecord = Record<string, unknown>;
type RuntimeRecordEntry = {
  agentName: string;
  record: RuntimeRecord;
};

type ListedPane = {
  sessionName: string;
  windowName: string;
  paneId: string;
  paneIndex: number;
};

export class PrismaSlotTerminalStore implements SlotTerminalStore {
  private readonly slotBinding: SlotBindingService;

  constructor(private readonly client: PrismaClient = prisma) {
    this.slotBinding = new SlotBindingService(client);
  }

  async findProject(projectId: string): Promise<SlotTerminalProject | null> {
    return await this.client.project.findUnique({
      where: { id: projectId },
      select: { id: true, localPath: true, slotCount: true }
    });
  }

  async findProjectIdForRequirement(requirementId: string): Promise<string | null> {
    const requirement = await this.client.requirement.findUnique({
      where: { id: requirementId },
      select: { projectId: true }
    });
    return requirement?.projectId ?? null;
  }

  async findBindingForRequirement(projectId: string, requirementId: string): Promise<SlotTerminalBinding | null> {
    return await this.slotBinding.findBindingForRequirement(projectId, requirementId);
  }
}

export class TmuxSlotTerminalRuntimeResolver implements SlotTerminalRuntimeResolver {
  private readonly tmuxCommand: string;
  private readonly execFileProcess: SlotTerminalExecFileProcess;

  constructor(options: { tmuxCommand?: string; execFileProcess?: SlotTerminalExecFileProcess } = {}) {
    this.tmuxCommand = options.tmuxCommand ?? "tmux";
    this.execFileProcess =
      options.execFileProcess ??
      (async (command, args) => {
        const result = await execFileAsync(command, args);
        return {
          stdout: String(result.stdout),
          stderr: String(result.stderr)
        };
      });
  }

  async resolveSlotPanes(input: { projectRoot: string; slotId: string }): Promise<{
    sessionName: string;
    panes: SlotTerminalPaneTarget[];
  }> {
    const { sessionName, candidatesByRole } = await this.resolveSlotPaneCandidates(input);
    const panes: SlotTerminalPaneTarget[] = [];

    for (const role of SLOT_TERMINAL_ROLES) {
      const candidate = candidatesByRole.get(role)?.[0];
      if (!candidate) {
        continue;
      }
      panes.push({
        role,
        target: candidate.target,
        paneIndex: candidate.paneIndex
      });
    }

    if (panes.length === 0) {
      throw new SlotTerminalNotFoundError("slot terminal panes not found");
    }

    return {
      sessionName,
      panes
    };
  }

  async resolveSlotPaneCandidates(input: { projectRoot: string; slotId: string }): Promise<{
    sessionName: string;
    candidatesByRole: Map<SlotTerminalRole, SlotTerminalPaneCandidate[]>;
  }> {
    const socketPath = buildSlotTerminalTmuxSocketPath(input.projectRoot);
    const [listedPanes, runtimeRecords] = await Promise.all([
      this.listAllPanes(socketPath),
      readRuntimeRecords(input.projectRoot)
    ]);
    const paneById = indexListedPanesById(listedPanes);
    const candidates = collectRuntimePaneCandidates(runtimeRecords, input.slotId, paneById);
    const sessionNames = new Set(candidates.map((candidate) => candidate.sessionName));

    if (sessionNames.size === 0) {
      throw new SlotTerminalNotFoundError("slot terminal panes not found");
    }
    if (sessionNames.size !== 1) {
      throw new SlotTerminalNotFoundError("slot terminal panes are not uniquely resolvable");
    }

    const sessionName = [...sessionNames][0] ?? "";
    const candidatesByRole = groupPaneCandidatesByRole(candidates);

    return {
      sessionName,
      candidatesByRole
    };
  }

  private async listAllPanes(socketPath: string): Promise<ListedPane[]> {
    let stdout = "";
    try {
      const result = await this.execFileProcess(this.tmuxCommand, [
        "-S",
        socketPath,
        "list-panes",
        "-a",
        "-F",
        "#{session_name}\t#{window_name}\t#{pane_id}\t#{pane_index}"
      ]);
      stdout = result.stdout;
    } catch {
      throw new SlotTerminalNotFoundError("slot terminal panes not found");
    }

    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map(parsePaneLine);
  }
}

export class SlotTerminalService {
  private readonly store: SlotTerminalStore;
  private readonly runtime: SlotTerminalRuntimeResolver;

  constructor(options: { store?: SlotTerminalStore; runtime?: SlotTerminalRuntimeResolver } = {}) {
    this.store = options.store ?? new PrismaSlotTerminalStore();
    this.runtime = options.runtime ?? new TmuxSlotTerminalRuntimeResolver();
  }

  async resolveRequirementTerminal(input: {
    projectId: string;
    requirementId: string;
  }): Promise<SlotTerminalDescriptor> {
    const [project, binding] = await Promise.all([
      this.store.findProject(input.projectId),
      this.store.findBindingForRequirement(input.projectId, input.requirementId)
    ]);

    if (!project || !isLiveRequirementBinding(binding, input.requirementId) || !isSlotId(binding.slotId, project.slotCount)) {
      throw new SlotTerminalNotFoundError("slot terminal binding not found");
    }

    const resolved = await this.runtime.resolveSlotPanes({
      projectRoot: project.localPath,
      slotId: binding.slotId
    });

    return {
      slotId: binding.slotId,
      sessionName: resolved.sessionName,
      panes: resolved.panes
    };
  }

  async resolveAgentGroupTerminal(input: {
    projectId: string;
    group: string;
  }): Promise<SlotTerminalDescriptor> {
    if (!isAgentGroupWindow(input.group)) {
      throw new SlotTerminalTargetForbiddenError("agent terminal group is not allowed");
    }

    const project = await this.store.findProject(input.projectId);
    if (!project) {
      throw new SlotTerminalNotFoundError("agent terminal project not found");
    }

    const resolved = await this.runtime.resolveSlotPaneCandidates({
      projectRoot: project.localPath,
      slotId: input.group
    });

    return {
      slotId: input.group,
      sessionName: resolved.sessionName,
      panes: strictAgentGroupPanes(input.group, resolved.candidatesByRole)
    };
  }

  async assertTargetBelongsTo(input: {
    requirementId: string;
    slotId: string;
    role: string;
    target: string;
  }): Promise<SlotTerminalPaneTarget> {
    if (!isSlotTerminalRole(input.role) || !input.target.trim()) {
      throw new SlotTerminalTargetForbiddenError("slot terminal target role is not allowed");
    }

    const projectId = await this.store.findProjectIdForRequirement(input.requirementId);
    if (!projectId) {
      throw new SlotTerminalTargetForbiddenError("slot terminal target does not belong to requirement");
    }

    const descriptor = await this.resolveRequirementTerminal({
      projectId,
      requirementId: input.requirementId
    }).catch((error: unknown) => {
      if (error instanceof SlotTerminalNotFoundError) {
        throw new SlotTerminalTargetForbiddenError("slot terminal target does not belong to requirement");
      }
      throw error;
    });

    if (descriptor.slotId !== input.slotId) {
      throw new SlotTerminalTargetForbiddenError("slot terminal target does not belong to slot");
    }

    const pane = matchPane(descriptor, input.role, input.target);
    if (!pane) {
      throw new SlotTerminalTargetForbiddenError("slot terminal target does not belong to role");
    }
    return pane;
  }

  async assertTargetBelongsToAgentGroup(input: {
    projectId: string;
    group: string;
    role: string;
    target: string;
  }): Promise<SlotTerminalPaneTarget> {
    if (!isSlotTerminalRole(input.role) || !input.target.trim()) {
      throw new SlotTerminalTargetForbiddenError("agent terminal target role is not allowed");
    }

    const descriptor = await this.resolveAgentGroupTerminal({
      projectId: input.projectId,
      group: input.group
    }).catch((error: unknown) => {
      if (error instanceof SlotTerminalNotFoundError) {
        throw new SlotTerminalTargetForbiddenError("agent terminal target does not belong to group");
      }
      throw error;
    });

    const pane = matchPane(descriptor, input.role, input.target);
    if (!pane) {
      throw new SlotTerminalTargetForbiddenError("agent terminal target does not belong to role");
    }
    return pane;
  }
}

export function buildSlotTerminalTmuxSocketPath(projectRoot: string): string {
  return join(projectRoot, TMUX_SOCKET_RELATIVE_PATH);
}

export function isSlotTerminalRole(value: string): value is SlotTerminalRole {
  return (SLOT_TERMINAL_ROLES as readonly string[]).includes(value);
}

function isAgentGroupWindow(value: string): value is AgentGroupWindow {
  return (AGENT_GROUP_WINDOWS as readonly string[]).includes(value);
}

function isLiveRequirementBinding(
  binding: SlotTerminalBinding | null,
  requirementId: string
): binding is SlotTerminalBinding {
  return Boolean(
    binding &&
      binding.requirementId === requirementId &&
      LIVE_BINDING_STATES.has(String(binding.state))
  );
}

async function readRuntimeRecords(projectRoot: string): Promise<RuntimeRecordEntry[]> {
  const agentsDir = join(projectRoot, ".ccb", "agents");
  const entries = await readdir(agentsDir, { withFileTypes: true }).catch(() => {
    throw new SlotTerminalNotFoundError("slot terminal runtime metadata not found");
  });
  const records: RuntimeRecordEntry[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const text = await readFile(join(agentsDir, entry.name, "runtime.json"), "utf8").catch(() => null);
    if (!text) {
      continue;
    }
    try {
      const record = JSON.parse(text) as RuntimeRecord;
      records.push({
        agentName: normalizeString(record.agent_name) ?? entry.name,
        record
      });
    } catch {
      continue;
    }
  }

  return records;
}

type RuntimePaneCandidateWithSession = SlotTerminalPaneCandidate & {
  sessionName: string;
};

function collectRuntimePaneCandidates(
  records: RuntimeRecordEntry[],
  slotId: string,
  paneById: Map<string, ListedPane>
): RuntimePaneCandidateWithSession[] {
  const candidates: RuntimePaneCandidateWithSession[] = [];

  for (const { agentName, record } of records) {
    const role = normalizeRuntimeRole(record.provider);
    const windowName = normalizeString(record.tmux_window_name);
    const paneId =
      normalizePaneId(record.pane_id) ??
      normalizePaneId(record.active_pane_id) ??
      normalizePaneId(parseRuntimeRef(record.runtime_ref));
    if (!role || windowName !== slotId || !paneId) {
      continue;
    }

    const pane = paneById.get(paneId);
    if (!pane || pane.windowName !== slotId || !normalizeString(pane.sessionName)) {
      continue;
    }

    candidates.push({
      sessionName: pane.sessionName,
      role,
      target: pane.paneId,
      paneIndex: pane.paneIndex,
      agentName
    });
  }

  return candidates;
}

function groupPaneCandidatesByRole(
  candidates: RuntimePaneCandidateWithSession[]
): Map<SlotTerminalRole, SlotTerminalPaneCandidate[]> {
  const candidatesByRole = new Map<SlotTerminalRole, SlotTerminalPaneCandidate[]>();

  for (const candidate of candidates) {
    candidatesByRole.set(candidate.role, [
      ...(candidatesByRole.get(candidate.role) ?? []),
      {
        role: candidate.role,
        target: candidate.target,
        paneIndex: candidate.paneIndex,
        agentName: candidate.agentName
      }
    ]);
  }
  return candidatesByRole;
}

function indexListedPanesById(listedPanes: ListedPane[]): Map<string, ListedPane> {
  const paneById = new Map<string, ListedPane>();
  for (const pane of listedPanes) {
    if (!pane.paneId) {
      continue;
    }
    if (paneById.has(pane.paneId)) {
      throw new SlotTerminalNotFoundError("slot terminal panes are not uniquely resolvable");
    }
    paneById.set(pane.paneId, pane);
  }
  return paneById;
}

function strictAgentGroupPanes(
  group: AgentGroupWindow,
  candidatesByRole: Map<SlotTerminalRole, SlotTerminalPaneCandidate[]>
): SlotTerminalPaneTarget[] {
  const panes: SlotTerminalPaneTarget[] = [];
  const expectedAgents: Record<AgentGroupWindow, Record<SlotTerminalRole, string>> = {
    main: {
      claude: "main_claude",
      codex: "main_codex"
    }
  };

  for (const role of SLOT_TERMINAL_ROLES) {
    const candidates = candidatesByRole.get(role) ?? [];
    if (candidates.length !== 1) {
      throw new SlotTerminalNotFoundError("agent terminal panes are not uniquely resolvable");
    }

    const candidate = candidates[0];
    if (candidate.agentName !== expectedAgents[group][role]) {
      throw new SlotTerminalNotFoundError("agent terminal runtime metadata does not match group");
    }

    panes.push({
      role: candidate.role,
      target: candidate.target,
      paneIndex: candidate.paneIndex
    });
  }

  return panes;
}

function matchPane(
  descriptor: SlotTerminalDescriptor,
  role: SlotTerminalRole,
  target: string
): SlotTerminalPaneTarget | null {
  return descriptor.panes.find((candidate) => candidate.role === role && candidate.target === target) ?? null;
}

function parsePaneLine(line: string): ListedPane {
  const [sessionName = "", windowName = "", paneId = "", paneIndex = "0"] = line.split("\t");
  return {
    sessionName,
    windowName,
    paneId,
    paneIndex: Number.parseInt(paneIndex, 10) || 0
  };
}

function normalizeRuntimeRole(value: unknown): SlotTerminalRole | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  return isSlotTerminalRole(normalized) ? normalized : null;
}

function normalizeString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizePaneId(value: unknown): string | null {
  const normalized = normalizeString(value);
  return normalized?.startsWith("%") ? normalized : null;
}

function parseRuntimeRef(value: unknown): string | null {
  const normalized = normalizeString(value);
  const match = normalized?.match(/^tmux:(%[0-9]+)$/);
  return match?.[1] ?? null;
}
