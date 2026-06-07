import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { AttentionCta, AttentionItem } from "./attention-inbox.types.js";

const INPUT_IDLE_MS = 60_000;
const DEBOUNCE_MS = 10_000;
const FALLBACK_REF_TTL_MS = 10 * 60_000;
const MAIN_ACTIVE_MIN_MS = 60_000;
const SUSPECT_STALE_MS = 60_000;

const MAIN_AGENT_NAMES = new Set(["main_claude", "main_codex"]);
const SUPPRESSED_WAITING_STATES = new Set(["unhealthy", "recovering", "draining", "released"]);
const ACTIVE_FAILED_SLOT_STATES = new Set(["bound", "busy"]);
const IMMEDIATE_REASONS = new Set<ProviderWaitingReason>(["permission", "question", "plan"]);

type ProviderWaitingReason = "permission" | "question" | "plan" | "input";
type ProviderName = "claude" | "codex" | string;

export interface ProviderActivitySlotBinding {
  projectId: string;
  slotId: string;
  requirementId: string | null;
  state: string;
  busySince?: Date | null;
  lastActivityAt?: Date | null;
  updatedAt: Date;
  requirement?: { title: string } | null;
}

export interface ProviderActivityDispatchRow {
  jobId: string;
  anchorId: string;
  subjectType: string;
  subjectId: string;
  status: string;
  queuedAt: Date;
  submittedAt: Date | null;
}

export interface ProviderActivityCollectInput {
  projectId: string;
  projectRoot: string;
  now: Date;
  ackedRefs?: ReadonlySet<string>;
  slotBindings: readonly ProviderActivitySlotBinding[];
  dispatchRows: readonly ProviderActivityDispatchRow[];
  taskRequirementByTaskId: ReadonlyMap<string, string | null>;
  requirementTitleById: ReadonlyMap<string, string>;
}

export interface CcbConfigAgentBinding {
  windowName: string;
  agentName: string;
  provider: ProviderName;
}

interface ProviderActivityRecord {
  agentName: string;
  provider: ProviderName;
  state: string;
  eventName: string | null;
  updatedAt: Date;
  providerSessionId: string | null;
  providerTurnId: string | null;
  ccbSessionId: string | null;
  diagnostics: Record<string, unknown>;
}

interface MainAgentState {
  lastState: string;
  activeSince: Date | null;
}

interface DebounceEntry {
  firstSeenMs: number;
  lastSeenMs: number;
}

export class ProviderActivitySource {
  private readonly debounceFirstSeen = new Map<string, DebounceEntry>();
  private readonly mainAgentState = new Map<string, MainAgentState>();
  private readonly completedItems = new Map<string, AttentionItem>();

  async collect(input: ProviderActivityCollectInput): Promise<AttentionItem[]> {
    this.sweepDebounceEntries(input.now);
    this.deleteAckedCompletedItems(input.projectId, input.ackedRefs ?? new Set());

    const configText = await readFile(join(input.projectRoot, ".ccb", "ccb.config"), "utf8").catch(() => null);
    if (!configText) {
      return [];
    }

    const bindings = parseCcbConfigAgentBindings(configText);
    const slotBindingBySlot = new Map(input.slotBindings.map((row) => [row.slotId, row]));
    const dispatchesBySlot = groupDispatchRowsBySlot(input.dispatchRows);
    const items: AttentionItem[] = [];

    for (const binding of bindings) {
      const activity = await this.readActivity(input.projectRoot, binding);
      if (!activity) {
        continue;
      }

      const slotBinding = binding.windowName === "main" ? null : slotBindingBySlot.get(binding.windowName) ?? null;
      if (binding.windowName !== "main" && !slotBinding) {
        continue;
      }

      const waiting = this.projectWaiting(input, binding, activity, slotBinding);
      if (waiting) {
        items.push(waiting);
      }

      const failed = this.projectFailed(input, binding, activity, slotBinding);
      if (failed) {
        items.push(failed);
      }

      const suspect = this.projectSuspect(input, binding, activity, slotBinding, dispatchesBySlot.get(binding.windowName) ?? []);
      if (suspect) {
        items.push(suspect);
      }

      this.projectMainCompletion(input, binding, activity);
    }

    return [...items, ...this.completedItemsForProject(input.projectId)];
  }

