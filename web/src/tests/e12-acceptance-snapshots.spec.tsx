import { fireEvent, prettyDOM, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DocumentDetailView, DocumentView } from "../types/document.js";
import type { ProjectIndexHealthView, ProjectView } from "../types/project.js";
import type { RequirementView } from "../types/requirement.js";
import type { ProjectSettingsView } from "../types/settings.js";
import type { SyncJobView } from "../types/sync-job.js";
import type { TaskDetailView, TaskTimelineView, TaskView } from "../types/task.js";

vi.mock("../lib/console-api.js", () => ({
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
    projectId: "project-e12",
    localPath: "/tmp/su-ccb/e12-fixture",
    ccbRuntimeReady: true,
    knowledgeBaseReady: true,
    ccbConfigPath: "/tmp/su-ccb/e12-fixture/.ccb/ccb.config",
    knowledgeBaseRootPath: "/tmp/su-ccb/e12-fixture/docs/.ccb/index",
    manualCommand: "cd /tmp/su-ccb/e12-fixture && ccb",
    checkedAt: "2026-05-20T00:00:00.000Z"
  }),
  initProjectKnowledgeBase: vi.fn(),
  fetchProjectInitJobStatus: vi.fn(),
  fetchProjectSettings: vi.fn(),
  updateProjectSettings: vi.fn(),
  fetchDocuments: vi.fn(),
  fetchDocumentDetail: vi.fn(),
  fetchTasks: vi.fn(),
  fetchTaskDetail: vi.fn(),
  fetchTaskTimeline: vi.fn(),
  fetchEventJournalEvents: vi.fn().mockResolvedValue({ items: [], pageInfo: { limit: 20, offset: 0, count: 0 } }),
  updateTask: vi.fn(),
  fetchRequirements: vi.fn(),
  reindexRequirement: vi.fn().mockResolvedValue({ reindexed: true, deduped: false, status: "success", issues: [] }),
  fetchSyncJobs: vi.fn(),
  createRequirement: vi.fn(),
  uploadRequirementAsset: vi.fn(),
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

import App from "../App.js";
import * as consoleApi from "../lib/console-api.js";

class MockEventSource extends EventTarget {
  static instances: MockEventSource[] = [];
  close = vi.fn();
  constructor(public url: string) { super(); MockEventSource.instances.push(this); }
  msg(data: unknown) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(data) })); }
  projection(data: unknown) { this.dispatchEvent(new MessageEvent("projection", { data: JSON.stringify(data) })); }
}

const fixedNow = new Date("2026-05-04T12:00:00.000");
const projectId = "project-e12";
const taskId = "task-impl";
const projectRoot = "/tmp/su-ccb/e12-fixture";

const project: ProjectView = {
  id: projectId,
  name: "E12 Acceptance Fixture",
  localPath: projectRoot,
  summary: "Console v2 acceptance fixture.",
  initStatus: "initialized",
  syncStatus: "idle",
  lastScanAt: "2026-05-04T10:00:00.000"
};

const documents: DocumentView[] = [
  {
    id: "doc-spec",
    projectId,
    taskKey: "e12-fixture-implementation",
    path: "docs/03_开发计划/e12-fixture-implementation-开发任务.md",
    kind: "dev_task",
    title: "E12 fixture implementation task",
    status: "reviewing",
    summary: "Acceptance spec for Node Flow and Consultation tabs.",
    parseStatus: "success",
    mtime: "2026-05-04T09:00:00.000",
    updatedAt: "2026-05-04T09:00:00.000",
    governance: { tier: "生效中", requirementId: null, entityStatus: "reviewing", taskId: "e12-fixture-implementation", healthFlags: { parseError: false } }
  },
  {
    id: "doc-state",
    projectId,
    taskKey: "e12-fixture-implementation",
    path: "docs/.ccb/state/e12-fixture-implementation.md",
    kind: "state",
    title: "E12 fixture implementation state",
    status: "running",
    summary: "State projection for the fixture task.",
    parseStatus: "success",
    mtime: "2026-05-04T10:00:00.000",
    updatedAt: "2026-05-04T10:00:00.000",
    governance: { tier: "生效中", requirementId: null, entityStatus: null, taskId: null, healthFlags: { parseError: false } }
  }
];

