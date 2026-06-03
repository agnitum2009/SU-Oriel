import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ProjectIndexHealthView, ProjectView } from "../types/project.js";
import type { RequirementView } from "../types/requirement.js";
import type { SyncJobView } from "../types/sync-job.js";
import type { TaskDetailView, TaskView } from "../types/task.js";

vi.mock("../lib/console-api.js", () => ({
  resolveApiBaseUrl: vi.fn(() => ""),
  buildApiUrl: vi.fn((path: string) => path),
  fetchVersion: vi.fn().mockResolvedValue({
    name: "su-oriel-server",
    version: "0.1.0",
    gitSha: "unknown",
    buildDate: ""
  }),
  fetchProjects: vi.fn(),
  createProject: vi.fn(),
  scanProject: vi.fn(),
  fetchProjectIndexHealth: vi.fn(),
  fetchProjectScanStatus: vi.fn(),
  fetchProjectOnboardingStatus: vi.fn().mockResolvedValue({
    projectId: "project-1",
    localPath: "/tmp/pr12",
    ccbRuntimeReady: true,
    knowledgeBaseReady: true,
    ccbConfigPath: "/tmp/pr12/.ccb/ccb.config",
    knowledgeBaseRootPath: "/tmp/pr12/docs/.ccb/index",
    manualCommand: "cd /tmp/pr12 && ccb",
    checkedAt: "2026-05-20T00:00:00.000Z"
  }),
  initProjectKnowledgeBase: vi.fn(),
  fetchProjectInitJobStatus: vi.fn(),
  fetchDocuments: vi.fn(),
  fetchDocumentDetail: vi.fn(),
  fetchTasks: vi.fn(),
  fetchTaskDetail: vi.fn(),
  fetchEventJournalEvents: vi.fn().mockResolvedValue({ items: [], pageInfo: { limit: 20, offset: 0, count: 0 } }),
  updateTask: vi.fn(),
  fetchRequirements: vi.fn(),
  reindexRequirement: vi.fn().mockResolvedValue({ reindexed: true, deduped: false, status: "success", issues: [] }),
  fetchSyncJobs: vi.fn(),
  createRequirement: vi.fn(),
  fetchSlots: vi.fn(),
  fetchTerminalDescriptor: vi.fn(),
  createTaskWorkspace: vi.fn(),
  cleanupTaskWorkspace: vi.fn(),
  dispatchTaskAnchorCommand: vi.fn(),
  createReviewIntent: vi.fn(),
  cancelReviewIntent: vi.fn(),
  fetchRequirementAggregation: vi.fn(),
  cancelRequirement: vi.fn(),
  refreshProjectRequirementStatus: vi.fn().mockResolvedValue({ updated: 0, checked: 0 }),
  refreshRequirementStatus: vi.fn().mockResolvedValue({ updated: false, oldStatus: null, newStatus: null })
}));

vi.mock("../lib/user-intent-api.js", () => ({
  fetchPendingIntent: vi.fn().mockResolvedValue(null),
  resumeWithIntent: vi.fn(),
  stopAndAppend: vi.fn()
}));

import App from "../App.js";
import * as consoleApi from "../lib/console-api.js";

class MockEventSource extends EventTarget {
  static instances: MockEventSource[] = [];
  close = vi.fn();
  constructor(public url: string) { super(); MockEventSource.instances.push(this); }
  msg(data: unknown) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(data) })); }
  projection(data: unknown) { this.dispatchEvent(new MessageEvent("projection", { data: JSON.stringify(data) })); }
}

const project: ProjectView = {
  id: "project-1",
  name: "PR12 Fixture",
  localPath: "/tmp/pr12",
  summary: "Task detail v2 acceptance.",
  initStatus: "initialized",
  syncStatus: "idle",
  lastScanAt: "2026-05-09T00:00:00.000Z"
};