  resetForTests() {
    this.debounceFirstSeen.clear();
    this.mainAgentState.clear();
    this.completedItems.clear();
  }

  private async readActivity(
    projectRoot: string,
    binding: CcbConfigAgentBinding
  ): Promise<ProviderActivityRecord | null> {
    const path = join(
      projectRoot,
      ".ccb",
      "agents",
      binding.agentName,
      "provider-runtime",
      binding.provider,
      "activity.json"
    );
    const raw = await readFile(path, "utf8").catch(() => null);
    if (!raw) {
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const updatedAt = parseDate(text(parsed.updated_at ?? parsed.updatedAt), new Date(0));
      if (updatedAt.getTime() === 0) {
        return null;
      }
      return {
        agentName: text(parsed.agent_name ?? parsed.agentName) ?? binding.agentName,
        provider: text(parsed.provider) ?? binding.provider,
        state: text(parsed.state) ?? "unknown",
        eventName: text(parsed.event_name ?? parsed.eventName) ?? null,
        updatedAt,
        providerSessionId: text(parsed.provider_session_id ?? parsed.providerSessionId) ?? null,
        providerTurnId: text(parsed.provider_turn_id ?? parsed.providerTurnId) ?? null,
        ccbSessionId: text(parsed.ccb_session_id ?? parsed.ccbSessionId) ?? null,
        diagnostics: record(parsed.diagnostics)
      };
    } catch {
      return null;
    }
  }

  private projectWaiting(
    input: ProviderActivityCollectInput,
    binding: CcbConfigAgentBinding,
    activity: ProviderActivityRecord,
    slotBinding: ProviderActivitySlotBinding | null
  ): AttentionItem | null {
    const reason = deriveWaitingReason(activity, input.now);
    if (!reason) {
      return null;
    }
    if (slotBinding && SUPPRESSED_WAITING_STATES.has(slotBinding.state)) {
      return null;
    }
    if (binding.windowName === "main" || !slotBinding?.requirementId || !ACTIVE_FAILED_SLOT_STATES.has(slotBinding.state)) {
      return null;
    }

    const ref = providerActivityRef(activity, reason, input.now);
    if (!IMMEDIATE_REASONS.has(reason) && !this.debounceReady(`${input.projectId}:${ref}`, input.now)) {
      return null;
    }

    const requirementId = slotBinding?.requirementId ?? null;
    return {
      ref,
      kind: "agent_waiting",
      source: "provider_activity",
      severity: "attention",
      subjectType: "agent",
      projectId: input.projectId,
      requirementId,
      taskId: null,
      taskKey: null,
      slotId: binding.windowName === "main" ? null : binding.windowName,
      title: agentWaitingTitle(activity.agentName, reason),
      summary: agentWaitingSummary(binding, activity, reason, slotBinding),
      createdAt: activity.updatedAt.toISOString(),
      updatedAt: activity.updatedAt.toISOString(),
      cta: providerActivityCta(input.projectId, requirementId, binding.windowName),
      metadata: {
        agentName: activity.agentName,
        provider: activity.provider,
        reason,
        eventName: activity.eventName,
        diagnostics: activity.diagnostics
      }
    };
  }

  private projectFailed(
    input: ProviderActivityCollectInput,
    binding: CcbConfigAgentBinding,
    activity: ProviderActivityRecord,
    slotBinding: ProviderActivitySlotBinding | null
  ): AttentionItem | null {
    if (activity.state !== "failed") {
      return null;
    }
    if (binding.windowName !== "main" && (!slotBinding?.requirementId || !ACTIVE_FAILED_SLOT_STATES.has(slotBinding.state))) {
      return null;
    }

    const reason = text(activity.diagnostics.reason) ?? activity.eventName ?? "provider failed";
    const requirementId = slotBinding?.requirementId ?? null;
    return {
      ref: providerActivityRef(activity, "failed", input.now),
      kind: "agent_failed",
      source: "provider_activity",
      severity: "attention",
      subjectType: "agent",
      projectId: input.projectId,
      requirementId,
      taskId: null,
      taskKey: null,
      slotId: binding.windowName === "main" ? null : binding.windowName,
      title: `${activity.agentName} 运行失败`,
      summary: `${activity.agentName}: ${reason}`,
      createdAt: activity.updatedAt.toISOString(),
      updatedAt: activity.updatedAt.toISOString(),
      cta: providerActivityCta(input.projectId, requirementId, binding.windowName),
      metadata: {
        agentName: activity.agentName,
        provider: activity.provider,
        reason,
        eventName: activity.eventName,
        diagnostics: activity.diagnostics
      }
    };
  }