const documentDetail: DocumentDetailView = {
  ...documents[0],
  frontmatter: {
    task_id: "e12-fixture-implementation",
    currentNode: "implementation",
    runtimeState: "running"
  },
  content:
    "---\n" +
    "task_id: e12-fixture-implementation\n" +
    "currentNode: implementation\n" +
    "runtimeState: running\n" +
    "---\n" +
    "# E12 fixture implementation\n\n" +
    "This fixture keeps Node Flow and Consultation acceptance deterministic.\n"
};

const tasks: TaskView[] = [
  createTask({
    id: "task-ra",
    taskKey: "e12-fixture-requirement",
    title: "Requirement analysis acceptance",
    currentNode: "requirement_analysis",
    nodeSubstate: "consult",
    progress: 20,
    updatedAt: "2026-05-04T08:00:00.000"
  }),
  createTask({
    id: "task-design",
    taskKey: "e12-fixture-design",
    title: "Technical design acceptance",
    currentNode: "technical_design",
    nodeSubstate: "drafting",
    progress: 40,
    updatedAt: "2026-05-04T09:00:00.000"
  }),
  createTask({
    id: taskId,
    taskKey: "e12-fixture-implementation",
    title: "Implementation acceptance",
    currentNode: "implementation",
    nodeSubstate: "receipt_ready",
    progress: 70,
    updatedAt: "2026-05-04T10:00:00.000"
  }),
  createTask({
    id: "task-review",
    taskKey: "e12-fixture-review",
    title: "Review fallback acceptance",
    currentNode: "review",
    nodeSubstate: "blocked",
    runtimeState: "blocked",
    status: "reviewing",
    priority: "high",
    progress: 80,
    blockedReason: "capability fallback requires review",
    reviewStatus: "needs_followup",
    updatedAt: "2026-05-04T10:20:00.000"
  }),
  createTask({
    id: "task-archive",
    taskKey: "e12-fixture-archive",
    title: "Archive acceptance",
    currentNode: "archive",
    nodeSubstate: "done",
    runtimeState: "completed",
    status: "done",
    progress: 100,
    reviewStatus: "passed",
    updatedAt: "2026-05-04T10:30:00.000"
  })
];

const taskDetail: TaskDetailView = {
  ...tasks[2],
  linkedRequirement: {
    id: "req-e12",
    title: "Console v2 trace acceptance",
    verbatimSource: "Show node movement, consultation rounds, and fallback decisions."
  },
  linkedDocuments: [
    {
      id: "doc-state",
      path: "docs/.ccb/state/e12-fixture-implementation.md",
      kind: "state",
      title: "E12 fixture implementation state",
      status: "running"
    },
    {
      id: "doc-receipt",
      path: "docs/.ccb/receipts/e12-fixture-implementation.md",
      kind: "receipt",
      title: "E12 fixture receipt",
      status: "ready"
    }
  ],
  workspaces: [
    {
      id: "workspace-e12",
      projectId,
      taskId,
      taskKey: "e12-fixture-implementation",
      baseRef: "HEAD",
      branchName: "task/e12-fixture-implementation",
      workspacePath: "/tmp/su-ccb/e12-fixture/.workspaces/e12-fixture-implementation",
      status: "ready",
      lockMode: "exclusive",
      cleanupPolicy: "manual",
      lockedByRunId: null,
      cleanupAfter: null,
      lastVerifiedAt: null,
      errorMessage: null,
      createdAt: "2026-05-04T09:45:00.000",
      updatedAt: "2026-05-04T09:45:00.000"
    }
  ],
  verificationResult: {
    build: "pass",
    test: "pass"
  },
  reviewFollowup: ["Keep Node Flow apply behind confirmation."],
  reviewIntents: [
    {
      id: "intent-e12",
      projectId,
      taskId,
      taskKey: "e12-fixture-implementation",
      intentType: "request_replan",
      payload: "Review fallback path before archive.",
      status: "pending",
      actor: null,
      consumedAt: null,
      consumedBy: null,
      createdAt: "2026-05-04T10:05:00.000",
      updatedAt: "2026-05-04T10:05:00.000"
    }
  ]
};

