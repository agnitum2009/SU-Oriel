import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";

import {
  agentCore as deriveAgentCore,
  agentNamesForSlot,
  managedAgentNames as deriveManagedAgentNames,
  managedWindowNames as deriveManagedWindowNames,
  slotIds as deriveSlotIds,
  type AgentCore,
  type SlotId
} from "../slot-topology/slot-topology.service.js";
import {
  defaultManagedConfigMutationLock,
  type ManagedConfigMutationLock
} from "./managed-config-mutation-lock.js";

export const DEFAULT_PROJECT_SLOT_COUNT = 3;

export type ManagedCcbConfigTopology = {
  slotCount: number;
  slotIds: readonly SlotId[];
  windowNames: readonly string[];
  agentNames: readonly string[];
  agentCore: Record<string, AgentCore>;
};

export type ManagedAgentFields = Record<string, Record<string, string>>;

export function projectSlotTopology(slotCount: number = DEFAULT_PROJECT_SLOT_COUNT): ManagedCcbConfigTopology {
  return {
    slotCount,
    slotIds: deriveSlotIds(slotCount),
    windowNames: deriveManagedWindowNames(slotCount),
    agentNames: deriveManagedAgentNames(slotCount),
    agentCore: deriveAgentCore(slotCount)
  };
}

const DEFAULT_MANAGED_TOPOLOGY = projectSlotTopology(DEFAULT_PROJECT_SLOT_COUNT);

export const MANAGED_WINDOW_NAMES = DEFAULT_MANAGED_TOPOLOGY.windowNames;
export const MANAGED_AGENT_NAMES = DEFAULT_MANAGED_TOPOLOGY.agentNames;

export const MANAGED_CCB_CONFIG_RELATIVE_PATH = join(".ccb", "ccb.config");

export type ManagedCcbConfigRenderInput = {
  projectId: string;
  projectRoot: string;
  topology: ManagedCcbConfigTopology;
  existingConfigText?: string | null;
  slotAgentOverridesJson?: string | null;
  sidebarViewTips?: readonly string[] | null;
};

export type ManagedCcbConfigEnsureInput = ManagedCcbConfigRenderInput & {
  mutationLock?: ManagedConfigMutationLock;
};

export type ManagedCcbConfigRenderOptions = {
  slotAgentOverrides?: ManagedAgentFields;
  sidebarViewTips?: readonly string[] | null;
};

export type ManagedCcbConfigDrift = {
  kind: "missing" | "core_drift" | "invalid_windows_topology";
  diff: string;
  requiresUserConfirmation: boolean;
};

export type ManagedCcbConfigRenderResult = {
  configText: string;
  coreSignature: string;
  drift: ManagedCcbConfigDrift | null;
};

const CLAUDE_AGENT_DEFAULTS = {
  model: '"opus[1m]"',
  startup_args: '["--effort", "max"]'
};

const NON_CORE_AGENT_KEYS = new Set([
  "model",
  "startup_args",
  "display_label",
  "profile",
  "auth_profile",
  "theme",
  "log_level"
]);

const CORE_AGENT_KEYS = ["provider", "target", "workspace_mode", "runtime_mode", "restore", "permission", "queue_policy"];