  private projectSuspect(
    input: ProviderActivityCollectInput,
    binding: CcbConfigAgentBinding,
    activity: ProviderActivityRecord,
    slotBinding: ProviderActivitySlotBinding | null,
    dispatchRows: readonly ProviderActivityDispatchRow[]
  ): AttentionItem | null {
    if (!slotBinding?.requirementId || slotBinding.state !== "busy" || dispatchRows.length === 0) {
      return null;
    }
    const requirementId = slotBinding.requirementId;
    const matchingDispatchRows = dispatchRows.filter((row) =>
      dispatchMatchesRequirement(row, requirementId, input.taskRequirementByTaskId)
    );
    if (matchingDispatchRows.length === 0) {
      return null;
    }
    if (activity.state === "pending" || activity.state === "failed") {
      return null;
    }
    if (input.now.getTime() - activity.updatedAt.getTime() < SUSPECT_STALE_MS) {
      return null;
    }

    const dispatch = matchingDispatchRows[0];
    return {
      ref: `provider_activity:${activity.agentName}/${dispatch?.jobId ?? fallbackIdentity(activity, input.now)}/suspect`,
      kind: "agent_attention_suspect",
      source: "provider_activity",
      severity: "warning",
      subjectType: "agent",
      projectId: input.projectId,
      requirementId: slotBinding.requirementId,
      taskId: null,
      taskKey: null,
      slotId: binding.windowName,
      title: `${activity.agentName} 可能需要关注`,
      summary: `${binding.windowName}: 已派 job 长时间无 activity 进展`,
      createdAt: activity.updatedAt.toISOString(),
      updatedAt: activity.updatedAt.toISOString(),
      cta: providerActivityCta(input.projectId, slotBinding.requirementId, binding.windowName),
      metadata: {
        agentName: activity.agentName,
        provider: activity.provider,
        reason: "suspect",
        jobId: dispatch?.jobId ?? null,
        state: activity.state
      }
    };
  }

  private projectMainCompletion(
    input: ProviderActivityCollectInput,
    binding: CcbConfigAgentBinding,
    activity: ProviderActivityRecord
  ): AttentionItem | null {
    const key = `${input.projectId}:${activity.agentName}`;
    const previous = this.mainAgentState.get(key);
    const activeSince =
      activity.state === "active"
        ? previous?.lastState === "active" && previous.activeSince
          ? previous.activeSince
          : activity.updatedAt
        : null;
    this.mainAgentState.set(key, { lastState: activity.state, activeSince });

    if (!MAIN_AGENT_NAMES.has(binding.agentName) || binding.windowName !== "main") {
      return null;
    }
    if (activity.state !== "idle" || previous?.lastState !== "active" || !previous.activeSince) {
      return null;
    }
    if (activity.updatedAt.getTime() - previous.activeSince.getTime() < MAIN_ACTIVE_MIN_MS) {
      return null;
    }

    const ref = `${providerActivityRef(activity, "completed", input.now)}/${activity.updatedAt.toISOString()}`;
    const completedKey = completedItemKey(input.projectId, ref);
    if (this.completedItems.has(completedKey)) {
      return null;
    }
    const item: AttentionItem = {
      ref,
      kind: "agent_completed",
      source: "provider_activity",
      severity: "attention",
      subjectType: "agent",
      projectId: input.projectId,
      requirementId: null,
      taskId: null,
      taskKey: null,
      slotId: null,
      title: `${activity.agentName} 任务完成`,
      summary: `${activity.agentName} 已从 active 转为 idle`,
      createdAt: activity.updatedAt.toISOString(),
      updatedAt: activity.updatedAt.toISOString(),
      cta: providerActivityCta(input.projectId, null, "main"),
      metadata: {
        agentName: activity.agentName,
        provider: activity.provider,
        reason: "completed",
        activeSince: previous.activeSince.toISOString(),
        eventName: activity.eventName
      }
    };
    this.completedItems.set(completedKey, item);
    return item;
  }