const taskTimeline: TaskTimelineView = {
  taskId,
  events: [
    {
      kind: "event_projection",
      at: "2026-05-04T10:30:00.000",
      label: "Event projection: codex_receipt_ready",
      details: {
        eventId: "event-codex-ready",
        eventType: "codex_receipt_ready"
      }
    },
    {
      kind: "transition",
      at: "2026-05-04T10:20:00.000",
      label: "Transition applied: implementation to review",
      details: {
        transition_id: "implementation__on_receipt_ready__to__review"
      }
    },
    {
      kind: "intent_create",
      at: "2026-05-04T10:05:00.000",
      label: "Review intent created: request_replan",
      details: {
        status: "pending"
      }
    }
  ]
};

const requirements: RequirementView[] = [
  {
    id: "req-e12",
    projectId,
    title: "Console v2 trace acceptance",
    description: "Render node flow, consultation trace, metrics, and recent activity in one deterministic fixture.",
    status: "delivering",
    source: "manual",
    outputMode: "requirement_only",
    generatedTaskId: taskId,
    verbatimSource: "Show node movement, consultation rounds, and fallback decisions.",
    claudeInterpretation: "The operator needs one console surface for currentNode and capability fallback evidence.",
    ambiguities: "No mobile viewport in v0.4 v1.",
    fidelityDiff: "Testing-library DOM snapshot replaces Playwright image baseline.",
    analysisInputHash: null,
    analysisStaleAt: null,
    createdAt: "2026-05-04T08:30:00.000",
    updatedAt: "2026-05-04T08:30:00.000"
  }
];

const syncJobs: SyncJobView[] = [
  {
    id: "sync-success",
    projectId,
    jobType: "scan",
    status: "success",
    processedCount: 4,
    totalCount: 4,
    startedAt: "2026-05-04T09:00:00.000",
    finishedAt: "2026-05-04T09:01:00.000",
    logSummary: "Indexed E12 acceptance fixture",
    errorMessage: null,
    updatedAt: "2026-05-04T09:01:00.000"
  },
  {
    id: "sync-failed",
    projectId,
    jobType: "generate",
    status: "failed",
    processedCount: 0,
    totalCount: 0,
    startedAt: "2026-05-04T09:30:00.000",
    finishedAt: "2026-05-04T09:31:00.000",
    logSummary: "Fixture generation warning",
    errorMessage: "Fallback event requires review",
    updatedAt: "2026-05-04T09:31:00.000"
  }
];

const indexHealth: ProjectIndexHealthView = {
  projectId,
  lastScanAt: "2026-05-04T10:00:00.000",
  documentCount: documents.length,
  taskCount: tasks.length,
  requirementCount: requirements.length,
  parseFailureCount: 0,
  freshness: true
};

const settings: ProjectSettingsView = {
  project_id: projectId,
  updated_at: "2026-05-04T10:00:00.000",
  scan_strategy: {
    enabled: true,
    paths: ["docs"],
    exclude_patterns: ["node_modules", ".git"]
  },
  parsing_rules: {
    strict_frontmatter: true,
    allowed_categories: ["01", "02", "03", "04", "05"]
  },
  path_config: {
    docs_root: "docs",
    kernel_ref: "references/kernel"
  }
};