const task: TaskView = {
  id: "task-1",
  projectId: "project-1",
  taskKey: "task-pr12",
  title: "PR12 cutover task",
  summary: "Verify the final task detail cutover.",
  kind: "subtask",
  status: "reviewing",
  phase: "implementation",
  currentNode: "implementation",
  nodeSubstate: "executing",
  runtimeState: "running",
  lastTransitionId: "dispatch__done",
  priority: "high",
  progress: 70,
  step: null,
  blockedReason: null,
  requirementId: "req-1",
  reviewStatus: "passed",
  semanticKind: "subtask",
  updatedAt: "2026-05-09T00:00:00.000Z"
};

const detail: TaskDetailView = {
  ...task,
  linkedRequirement: { id: "req-1", title: "PR12 requirement", verbatimSource: "Cut over to task detail v2." },
  linkedDocuments: [{ id: "doc-dev-task", path: "docs/03_开发计划/task-pr12-开发任务.md", kind: "dev_task", title: "PR12 dev task", status: "reviewing" }],
  workspaces: [{
    id: "workspace-1",
    projectId: "project-1",
    taskId: "task-1",
    taskKey: "task-pr12",
    baseRef: "HEAD",
    branchName: "task/pr12",
    workspacePath: "/tmp/pr12/.workspaces/task-pr12",
    status: "ready",
    lockMode: "exclusive",
    cleanupPolicy: "manual",
    lockedByRunId: null,
    cleanupAfter: null,
    lastVerifiedAt: null,
    errorMessage: null,
    createdAt: "2026-05-09T00:00:00.000Z",
    updatedAt: "2026-05-09T00:00:00.000Z"
  }],
  verificationResult: { test: "pass" },
  reviewFollowup: [],
  reviewIntents: []
};

const indexHealth: ProjectIndexHealthView = {
  projectId: "project-1",
  lastScanAt: "2026-05-09T00:00:00.000Z",
  documentCount: 1,
  taskCount: 1,
  requirementCount: 1,
  parseFailureCount: 0,
  freshness: true
};

let pendingInteractions: unknown[] = [];
let consultRecords: unknown[] = [];