export function buildManagedCcbConfig(
  topology: ManagedCcbConfigTopology,
  preservedAgentFields: ManagedAgentFields = {},
  options: ManagedCcbConfigRenderOptions = {}
): string {
  const lines = [
    "version = 2",
    'entry_window = "main"',
    "",
    "[windows]",
    'main = "main_claude:claude; main_codex:codex"',
    ...topology.slotIds.map((slotId) => {
      const [claudeAgentName, codexAgentName] = agentNamesForSlot(slotId);
      return `${slotId} = "${claudeAgentName}:claude; ${codexAgentName}:codex"`;
    }),
    "",
    "[ui.sidebar]",
    'mode = "every_window"',
    'width = "15%"',
    "bottom_height = 20",
    ""
  ];

  if (options.sidebarViewTips) {
    lines.push("[ui.sidebar.view]", "tips_enabled = true", ...renderTomlStringArray("tips", options.sidebarViewTips), "");
  }

  const slotAgentOverrides = options.slotAgentOverrides ?? {};
  for (const agentName of topology.agentNames) {
    const core = topology.agentCore[agentName];
    if (!core) continue;
    lines.push(
      `[agents.${agentName}]`,
      `provider = "${core.provider}"`,
      'target = "."',
      'workspace_mode = "inplace"',
      'runtime_mode = "pane-backed"',
      'restore = "auto"',
      'permission = "manual"',
      'queue_policy = "serial-per-agent"'
    );
    const preserved = preservedAgentFields[agentName] ?? {};
    const overrides = slotAgentOverrides[agentName] ?? {};
    const agentDefaults = core.provider === "claude" ? CLAUDE_AGENT_DEFAULTS : {};
    const nonCoreFields = { ...agentDefaults, ...overrides, ...preserved };
    for (const [key, value] of Object.entries(nonCoreFields)) {
      if (NON_CORE_AGENT_KEYS.has(key)) {
        lines.push(`${key} = ${value}`);
      }
    }
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderManagedCcbConfig(input: ManagedCcbConfigRenderInput): ManagedCcbConfigRenderResult {
  const preserved = collectPreservedAgentFields(input.existingConfigText ?? "", input.topology);
  const slotAgentOverrides = parseSlotAgentOverridesJson(input.slotAgentOverridesJson, input.topology);
  const configText = buildManagedCcbConfig(input.topology, preserved, {
    slotAgentOverrides,
    sidebarViewTips: input.sidebarViewTips
  });
  const coreSignature = computeManagedCoreSignature(configText, input.topology);
  const existingText = input.existingConfigText?.trim() ? input.existingConfigText : null;

  if (!existingText) {
    return {
      configText,
      coreSignature,
      drift: {
        kind: "missing",
        diff: "missing .ccb/ccb.config",
        requiresUserConfirmation: false
      }
    };
  }

  const existingSignature = computeManagedCoreSignature(existingText, input.topology);
  if (existingSignature === coreSignature) {
    return {
      configText,
      coreSignature,
      drift: null
    };
  }

  const kind = hasWindowsTable(existingText) ? "core_drift" : "invalid_windows_topology";
  return {
    configText,
    coreSignature,
    drift: {
      kind,
      diff: buildCoreDiff(existingText, configText, input.topology),
      requiresUserConfirmation: true
    }
  };
}

export async function ensureManagedCcbConfig(input: ManagedCcbConfigEnsureInput): Promise<ManagedCcbConfigRenderResult> {
  const mutationLock = input.mutationLock ?? defaultManagedConfigMutationLock;
  return await mutationLock.runExclusive(input.projectId, async () => {
    const configPath = join(input.projectRoot, MANAGED_CCB_CONFIG_RELATIVE_PATH);
    const existingConfigText = input.existingConfigText ?? await readFile(configPath, "utf8").catch(() => null);
    const result = renderManagedCcbConfig({
      projectId: input.projectId,
      projectRoot: input.projectRoot,
      topology: input.topology,
      existingConfigText,
      slotAgentOverridesJson: input.slotAgentOverridesJson,
      sidebarViewTips: input.sidebarViewTips
    });

    const configDir = join(input.projectRoot, ".ccb");
    const tempPath = join(configDir, `.ccb.config.${process.pid}.${randomUUID()}.tmp`);
    await mkdir(configDir, { recursive: true });
    try {
      await writeFile(tempPath, result.configText, "utf8");
      await rename(tempPath, configPath);
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
    return result;
  });
}

export function computeManagedCoreSignature(configText: string, topology: ManagedCcbConfigTopology): string {
  const coreLines = collectCoreLines(configText, topology);
  return createHash("sha256").update(coreLines.join("\n"), "utf8").digest("hex");
}

export function collectCoreLines(configText: string, topology: ManagedCcbConfigTopology): string[] {
  const lines = configText.split(/\r?\n/);
  const coreLines: string[] = [];
  let section = "";
  let currentAgent = "";
  const managedWindows = new Set(topology.windowNames);
  const managedAgents = new Set(topology.agentNames);

  for (const rawLine of lines) {
    const line = stripInlineComment(rawLine).trim();
    if (!line) continue;

    const sectionMatch = line.match(/^\[([^\]]+)]$/);
    if (sectionMatch?.[1]) {
      section = sectionMatch[1];
      currentAgent = "";
      const agentMatch = section.match(/^agents\.([A-Za-z0-9_-]+)$/);
      if (agentMatch?.[1]) {
        currentAgent = agentMatch[1];
      }
      if (section === "windows" || section === "ui.sidebar" || managedAgents.has(currentAgent)) {
        coreLines.push(`[${section}]`);
      }
      continue;
    }

    const keyMatch = line.match(/^([A-Za-z0-9_-]+)\s*=/);
    const key = keyMatch?.[1] ?? "";
    if (section === "" && ["version", "entry_window"].includes(key)) {
      coreLines.push(normalizeAssignment(line));
      continue;
    }
    if (section === "windows" && managedWindows.has(key)) {
      coreLines.push(normalizeAssignment(line));
      continue;
    }
    if (section === "ui.sidebar" && ["mode", "width", "bottom_height"].includes(key)) {
      coreLines.push(normalizeAssignment(line));
      continue;
    }
    if (currentAgent && managedAgents.has(currentAgent) && CORE_AGENT_KEYS.includes(key)) {
      coreLines.push(normalizeAssignment(line));
    }
  }

  return coreLines;
}

export function collectPreservedAgentFields(configText: string, topology: ManagedCcbConfigTopology): ManagedAgentFields {
  const preserved: ManagedAgentFields = {};
  const managedAgents = new Set(topology.agentNames);
  let currentAgent = "";
  for (const rawLine of configText.split(/\r?\n/)) {
    const line = stripInlineComment(rawLine).trim();
    const sectionMatch = line.match(/^\[agents\.([A-Za-z0-9_-]+)]$/);
    if (sectionMatch?.[1]) {
      currentAgent = sectionMatch[1];
      continue;
    }
    if (!currentAgent || !managedAgents.has(currentAgent)) {
      continue;
    }
    const assignment = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/);
    const key = assignment?.[1];
    const value = assignment?.[2];
    if (key && value && NON_CORE_AGENT_KEYS.has(key)) {
      preserved[currentAgent] ??= {};
      preserved[currentAgent][key] = value.trim();
    }
  }
  return preserved;
}

export function parseSlotAgentOverridesJson(
  rawJson: string | null | undefined,
  topology: ManagedCcbConfigTopology
): ManagedAgentFields {
  if (!rawJson?.trim()) {
    return {};
  }

  const parsed = JSON.parse(rawJson) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }

  const slotAgentNames = new Set(topology.slotIds.flatMap((slotId) => [...agentNamesForSlot(slotId)]));
  return sanitizeAgentFields(parsed as Record<string, unknown>, slotAgentNames);
}