describe("E12 acceptance DOM baselines", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(fixedNow);
    vi.clearAllMocks();
    window.localStorage.clear();
    window.history.pushState({}, "", "/");
    MockEventSource.instances = [];
    mockConsoleApi();
    vi.stubGlobal("EventSource", MockEventSource);
    vi.stubGlobal("fetch", vi.fn(handleFetch));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("captures overview page baseline", async () => {
    const container = await renderRoute("/overview", "活跃需求");

    expect(screen.getByText("需关注")).toBeInTheDocument();
    expect(screen.getByText("已交付")).toBeInTheDocument();
    expect(screen.getByText("任务与文档")).toBeInTheDocument();
    expect(screen.getByText("系统健康")).toBeInTheDocument();
    expectMainSnapshot(container);
  });

  it("captures tasks board page baseline", async () => {
    const container = await renderRoute("/tasks", /Requirement analysis acceptance/);

    expect(screen.getByText("待派工")).toBeInTheDocument();
    expect(screen.getByText("执行中")).toBeInTheDocument();
    expectMainSnapshot(container);
  });

  it("captures requirements page baseline", async () => {
    // 该用例局部覆盖 status=planning 归"推进中"列；全局 fixture 保持 delivering，避免影响任务看板的计划中需求条。
    // 看板下所有列同时可见，无需再点 tab。
    vi.mocked(consoleApi.fetchRequirements).mockResolvedValue([{ ...requirements[0], status: "planning" }]);
    const container = await renderRoute("/requirements", /Console v2 trace acceptance/);
    await screen.findByText("Console v2 trace acceptance");
    expect(screen.getByText("已分析")).toBeInTheDocument();
    expectMainSnapshot(container);
  });

  it("captures runs page baseline", async () => {
    const container = await renderRoute("/runs", /Fixture generation warning/);

    expect(screen.getByText("最近失败记录")).toBeInTheDocument();
    expectMainSnapshot(container);
  });

  it("captures documents page baseline", async () => {
    // 文档目录组默认折叠（PR4 三栏重写后行为）：默认视图只渲染目录组头，文档标题需展开目录才出现。
    // 先等默认可见的目录组头就绪，再展开该组，验证文档项渲染并纳入基线快照。
    const container = await renderRoute("/documents", /docs\/03_开发计划/);
    fireEvent.click(screen.getByRole("button", { name: /docs\/03_开发计划/ }));

    expect(await screen.findByText("E12 fixture implementation task")).toBeInTheDocument();
    expect(screen.getByText("选择文档后查看内容")).toBeInTheDocument();
    expectMainSnapshot(container);
  });

  it("captures AI CLI page baseline", async () => {
    const container = await renderRoute("/ai-cli", /Claude Code/);

    expect(screen.getAllByText("外部窗口").length).toBeGreaterThan(0);
    expectMainSnapshot(container);
  });

  it("captures recording play page baseline", async () => {
    const container = await renderRoute("/ai-cli/recordings/recording-e12", /会话回放/);

    await screen.findByText(/codex .*\/tmp\/su-ccb\/e12-fixture/);
    expectMainSnapshot(container);
  });

  it("captures settings page baseline", async () => {
    const container = await renderRoute("/settings", /scan_strategy/);

    expect(screen.getByDisplayValue("references/kernel")).toBeInTheDocument();
    expectMainSnapshot(container);
  });

  it("captures task detail v2 default node baseline", async () => {
    const container = await renderRoute(`/tasks/${taskId}`, /工作区/);

    expect(screen.getByTestId("task-detail-page")).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "任务节点" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "执行中 详情" })).toBeInTheDocument();
    expectMainSnapshot(container);
  });

  it("captures task detail v2 legacy tab redirect baseline", async () => {
    const container = await renderRoute(`/tasks/${taskId}?tab=node-flow`, /工作区/);

    await waitFor(() => {
      expect(window.location.search).toBe("?node=implementation");
    });
    expect(screen.getByRole("region", { name: "执行中 详情" })).toBeInTheDocument();
    expectMainSnapshot(container);
  });

  it("captures task detail v2 consultation node baseline", async () => {
    const container = await renderRoute(`/tasks/${taskId}?node=technical_design`, /e12_acceptance_round_1/);

    await screen.findByText("e12_acceptance_round_1");
    await screen.findByText("analysis.deep_design");
    expect(screen.getByRole("region", { name: "technical_design 详情" })).toBeInTheDocument();
    expectMainSnapshot(container);
  });
});

async function renderRoute(route: string, readyText: RegExp | string): Promise<HTMLElement> {
  window.history.pushState({}, "", route);
  const { container } = render(<App />);
  await waitFor(() => {
    expect(screen.queryAllByText(readyText).length).toBeGreaterThan(0);
  });
  await waitFor(() => {
    expect(consoleApi.fetchProjects).toHaveBeenCalled();
  });
  return container;
}

function expectMainSnapshot(container: HTMLElement): void {
  const main = container.querySelector('[data-layout-region="main"]');
  const rawSnapshot = prettyDOM(main ?? container, 200_000, { highlight: false });
  const snapshot = (typeof rawSnapshot === "string" ? rawSnapshot : "")
    .split("\n")
    .map((line: string) => line.trimEnd())
    .join("\n");
  expect(snapshot).toMatchSnapshot();
}