describe("Task detail v2 cutover acceptance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    window.history.pushState({}, "", "/");
    MockEventSource.instances = [];
    pendingInteractions = [];
    consultRecords = [{ round: "R1", layer: "technical_design", input_summary: "Claude asks for design review.", codex_reply: { recommendation: "Proceed with v2 cutover." }, stop_reason: "done", timestamp: "2026-05-09T00:00:00.000Z" }];
    vi.stubGlobal("EventSource", MockEventSource);
    vi.stubGlobal("fetch", vi.fn(handleFetch));
    mockConsoleApi();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the task board on /tasks and opens detail through route navigation", async () => {
    await renderBoard("/tasks");
    expect(screen.queryByTestId("task-detail-page")).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "任务详情" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("PR12 cutover task"));

    await waitFor(() => expect(window.location.pathname).toBe("/tasks/task-1"));
    expect(await screen.findByTestId("task-detail-full-page")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "返回看板" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "任务详情" })).not.toBeInTheDocument();
  });

  it("AC-1 renders the v2 task detail shell on the main task route", async () => {
    await renderTask("/tasks/task-1");
    expect(screen.getByTestId("task-detail-full-page")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "返回看板" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "任务详情" })).not.toBeInTheDocument();
    expect(screen.getAllByText("PR12 cutover task").length).toBeGreaterThan(0);
    expect(screen.getByTestId("task-detail-page")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "待处理事项" })).toBeInTheDocument();
    const rail = screen.getByRole("navigation", { name: "任务节点" });
    for (const name of [
      "requirement_analysis · 已完成",
      "technical_design · 已完成",
      "task_breakdown · 已完成",
      "待派工 · 已完成",
      "执行中 · 进行中",
      "待评审 · 未开始",
      "已完成 · 未开始"
    ]) {
      expect(within(rail).getByRole("button", { name })).toBeInTheDocument();
    }
    expect(screen.getByRole("region", { name: "执行中 详情" })).toBeInTheDocument();
  });

  it("hides node action controls when node-flow actions are system only", async () => {
    await renderTask("/tasks/task-1");

    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/tasks/task-1/node-flow"));
    expect(screen.queryByRole("region", { name: "可执行动作" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /进入评审/ })).not.toBeInTheDocument();
  });

  it("AC-2 renders pending interaction CTA in the action hero", async () => {
    pendingInteractions = [{ id: "pending-1", kind: "approval", source_table: "pending_interactions", node_id: "implementation", summary: "Claude needs approval before review.", cta_label: "Approve", cta_action: "approve", created_at: "2026-05-09T00:00:00.000Z", raw_ref: "pending-1" }];
    await renderTask("/tasks/task-1");
    expect(screen.getByRole("region", { name: "待处理事项" })).toHaveTextContent("Claude needs approval before review.");
    expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();
  });

  it("AC-3 switches nodes quickly and syncs the node query parameter", async () => {
    await renderTask("/tasks/task-1");
    const start = performance.now();
    fireEvent.click(screen.getByRole("button", { name: /待评审/ }));
    await waitFor(() => expect(window.location.search).toContain("node=review"));
    expect(performance.now() - start).toBeLessThan(200);
    expect(screen.getByRole("region", { name: "待评审 详情" })).toBeInTheDocument();
  });

  it("AC-4 submits a consult request and shows the pending bubbles", async () => {
    await renderTask("/tasks/task-1?node=technical_design");
    fireEvent.change(screen.getByLabelText("Consult message"), { target: { value: "Need design review" } });
    fireEvent.click(screen.getByRole("button", { name: "Send consult" }));
    await screen.findByText("Need design review");
    expect(screen.getByText("等待 Codex 响应...")).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith("/api/tasks/task-1/nodes/technical_design/consult-requests", expect.objectContaining({ method: "POST" }));
  });

  it("AC-5 shares a single SSE connection and refreshes the selected node timeline", async () => {
    await renderTask("/tasks/task-1");
    expect(MockEventSource.instances.filter((instance) => instance.close.mock.calls.length === 0)).toHaveLength(1);
    const start = performance.now();
    MockEventSource.instances.find((instance) => instance.close.mock.calls.length === 0)?.msg({ event_id: "event-1", event_type: "codex_receipt_ready", emitted_at: "2026-05-09T00:00:01.000Z", payload: { node_id: "implementation" } });
    await screen.findByText("Codex 回执就绪");
    expect(performance.now() - start).toBeLessThan(1000);
  });

  it("AC-6 opens checkpoint list and drawer with transition state JSON", async () => {
    await renderTask("/tasks/task-1");
    // v4：点击 status strip 上的「查看检查点」chip 打开抽屉
    const openCheckpointsButton = await screen.findByRole("button", { name: "查看检查点" });
    fireEvent.click(openCheckpointsButton);
    // 找到具体 checkpoint item（aria-label 含 transitionId）
    const checkpointButton = await screen.findByRole("button", {
      name: /requirement_analysis__approved/
    });
    fireEvent.click(checkpointButton);
    expect(await screen.findByRole("dialog", { name: "检查点详情" })).toHaveAttribute("aria-modal", "true");
    expect(screen.getByText(/currentNode/)).toBeInTheDocument();
  });

  it("AC-7 keeps task detail v2 and task page styling on tokens instead of hard-coded hex colors", () => {
    const files = listFiles(join(process.cwd(), "src/components/task-detail-v2"));
    const matches = files.flatMap((file) => {
      const content = readFileSync(file, "utf8");
      return /#[0-9a-fA-F]{6}/.test(content) ? [file] : [];
    });
    expect(matches).toEqual([]);
  });

  it("AC-8 removes dead old detail routes and components from src references", () => {
    const patterns = ["TaskDetail" + "Panel", "Consultation" + "Tab", "NodeFlow" + "Tab", "tasks-v2" + "-demo"];
    const files = listFiles(join(process.cwd(), "src"));
    const matches = files.flatMap((file) => {
      const content = readFileSync(file, "utf8");
      return patterns.some((pattern) => content.includes(pattern)) ? [file] : [];
    });
    expect(matches).toEqual([]);
  });

  it("redirects legacy tab URLs to the selected node query", async () => {
    await renderTask("/tasks/task-1?tab=consultation");
    await waitFor(() => {
      expect(window.location.search).toBe("?node=implementation");
    });
  });

  it("shows slot guidance on task detail without legacy anchor terminal controls", async () => {
    await renderTask("/tasks/task-1");

    expect(await screen.findByText("slot-3 已绑定")).toBeInTheDocument();
    expect(screen.getByText("终端请在 ccb 原生 sidebar 查看 slot 窗口")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "打开 Slots" })).toHaveAttribute("href", "/slots");
    expect(screen.queryByText("Anchor 终端")).not.toBeInTheDocument();
    expect(screen.queryByText("启动 Anchor")).not.toBeInTheDocument();
    expect(screen.queryByText("重置 anchor")).not.toBeInTheDocument();
  });
});