export function collectSlotAgentOverridesJson(
  configText: string,
  topology: ManagedCcbConfigTopology,
  slotIdsToCollect: readonly SlotId[] = topology.slotIds
): string | null {
  const preserved = collectPreservedAgentFields(configText, topology);
  const slotAgentNames = new Set(slotIdsToCollect.flatMap((slotId) => [...agentNamesForSlot(slotId)]));
  const collected = sanitizeAgentFields(preserved, slotAgentNames);
  return Object.keys(collected).length > 0 ? JSON.stringify(collected) : null;
}

function renderTomlStringArray(key: string, values: readonly string[]): string[] {
  if (values.length === 0) {
    return [`${key} = []`];
  }
  return [
    `${key} = [`,
    ...values.map((value) => `  ${JSON.stringify(value)},`),
    "]"
  ];
}

function sanitizeAgentFields(input: Record<string, unknown>, allowedAgentNames: ReadonlySet<string>): ManagedAgentFields {
  const sanitized: ManagedAgentFields = {};
  for (const agentName of Object.keys(input).sort()) {
    if (!allowedAgentNames.has(agentName)) {
      continue;
    }
    const fields = input[agentName];
    if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
      continue;
    }
    for (const key of Object.keys(fields as Record<string, unknown>).sort()) {
      const value = (fields as Record<string, unknown>)[key];
      if (NON_CORE_AGENT_KEYS.has(key) && typeof value === "string") {
        sanitized[agentName] ??= {};
        sanitized[agentName][key] = value.trim();
      }
    }
  }
  return sanitized;
}

function buildCoreDiff(existingText: string, managedText: string, topology: ManagedCcbConfigTopology): string {
  const existing = new Set(collectCoreLines(existingText, topology));
  const managed = new Set(collectCoreLines(managedText, topology));
  const missing = [...managed].filter((line) => !existing.has(line)).map((line) => `+ ${line}`);
  const extra = [...existing].filter((line) => !managed.has(line)).map((line) => `- ${line}`);
  return [...missing, ...extra].join("\n");
}

function hasWindowsTable(configText: string): boolean {
  return /^\s*\[windows]\s*$/m.test(configText);
}

function normalizeAssignment(line: string): string {
  return line.replace(/\s*=\s*/, " = ").trim();
}

function stripInlineComment(line: string): string {
  let quoted = false;
  let quote = "";
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if ((char === "\"" || char === "'") && (index === 0 || line[index - 1] !== "\\")) {
      if (!quoted) {
        quoted = true;
        quote = char;
      } else if (quote === char) {
        quoted = false;
        quote = "";
      }
      continue;
    }
    if (char === "#" && !quoted) {
      return line.slice(0, index);
    }
  }
  return line;
}