function mockConsoleApi(): void {
  vi.mocked(consoleApi.fetchProjects).mockResolvedValue([project]);
  vi.mocked(consoleApi.createProject).mockResolvedValue(project);
  vi.mocked(consoleApi.scanProject).mockResolvedValue();
  vi.mocked(consoleApi.fetchProjectScanStatus).mockResolvedValue({
    projectId,
    projectSyncStatus: "idle",
    status: "success",
    processedCount: 4,
    totalCount: 4,
    errorMessage: null,
    jobId: "sync-success",
    updatedAt: "2026-05-04T09:01:00.000",
    phase: null,
    phaseStatus: null,
    phaseJobId: null,
    phaseErrorMessage: null
  });
  vi.mocked(consoleApi.fetchProjectIndexHealth).mockResolvedValue(indexHealth);
  vi.mocked(consoleApi.fetchProjectSettings).mockResolvedValue(settings);
  vi.mocked(consoleApi.updateProjectSettings).mockResolvedValue(settings);
  vi.mocked(consoleApi.fetchDocuments).mockResolvedValue(documents);
  vi.mocked(consoleApi.fetchDocumentDetail).mockResolvedValue(documentDetail);
  vi.mocked(consoleApi.fetchTasks).mockResolvedValue(tasks);
  vi.mocked(consoleApi.fetchTaskDetail).mockResolvedValue(taskDetail);
  vi.mocked(consoleApi.fetchTaskTimeline).mockResolvedValue(taskTimeline);
  vi.mocked(consoleApi.updateTask).mockResolvedValue(tasks[2]);
  vi.mocked(consoleApi.fetchRequirements).mockResolvedValue(requirements);
  vi.mocked(consoleApi.fetchSyncJobs).mockResolvedValue(syncJobs);
  vi.mocked(consoleApi.createRequirement).mockResolvedValue(requirements[0]);
  vi.mocked(consoleApi.createTaskWorkspace).mockResolvedValue(taskDetail.workspaces[0]);
  vi.mocked(consoleApi.cleanupTaskWorkspace).mockResolvedValue({
    ...taskDetail.workspaces[0],
    status: "cleaned"
  });
  vi.mocked(consoleApi.createReviewIntent).mockResolvedValue(taskDetail.reviewIntents[0]);
  vi.mocked(consoleApi.cancelReviewIntent).mockResolvedValue({
    ...taskDetail.reviewIntents[0],
    status: "cancelled"
  });
}