async function renderTask(route: string): Promise<void> {
  window.history.pushState({}, "", route);
  render(<App />);
  await screen.findByTestId("task-detail-full-page");
  await screen.findByTestId("task-detail-page");
}

async function renderBoard(route: string): Promise<void> {
  window.history.pushState({}, "", route);
  render(<App />);
  await screen.findByText("PR12 cutover task");
}

function mockConsoleApi(): void {
  vi.mocked(consoleApi.fetchProjects).mockResolvedValue([project]);
  vi.mocked(consoleApi.fetchDocuments).mockResolvedValue([]);
  vi.mocked(consoleApi.fetchTasks).mockResolvedValue([task]);
  vi.mocked(consoleApi.fetchRequirements).mockResolvedValue([{ id: "req-1", projectId: "project-1", title: "PR12 requirement", description: "", status: "delivering", source: "manual", outputMode: "requirement_only", generatedTaskId: "task-1", verbatimSource: "Cut over to task detail v2.", claudeInterpretation: null, ambiguities: null, fidelityDiff: null, analysisInputHash: null, analysisStaleAt: null, createdAt: "2026-05-09T00:00:00.000Z", updatedAt: "2026-05-09T00:00:00.000Z" } satisfies RequirementView]);
  vi.mocked(consoleApi.fetchSyncJobs).mockResolvedValue([] satisfies SyncJobView[]);
  vi.mocked(consoleApi.fetchProjectIndexHealth).mockResolvedValue(indexHealth);
  vi.mocked(consoleApi.fetchSlots).mockResolvedValue({
    project: { id: "project-1", name: "PR12 Fixture" },
    main: { slotId: "main", lane: "coordination", state: "available", canBindBusiness: false },
    slots: [
      {
        slotId: "slot-3",
        state: "bound",
        requirement: { id: "req-1", title: "PR12 requirement" },
        boundAt: "2026-05-24T00:00:00.000Z",
        busySince: null,
        lastActivityAt: "2026-05-24T00:01:00.000Z",
        stale: null,
        unhealthy: null,
        queued: []
      }
    ],
    queue: [],
    generatedAt: "2026-05-24T00:02:00.000Z"
  });
  vi.mocked(consoleApi.fetchTaskDetail).mockResolvedValue(detail);
  vi.mocked(consoleApi.updateTask).mockResolvedValue(task);
  vi.mocked(consoleApi.createTaskWorkspace).mockResolvedValue(detail.workspaces[0]);
  vi.mocked(consoleApi.cleanupTaskWorkspace).mockResolvedValue({ ...detail.workspaces[0], status: "cleaned" });
  vi.mocked(consoleApi.createReviewIntent).mockResolvedValue({
    id: "intent-1",
    projectId: "project-1",
    taskId: "task-1",
    taskKey: "task-pr12",
    intentType: "request_replan",
    payload: null,
    status: "pending",
    actor: null,
    consumedAt: null,
    consumedBy: null,
    createdAt: "2026-05-09T00:00:00.000Z",
    updatedAt: "2026-05-09T00:00:00.000Z"
  });
  vi.mocked(consoleApi.cancelReviewIntent).mockResolvedValue({
    id: "intent-1",
    projectId: "project-1",
    taskId: "task-1",
    taskKey: "task-pr12",
    intentType: "request_replan",
    payload: null,
    status: "cancelled",
    actor: null,
    consumedAt: null,
    consumedBy: null,
    createdAt: "2026-05-09T00:00:00.000Z",
    updatedAt: "2026-05-09T00:00:00.000Z"
  });
}