  private completedItemsForProject(projectId: string): AttentionItem[] {
    return [...this.completedItems.values()].filter((item) => item.projectId === projectId);
  }

  private deleteAckedCompletedItems(projectId: string, ackedRefs: ReadonlySet<string>): void {
    if (ackedRefs.size === 0) {
      return;
    }
    for (const [key, item] of this.completedItems) {
      if (item.projectId === projectId && ackedRefs.has(item.ref)) {
        this.completedItems.delete(key);
      }
    }
  }

  private sweepDebounceEntries(now: Date): void {
    const cutoffMs = now.getTime() - FALLBACK_REF_TTL_MS;
    for (const [key, entry] of this.debounceFirstSeen) {
      if (entry.lastSeenMs < cutoffMs) {
        this.debounceFirstSeen.delete(key);
      }
    }
  }

  private debounceReady(key: string, now: Date): boolean {
    const nowMs = now.getTime();
    const entry = this.debounceFirstSeen.get(key);
    if (!entry) {
      this.debounceFirstSeen.set(key, { firstSeenMs: nowMs, lastSeenMs: nowMs });
      return false;
    }
    entry.lastSeenMs = nowMs;
    return nowMs - entry.firstSeenMs >= DEBOUNCE_MS;
  }
}

function completedItemKey(projectId: string, ref: string): string {
  return `${projectId}:${ref}`;
}

function dispatchMatchesRequirement(
  row: ProviderActivityDispatchRow,
  requirementId: string,
  taskRequirementByTaskId: ReadonlyMap<string, string | null>
): boolean {
  if (row.subjectType === "requirement") {
    return row.subjectId === requirementId;
  }
  if (row.subjectType === "subtask") {
    return taskRequirementByTaskId.get(row.subjectId) === requirementId;
  }
  return false;
}

export function parseCcbConfigAgentBindings(configText: string): CcbConfigAgentBinding[] {
  const windows = new Map<string, Array<{ agentName: string; provider: string | null }>>();
  const agentProviders = new Map<string, string>();
  let section = "";
  let currentAgent = "";

  for (const rawLine of configText.split(/\r?\n/)) {
    const line = stripInlineComment(rawLine).trim();
    if (!line) {
      continue;
    }

    const sectionMatch = line.match(/^\[([^\]]+)]$/);
    if (sectionMatch?.[1]) {
      section = sectionMatch[1];
      currentAgent = "";
      const agentMatch = section.match(/^agents\.([A-Za-z0-9_-]+)$/);
      if (agentMatch?.[1]) {
        currentAgent = agentMatch[1];
      }
      continue;
    }

    const assignment = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/);
    if (!assignment?.[1] || !assignment[2]) {
      continue;
    }

    if (section === "windows") {
      const windowName = assignment[1];
      const value = parseTomlString(assignment[2]);
      windows.set(windowName, parseWindowAgents(value));
      continue;
    }

    if (currentAgent && assignment[1] === "provider") {
      agentProviders.set(currentAgent, parseTomlString(assignment[2]));
    }
  }

  const result: CcbConfigAgentBinding[] = [];
  for (const [windowName, agents] of windows) {
    for (const agent of agents) {
      const provider = agent.provider ?? agentProviders.get(agent.agentName);
      if (!provider) {
        continue;
      }
      result.push({ windowName, agentName: agent.agentName, provider });
    }
  }
  return result;
}

function parseWindowAgents(value: string): Array<{ agentName: string; provider: string | null }> {
  return value.split(";").flatMap((entry) => {
    const [rawAgentName, rawProvider] = entry.split(":");
    const agentName = rawAgentName?.trim();
    if (!agentName) {
      return [];
    }
    return [{ agentName, provider: rawProvider?.trim() || null }];
  });
}