async function handleFetch(input: RequestInfo | URL): Promise<Response> {
  const path = typeof input === "string" ? input : input.toString();
  const url = new URL(path, "http://localhost");
  const pathname = url.pathname;

  if (pathname === "/api/activity/recent") {
    return jsonResponse({
      events: [
        {
          event_id: "activity-codex-ready",
          event_type: "codex_receipt_ready",
          task_id: taskId,
          project_id: projectId,
          at: "2026-05-04T11:30:00.000",
          payload: {
            provider: "codex"
          }
        },
        {
          event_id: "activity-transition",
          event_type: "transition.applied",
          task_id: taskId,
          project_id: projectId,
          at: "2026-05-04T11:20:00.000",
          payload: {
            source: "implementation",
            target: "review"
          }
        },
        {
          event_id: "activity-fallback",
          event_type: "capability.fallback",
          task_id: "task-review",
          project_id: projectId,
          at: "2026-05-04T11:10:00.000",
          payload: {
            cap_id: "analysis.deep_design",
            provider: "claude_native_design"
          }
        },
        {
          event_id: "activity-missing",
          event_type: "capability.missing",
          task_id: "task-review",
          project_id: projectId,
          at: "2026-05-04T11:00:00.000",
          payload: {
            cap_id: "gate.user_decision"
          }
        },
        {
          event_id: "activity-info",
          event_type: "fixture.note",
          project_id: projectId,
          at: "2026-05-04T10:50:00.000",
          summary: "Fixture seed completed",
          payload: {}
        }
      ]
    });
  }

  if (pathname === `/api/tasks/${taskId}/node-flow`) {
    return jsonResponse({
      currentNode: "implementation",
      nodeSubstate: "receipt_ready",
      runtimeState: "running",
      lastTransitionId: "dispatch__on_codex_pickup__to__implementation",
      lastTransitionAt: "2026-05-04T10:20:00.000",
      transitions: [
        {
          transition_id: "requirement_analysis__approved__to__technical_design",
          source_node: "requirement_analysis",
          target_node: "technical_design",
          verdict: "pass",
          at: "2026-05-04T08:40:00.000",
          evidence_ref: "event-ra-design"
        },
        {
          transition_id: "technical_design__approved__to__task_breakdown",
          source_node: "technical_design",
          target_node: "task_breakdown",
          verdict: "pass",
          at: "2026-05-04T09:10:00.000",
          evidence_ref: "event-design-breakdown"
        },
        {
          transition_id: "dispatch__on_codex_pickup__to__implementation",
          source_node: "dispatch",
          target_node: "implementation",
          verdict: "pass",
          at: "2026-05-04T10:20:00.000",
          evidence_ref: "event-dispatch-impl"
        }
      ],
      applicable_actions: [
        {
          transition_id: "implementation__on_receipt_ready__to__review",
          label: "Apply implementation receipt",
          guard_status: "satisfied",
          guard_reason: "codex_receipt_ready event available",
          applicability: "system_only"
        },
        {
          transition_id: "implementation__on_blocked__stay",
          label: "Mark blocked",
          guard_status: "blocked",
          guard_reason: "blocked_reason is empty",
          applicability: "system_only"
        }
      ]
    });
  }

  if (pathname === `/api/tasks/${taskId}/event-view`) {
    return jsonResponse({ taskId, events: [], hasMore: false });
  }

  if (pathname === `/api/tasks/${taskId}/consultation`) {
    return jsonResponse({
      rounds: [1, 2, 3].map((roundNumber) => ({
        round_number: roundNumber,
        node_id: "technical_design",
        events: [
          {
            event_id: `consult-claude-${roundNumber}`,
            sender: "claude",
            receiver: "codex",
            intent: `e12_acceptance_round_${roundNumber}`,
            intent_score: 8 + roundNumber / 10,
            tokens_in: 2000 + roundNumber,
            tokens_out: 400 + roundNumber,
            at: `2026-05-04T02:0${roundNumber}:00.000Z`,
            payload_preview: `Round ${roundNumber} asks Codex to verify trace evidence.`
          },
          {
            event_id: `consult-codex-${roundNumber}`,
            sender: "codex",
            receiver: "claude",
            intent: `e12_acceptance_reply_${roundNumber}`,
            intent_score: 8.5 + roundNumber / 10,
            tokens_in: 1500 + roundNumber,
            tokens_out: 350 + roundNumber,
            at: `2026-05-04T02:1${roundNumber}:00.000Z`,
            payload_preview: `Round ${roundNumber} reply includes fixture proof.`
          }
        ]
      }))
    });
  }

  if (pathname === `/api/tasks/${taskId}/pending-interactions`) {
    return jsonResponse({ pending: [] });
  }

  if (pathname === `/api/tasks/${taskId}/consult-records`) {
    return jsonResponse({
      task_id: taskId,
      consult_records: [
        {
          round: "R1",
          layer: "technical_design",
          input_summary: "e12_acceptance_round_1",
          codex_reply: { recommendation: "analysis.deep_design" },
          stop_reason: "done",
          timestamp: "2026-05-04T10:40:00.000Z"
        }
      ],
      count: 1
    });
  }

  if (pathname === `/api/tasks/${taskId}/checkpoints`) {
    return jsonResponse([]);
  }

  if (pathname === "/api/capabilities/status") {
    return jsonResponse({
      version: "cap-matrix-v0.1",
      capabilities: [
        {
          name: "analysis.deep_design",
          binding_source: "global",
          status: "active",
          last_used_at: "2026-05-04T11:10:00.000"
        },
        {
          name: "quality.verification",
          binding_source: "global",
          status: "active",
          last_used_at: "2026-05-04T11:15:00.000"
        },
        {
          name: "gate.user_decision",
          binding_source: "global",
          status: "disabled",
          last_used_at: null
        }
      ]
    });
  }

  if (pathname === `/api/noderuns/${taskId}`) {
    return jsonResponse([
      {
        version: "noderun-v0.1",
        node_id: "implementation",
        entered_at: "2026-05-04T10:00:00.000",
        exited_at: null,
        transitions: [],
        capability_decisions: [
          {
            capability_requested: "analysis.deep_design",
            resolved_binding: "claude_native_design",
            decision_at: "2026-05-04T11:10:00.000",
            old_hint_fallback_count: 1
          },
          {
            capability_requested: "quality.verification",
            resolved_binding: "codex_verifier",
            decision_at: "2026-05-04T11:15:00.000",
            outcome: "resolved"
          },
          {
            capability_requested: "gate.user_decision",
            resolved_binding: null,
            decision_at: "2026-05-04T11:20:00.000"
          }
        ]
      }
    ]);
  }

  if (pathname === "/api/ai-cli/tools") {
    return jsonResponse({
      items: [
        {
          id: "claude",
          name: "Claude Code",
          command: "claude",
          resolvedPath: "/usr/local/bin/claude",
          available: true,
          args: [],
          defaultMode: "external",
          installHint: "Install Claude Code"
        },
        {
          id: "codex",
          name: "Codex CLI",
          command: "codex",
          resolvedPath: "/usr/local/bin/codex",
          available: true,
          args: ["--approval-policy=never"],
          defaultMode: "embedded",
          installHint: "Install Codex CLI"
        },
        {
          id: "gemini",
          name: "Gemini CLI",
          command: "gemini",
          resolvedPath: null,
          available: false,
          args: [],
          defaultMode: null,
          installHint: "Install Gemini CLI"
        }
      ]
    });
  }

  if (pathname === "/api/ai-cli/sessions") {
    return jsonResponse({
      items: [
        {
          id: "session-codex",
          toolId: "codex",
          command: "codex",
          args: [],
          cwd: projectRoot,
          cols: 100,
          rows: 30,
          projectId,
          createdAt: "2026-05-04T10:00:00.000",
          lastActiveAt: "2026-05-04T11:00:00.000",
          status: "running",
          exitCode: null,
          exitSignal: null,
          recordingId: "recording-e12",
          attachedSocketCount: 1
        }
      ]
    });
  }

  if (pathname === "/api/ai-cli/recordings") {
    return jsonResponse({
      items: [
        {
          id: "recording-e12",
          toolId: "codex",
          projectId,
          cwd: projectRoot,
          cols: 100,
          rows: 30,
          createdAt: "2026-05-04T10:00:00.000",
          finishedAt: null,
          byteSize: 2048
        }
      ]
    });
  }

  if (pathname === "/api/ai-cli/recordings/recording-e12") {
    return jsonResponse({
      meta: {
        id: "recording-e12",
        toolId: "codex",
        projectId,
        cwd: projectRoot,
        cols: 100,
        rows: 30,
        createdAt: "2026-05-04T10:00:00.000",
        finishedAt: null,
        byteSize: 2048
      },
      cast: '{"version":2,"width":100,"height":30}\n[0.1,"o","E12 fixture ready\\n"]'
    });
  }

  return jsonResponse({
    items: []
  });
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: {
      "Content-Type": "application/json"
    }
  });
}

function createTask(input: {
  id: string;
  taskKey: string;
  title: string;
  currentNode: string;
  nodeSubstate: string;
  runtimeState?: string;
  status?: string;
  priority?: string;
  progress: number;
  blockedReason?: string | null;
  reviewStatus?: string | null;
  updatedAt: string;
}): TaskView {
  return {
    id: input.id,
    projectId,
    taskKey: input.taskKey,
    title: input.title,
    summary: `${input.title} summary.`,
    status: input.status ?? "reviewing",
    phase: "legacy",
    currentNode: input.currentNode,
    nodeSubstate: input.nodeSubstate,
    runtimeState: input.runtimeState ?? "running",
    lastTransitionId: `${input.currentNode}__fixture_transition`,
    priority: input.priority ?? "medium",
    progress: input.progress,
    step: null,
    blockedReason: input.blockedReason ?? null,
    requirementId: "req-e12",
    reviewStatus: input.reviewStatus ?? null,
    semanticKind: null,
    updatedAt: input.updatedAt
  };
}