async function handleFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const path = typeof input === "string" ? input : input.toString();
  const url = new URL(path, "http://localhost");
  if (url.pathname === "/api/tasks/task-1/pending-interactions") return json({ pending: pendingInteractions });
  if (url.pathname === "/api/tasks/task-1/consult-records") return json({ task_id: "task-1", consult_records: consultRecords, count: consultRecords.length });
  if (url.pathname === "/api/tasks/task-1/event-view") return json({ taskId: "task-1", events: [], hasMore: false });
  if (url.pathname === "/api/tasks/task-1/node-flow") {
    return json({
      currentNode: "implementation",
      nodeSubstate: "executing",
      runtimeState: "running",
      lastTransitionId: "dispatch__on_codex_pickup__to__implementation",
      lastTransitionAt: "2026-05-09T00:00:00.000Z",
      transitions: [],
      applicable_actions: [
        {
          transition_id: "implementation__on_receipt_ready__to__review",
          label: "进入评审",
          guard_status: "satisfied",
          guard_reason: "codex_receipt_ready event available",
          applicability: "system_only"
        },
        {
          transition_id: "implementation__codex_blocked__to__terminal",
          label: "执行阻塞升级",
          guard_status: "blocked",
          guard_reason: "codex_blocked signal missing",
          applicability: "system_only"
        }
      ]
    });
  }
  if (url.pathname === "/api/tasks/task-1/checkpoints") {
    return json([
      { id: "cp-1", taskId: "task-1", taskKey: "task-pr12", transitionId: "requirement_analysis__approved", nodeBefore: null, nodeAfter: "requirement_analysis", stateRevisionAfter: 2, stateHash: "abcdef1234567890", snapshotPath: null, createdAt: "2026-05-09T00:00:00.000Z" },
      { id: "cp-2", taskId: "task-1", taskKey: "task-pr12", transitionId: "technical_design__approved", nodeBefore: "requirement_analysis", nodeAfter: "technical_design", stateRevisionAfter: 3, stateHash: "1234567890abcdef", snapshotPath: null, createdAt: "2026-05-09T00:00:01.000Z" }
    ]);
  }
  if (url.pathname === "/api/tasks/task-1/checkpoints/requirement_analysis__approved") {
    return json({ id: "cp-1", taskId: "task-1", taskKey: "task-pr12", transitionId: "requirement_analysis__approved", nodeBefore: null, nodeAfter: "需求分析", stateRevisionAfter: 2, stateHash: "abcdef1234567890", snapshotPath: null, createdAt: "2026-05-09T00:00:00.000Z", snapshot: { currentNode: "technical_design" } });
  }
  if (url.pathname === "/api/tasks/task-1/nodes/technical_design/consult-requests" && init?.method === "POST") {
    return json({ request: { id: "consult-1", task_id: "task-1", task_key: "task-pr12", node_id: "technical_design", message: "Need design review", target_agent: "ccb_codex", status: "pending", consult_round: null, created_by: "operator", created_at: "2026-05-09T00:00:00.000Z", consumed_at: null } });
  }
  if (url.pathname === "/api/ai-cli/tools") return json({ items: [] });
  if (url.pathname === "/api/ai-cli/sessions") return json({ items: [] });
  return json({});
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

function listFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? listFiles(path) : [path];
  });
}