function parseTomlString(rawValue: string): string {
  const value = rawValue.trim().replace(/,$/, "").trim();
  if (value.startsWith("\"") && value.endsWith("\"")) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  return value;
}

function groupDispatchRowsBySlot(
  rows: readonly ProviderActivityDispatchRow[]
): Map<string, ProviderActivityDispatchRow[]> {
  const bySlot = new Map<string, ProviderActivityDispatchRow[]>();
  for (const row of rows) {
    if (!["pending", "submitted"].includes(row.status)) {
      continue;
    }
    const bucket = bySlot.get(row.anchorId) ?? [];
    bucket.push(row);
    bySlot.set(row.anchorId, bucket);
  }
  for (const bucket of bySlot.values()) {
    bucket.sort((left, right) => {
      const leftTime = (left.submittedAt ?? left.queuedAt).getTime();
      const rightTime = (right.submittedAt ?? right.queuedAt).getTime();
      return rightTime - leftTime;
    });
  }
  return bySlot;
}

function deriveWaitingReason(activity: ProviderActivityRecord, now: Date): ProviderWaitingReason | null {
  const toolName = text(activity.diagnostics.tool_name ?? activity.diagnostics.toolName);
  if (activity.eventName === "PreToolUse" && toolName === "AskUserQuestion") {
    return "question";
  }
  if (activity.eventName === "PreToolUse" && toolName === "ExitPlanMode") {
    return "plan";
  }
  if (activity.state !== "pending") {
    return null;
  }
  if (
    activity.eventName === "PermissionRequest" ||
    toolName === "PermissionRequest" ||
    text(activity.diagnostics.reason)?.toLowerCase().includes("permission")
  ) {
    return "permission";
  }
  if (activity.eventName === "Notification" && now.getTime() - activity.updatedAt.getTime() < INPUT_IDLE_MS) {
    return null;
  }
  return "input";
}

function providerActivityRef(activity: ProviderActivityRecord, reason: string, now: Date): string {
  if (activity.providerSessionId) {
    return `provider_activity:${activity.agentName}/${activity.providerSessionId}/${reason}`;
  }
  if (activity.providerTurnId) {
    return `provider_activity:${activity.agentName}/${activity.providerTurnId}/${reason}`;
  }
  if (activity.ccbSessionId) {
    return `provider_activity:${activity.agentName}/${activity.ccbSessionId}/${reason}`;
  }
  return `provider_activity:${activity.agentName}/${activity.provider}/${reason}/ttl-${fallbackTtlBucket(now)}`;
}

function fallbackIdentity(activity: ProviderActivityRecord, now: Date): string {
  return `${activity.provider}/ttl-${fallbackTtlBucket(now)}`;
}

function fallbackTtlBucket(now: Date): number {
  return Math.floor(now.getTime() / FALLBACK_REF_TTL_MS);
}

function providerActivityCta(projectId: string, requirementId: string | null, windowName: string): AttentionCta {
  if (requirementId) {
    return {
      type: "requirement",
      label: "打开需求",
      projectId,
      requirementId,
      slotId: windowName === "main" ? null : windowName
    };
  }
  return {
    type: "project",
    label: "打开项目",
    projectId,
    slotId: windowName === "main" ? null : windowName
  };
}

function agentWaitingTitle(agentName: string, reason: ProviderWaitingReason): string {
  if (reason === "permission") return `${agentName} 等待权限确认`;
  if (reason === "question") return `${agentName} 等待问题答复`;
  if (reason === "plan") return `${agentName} 等待计划批准`;
  return `${agentName} 等待输入`;
}

function agentWaitingSummary(
  binding: CcbConfigAgentBinding,
  activity: ProviderActivityRecord,
  reason: ProviderWaitingReason,
  slotBinding: ProviderActivitySlotBinding | null
): string {
  const requirementTitle = slotBinding?.requirement?.title ?? null;
  const subject = requirementTitle ? `${binding.windowName}: ${requirementTitle}` : binding.windowName;
  return `${subject} · ${activity.provider} · ${reason}`;
}

function parseDate(value: string | undefined, fallback: Date): Date {
  if (!value) {
    return fallback;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
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
