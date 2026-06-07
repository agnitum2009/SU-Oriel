import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DocumentDetailView, DocumentView } from "../types/document.js";
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
    localPath: "/tmp/ccb-test",
    ccbRuntimeReady: true,
    knowledgeBaseReady: true,
    ccbConfigPath: "/tmp/ccb-test/.ccb/ccb.config",
    knowledgeBaseRootPath: "/tmp/ccb-test/docs/.ccb/index",
    manualCommand: "cd /tmp/ccb-test && ccb",
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
  fetchTaskMarkdown: vi.fn(),
  fetchTaskTimeline: vi.fn(),
  fetchEventJournalEvents: vi.fn().mockResolvedValue({ items: [], pageInfo: { limit: 20, offset: 0, count: 0 } }),
  updateTask: vi.fn(),
  fetchRequirements: vi.fn(),
  fetchSlots: vi.fn(),
  fetchTerminalDescriptor: vi.fn(),
  reindexRequirement: vi.fn().mockResolvedValue({ reindexed: true, deduped: false, status: "success", issues: [] }),
  fetchSyncJobs: vi.fn(),
  createRequirement: vi.fn(),
  uploadRequirementAsset: vi.fn(),
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

const TEST_PROJECT_ROOT = "/tmp/ccb-test";

const project: ProjectView = {
  id: "project-1",
  name: "SU-CCB",
  localPath: TEST_PROJECT_ROOT,
  summary: "用于管理本地 CCB 项目的控制台",
  initStatus: "initialized",
  syncStatus: "idle",
  lastScanAt: "2026-04-16T10:00:00.000Z"
};

const indexHealth: ProjectIndexHealthView = {
  projectId: "project-1",
  lastScanAt: "2026-04-16T10:00:00.000Z",
  documentCount: 1,
  taskCount: 1,
  requirementCount: 1,
  parseFailureCount: 0,
  freshness: true
};

const documentList: DocumentView[] = [
  {
    id: "doc-1",
    projectId: "project-1",
    taskKey: "task-user-login",
    path: "docs/03_开发计划/user-login-开发任务.md",
    kind: "dev_task",
    title: "用户登录能力",
    status: "reviewing",
    summary: "实现控制台的账号登录入口。",
    parseStatus: "success",
    mtime: "2026-04-16T10:00:00.000Z",
    updatedAt: "2026-04-16T10:00:00.000Z",
    governance: { tier: "生效中", requirementId: null, entityStatus: "reviewing", taskId: "task-user-login", healthFlags: { parseError: false } }
  }
];

const documentDetail: DocumentDetailView = {
  ...documentList[0],
  frontmatter: {
    task_id: "task-user-login",
    status: "reviewing"
  },
  content: "## 背景\n\n实现控制台的账号登录入口。\n\n```ts\nconst app = fastify();\n```"
};

const taskList: TaskView[] = [
  {
    id: "task-1",
    projectId: "project-1",
    taskKey: "task-user-login",
    title: "用户登录任务卡",
    summary: "正在补服务端接口。",
    status: "reviewing",
    phase: "implementing",
    currentNode: "implementation",
    nodeSubstate: "executing",
    runtimeState: "running",
    lastTransitionId: "dispatch__on_codex_pickup__to__implementation",
    requirementId: "req-1",
    priority: "high",
    progress: 60,
    step: null,
    blockedReason: null,
    reviewStatus: "passed",
    semanticKind: null,
    updatedAt: "2026-04-16T10:00:00.000Z"
  }
];

const blockedTask: TaskView = {
  ...taskList[0],
  id: "task-2",
  taskKey: "task-blocked-review",
  title: "评审阻塞任务卡",
  status: "reviewing",
  phase: "reviewing",
  currentNode: "review",
  nodeSubstate: "blocked",
  runtimeState: "blocked",
  blockedReason: "等待 capability fallback 处理",
  updatedAt: "2026-04-16T11:00:00.000Z"
};

const taskDetail: TaskDetailView = {
  ...taskList[0],
  linkedRequirement: {
    id: "req-1",
    title: "增加通知中心",
    verbatimSource: "用户原话第一行\n第二行"
  },
  reviewStatus: "passed",
  verificationResult: {
    build: "passed",
    test: "passed",
    timestamp: "2026-04-23T00:00:00.000Z"
  },
  reviewFollowup: ["补充回归记录"],
  reviewIntents: [
    {
      id: "review-intent-1",
      projectId: "project-1",
      taskId: "task-1",
      taskKey: "task-user-login",
      intentType: "request_replan",
      payload: "需要补充测试",
      status: "pending",
      actor: null,
      consumedAt: null,
      consumedBy: null,
      createdAt: "2026-04-23T00:00:00.000Z",
      updatedAt: "2026-04-23T00:00:00.000Z"
    }
  ],
  linkedDocuments: [
    {
      id: "doc-1",
      path: "docs/03_开发计划/user-login-开发任务.md",
      kind: "dev_task",
      title: "用户登录能力",
      status: "reviewing"
    }
  ]
};

const taskTimeline = {
  taskId: "task-1",
  events: [
    {
      kind: "event_projection",
      at: "2026-04-23T00:10:00.000Z",
      label: "Event projection: codex_receipt_ready",
      details: {
        eventId: "event-1",
        eventType: "codex_receipt_ready",
        payloadPreview: "{\"provider\":\"codex\"}",
        projectionOnly: true
      }
    },
    {
      kind: "intent_create",
      at: "2026-04-23T00:00:00.000Z",
      label: "Review intent created: request_replan",
      details: {
        status: "pending"
      }
    },
    {
      kind: "approval",
      at: "2026-04-16T09:30:00.000Z",
      label: "Approval gate: step1_approval",
      details: {
        status: "approved"
      }
    }
  ]
};

const requirementList: RequirementView[] = [
  {
    id: "req-1",
    projectId: "project-1",
    title: "增加通知中心",
    description: "集中查看任务和扫描提醒。",
    status: "delivering",
    source: "manual",
    outputMode: "requirement_only",
    generatedTaskId: "task-1",
    verbatimSource: "用户原话第一行\n第二行",
    claudeInterpretation: "Claude 解读：集中提醒入口。",
    ambiguities: null,
    fidelityDiff: null,
    analysisInputHash: null,
    analysisStaleAt: null,
    createdAt: "2026-04-16T10:00:00.000Z",
    updatedAt: "2026-04-16T10:00:00.000Z"
  }
];

const syncJobList: SyncJobView[] = [
  {
    id: "sync-1",
    projectId: "project-1",
    jobType: "generate",
    status: "success",
    processedCount: 0,
    totalCount: 0,
    startedAt: "2026-04-16T10:00:00.000Z",
    finishedAt: "2026-04-16T10:01:00.000Z",
    logSummary: "需求已创建：增加通知中心",
    errorMessage: null,
    updatedAt: "2026-04-16T10:01:00.000Z"
  },
  {
    id: "sync-2",
    projectId: "project-1",
    jobType: "scan",
    status: "failed",
    processedCount: 1,
    totalCount: 3,
    startedAt: "2026-04-16T09:00:00.000Z",
    finishedAt: "2026-04-16T09:01:00.000Z",
    logSummary: "扫描阶段失败",
    errorMessage: "项目下未找到 docs/.ccb 目录",
    updatedAt: "2026-04-16T09:01:00.000Z"
  },
  {
    id: "sync-3",
    projectId: "project-1",
    jobType: "custom-job",
    status: "mystery",
    processedCount: 0,
    totalCount: 0,
    startedAt: "2026-04-16T08:00:00.000Z",
    finishedAt: null,
    logSummary: "未知任务类型",
    errorMessage: null,
    updatedAt: "2026-04-16T08:00:00.000Z"
  }
];

function mockConsoleApi(): void {
  vi.mocked(consoleApi.fetchProjects).mockResolvedValue([project]);
  vi.mocked(consoleApi.createProject).mockResolvedValue(project);
  vi.mocked(consoleApi.scanProject).mockResolvedValue();
  vi.mocked(consoleApi.fetchProjectScanStatus).mockResolvedValue({
    projectId: "project-1",
    projectSyncStatus: "idle",
    status: "success",
    processedCount: 3,
    totalCount: 3,
    errorMessage: null,
    jobId: "sync-2",
    updatedAt: "2026-04-16T09:01:00.000Z",
    phase: null,
    phaseStatus: null,
    phaseJobId: null,
    phaseErrorMessage: null
  });
  vi.mocked(consoleApi.fetchProjectIndexHealth).mockResolvedValue(indexHealth);
  vi.mocked(consoleApi.fetchDocuments).mockResolvedValue(documentList);
  vi.mocked(consoleApi.fetchDocumentDetail).mockResolvedValue(documentDetail);
  vi.mocked(consoleApi.fetchTasks).mockResolvedValue(taskList);
  vi.mocked(consoleApi.fetchTaskDetail).mockResolvedValue(taskDetail);
  vi.mocked(consoleApi.fetchTaskTimeline).mockResolvedValue(taskTimeline);
  vi.mocked(consoleApi.updateTask).mockResolvedValue(taskList[0]);
  vi.mocked(consoleApi.fetchRequirements).mockResolvedValue(requirementList);
  vi.mocked(consoleApi.fetchSlots).mockResolvedValue({
    project: { id: "project-1", name: "SU-CCB", slotCount: 3 },
    slotCount: 3,
    main: { slotId: "main", lane: "coordination", state: "available", canBindBusiness: false },
    slots: [],
    queue: [],
    shrinkEligibility: {
      projectId: "project-1",
      slotCount: 3,
      tailSlotId: "slot-3",
      canShrink: true,
      eligible: true,
      checks: {
        slotBindingIdle: true,
        queueClear: true,
        runtimeIdle: true
      },
      reasons: [],
      details: {}
    },
    generatedAt: "2026-05-24T00:02:00.000Z"
  });
  vi.mocked(consoleApi.fetchSyncJobs).mockResolvedValue(syncJobList);
  vi.mocked(consoleApi.createRequirement).mockResolvedValue(requirementList[0]);
  vi.mocked(consoleApi.createReviewIntent).mockResolvedValue(taskDetail.reviewIntents[0]);
  vi.mocked(consoleApi.cancelReviewIntent).mockResolvedValue({
    ...taskDetail.reviewIntents[0],
    status: "cancelled"
  });
}

describe("前端重构后的控制台骨架", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    MockEventSource.instances = [];
    vi.stubGlobal("EventSource", MockEventSource);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() =>
        Promise.resolve(
        new Response(JSON.stringify({ items: [] }), {
          status: 200,
          headers: {
            "Content-Type": "application/json"
          }
        })
        )
      )
    );
    window.history.pushState({}, "", "/");
    mockConsoleApi();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("根路径会重定向到概览页并展示项目概览头部", async () => {
    render(<App />);

    await waitFor(() => {
      expect(window.location.pathname).toBe("/overview");
    });

    expect(await screen.findAllByText(/SU-CCB/).then(els => els[0])).toBeInTheDocument();
  });

  it("任务详情由 URL 驱动打开全屏详情页", async () => {
    window.history.pushState({}, "", "/tasks/task-1");

    render(<App />);

    expect(await screen.findByTestId("task-detail-full-page")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "返回看板" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "任务详情" })).not.toBeInTheDocument();
    expect((await screen.findAllByText("用户登录任务卡")).length).toBeGreaterThan(0);
    expect(window.location.pathname).toBe("/tasks/task-1");
  });

  it("任务看板按 4 个子任务执行列展示", async () => {
    vi.mocked(consoleApi.fetchTasks).mockResolvedValue([taskList[0], blockedTask]);
    window.history.pushState({}, "", "/tasks");

    render(<App />);

    await waitFor(() => {
      expect(screen.queryByText("待派工")).not.toBeNull();
      expect(screen.queryByText("执行中")).not.toBeNull();
      expect(screen.queryByText("待评审")).not.toBeNull();
      expect(screen.queryByText("已完成")).not.toBeNull();
    });
  });

  it("任务看板与 Reconcile 入口已从侧边栏隐藏（路由仍可直达）", async () => {
    window.history.pushState({}, "", "/overview");

    const { container } = render(<App />);

    const sidebar = container.querySelector('[data-layout-region="sidebar"]') as HTMLElement;
    await within(sidebar).findByText("需求管理");

    // 仍保留的入口
    expect(within(sidebar).getByText("需求管理")).toBeInTheDocument();
    expect(within(sidebar).getByText("文档中心")).toBeInTheDocument();
    // 临时隐藏的入口
    expect(within(sidebar).queryByText("任务看板")).not.toBeInTheDocument();
    expect(within(sidebar).queryByText("Reconcile")).not.toBeInTheDocument();
  });

  it("文档页会按 Markdown 语义渲染正文", async () => {
    window.history.pushState({}, "", "/documents/doc-1");

    render(<App />);

    expect(await screen.findByRole("heading", { name: "背景" })).toBeInTheDocument();
    expect(screen.getByText(/const app = fastify/)).toBeInTheDocument();
  });

  it("需求看板把 delivering 需求显示在推进中列，徽章中文化", async () => {
    window.history.pushState({}, "", "/requirements");

    render(<App />);

    // 看板下需求卡片直接可见，无需切 tab
    const title = await screen.findByText("增加通知中心");
    const card = title.closest("[role='link']") as HTMLElement;
    expect(card).toBeTruthy();
    // delivering 徽章中文化为“推进中”，不显示英文原文
    expect(within(card).getByText("推进中")).toBeInTheDocument();
    expect(screen.queryByText("delivering")).not.toBeInTheDocument();
    // 前进操作按状态为“查看子任务”（原话/解读已移至详情页，不再塞进看板卡片）
    expect(within(card).getByText(/查看子任务/)).toBeInTheDocument();
  });

  it("任务详情展示关联需求与 state 真源信息", async () => {
    window.history.pushState({}, "", "/tasks/task-1");

    render(<App />);

    // 顶部 alert + node stepper + status strip 默认可见
    expect(await screen.findByText("来自需求：增加通知中心")).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "任务节点" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "执行中 详情" })).toBeInTheDocument();
    expect(screen.queryByText(/transition applied/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/moved to review/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/workflow state/i)).not.toBeInTheDocument();

    // 工作区历史快照不再展示，避免旧任务死路径和新任务空白态进入 Console。
    expect(screen.queryByText("工作区")).not.toBeInTheDocument();
    expect(screen.queryByText("task/task-user-login")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "查看评审" }));
    expect(await screen.findByRole("dialog", { name: "评审详情" })).toBeInTheDocument();
    expect(screen.getByText("评审状态：通过")).toBeInTheDocument();
    expect(screen.getByText("build: passed")).toBeInTheDocument();
    expect(screen.getByText("补充回归记录")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "标记评审通过" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "申请重新规划" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "申请升级" })).toBeInTheDocument();

    // 高级抽屉展示真相源文档（指向 docs/03 dev_task）
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    fireEvent.click(screen.getByRole("button", { name: /高级/ }));
    const advancedDialog = await screen.findByRole("dialog", { name: "高级 / 调试" });
    expect(within(advancedDialog).getByText("真相源文档")).toBeInTheDocument();
    expect(within(advancedDialog).getByText("docs/03_开发计划/user-login-开发任务.md")).toBeInTheDocument();
  });

  it("归档子任务显示子任务标识并屏蔽执行类 CTA", async () => {
    const archivedTask: TaskView = {
      ...taskList[0],
      id: "task-archived",
      taskKey: "ccb-v033-enforcement-consolidation",
      title: "CCB v0.3.3 Enforcement Consolidation",
      status: "done",
      phase: "done",
      currentNode: "archive",
      runtimeState: "completed",
      semanticKind: null,
    };
    vi.mocked(consoleApi.fetchTasks).mockResolvedValue([archivedTask]);
    vi.mocked(consoleApi.fetchTaskDetail).mockResolvedValue({
      ...taskDetail,
      ...archivedTask,
      reviewIntents: [],
      linkedDocuments: [
        {
          id: "state-epic",
          path: "docs/.ccb/state/2026-04-23-ccb-v033-enforcement-consolidation.md",
          kind: "state",
          title: "CCB v0.3.3 Enforcement Consolidation",
          status: "epic_completed"
        }
      ]
    });
    window.history.pushState({}, "", "/tasks/task-archived");

    render(<App />);

    expect(await screen.findByText("子任务")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "标记评审通过" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "标记完成" })).not.toBeInTheDocument();
  });

  it("命令面板支持快捷键、搜索、键盘执行和点击执行", async () => {
    render(<App />);

    await screen.findAllByText(/SU-CCB/).then(els => els[0]);

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const firstPalette = await screen.findByRole("dialog", { name: "命令面板" });
    expect(firstPalette).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "命令面板" })).not.toBeInTheDocument();

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const palette = await screen.findByRole("dialog", { name: "命令面板" });
    expect(within(palette).getByText("打开概览")).toBeInTheDocument();
    expect(within(palette).getByText("打开文档中心")).toBeInTheDocument();
    expect(within(palette).getByText("扫描文档")).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "ArrowDown" });
    fireEvent.keyDown(window, { key: "Enter" });

    await waitFor(() => {
      expect(window.location.pathname).toBe("/documents");
    });
    expect(screen.queryByRole("dialog", { name: "命令面板" })).not.toBeInTheDocument();

    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const reopenedPalette = await screen.findByRole("dialog", { name: "命令面板" });
    const searchInput = within(reopenedPalette).getByLabelText("搜索命令");
    fireEvent.change(searchInput, { target: { value: "需求" } });
    expect(within(reopenedPalette).getByText("打开需求管理")).toBeInTheDocument();
    expect(within(reopenedPalette).getByText("新建需求")).toBeInTheDocument();
    expect(within(reopenedPalette).queryByText("打开任务看板")).not.toBeInTheDocument();

    fireEvent.click(within(reopenedPalette).getByText("新建需求"));
    expect(screen.queryByRole("dialog", { name: "命令面板" })).not.toBeInTheDocument();
    expect(await screen.findByRole("dialog", { name: "新建需求" })).toBeInTheDocument();
  });

  it("运行记录会对扩展 jobType 和未知 status 使用 fallback 展示", async () => {
    window.history.pushState({}, "", "/runs");

    render(<App />);

    expect(await screen.findByText("生成")).toBeInTheDocument();
    expect(screen.getByText("custom-job")).toBeInTheDocument();
    expect(screen.getByText("mystery")).toBeInTheDocument();
  });

  it("AI CLI 页面保持可渲染", async () => {
    window.history.pushState({}, "", "/ai-cli");

    render(<App />);

    expect((await screen.findAllByText("外部窗口")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("页内嵌入").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/cwd:/).length).toBeGreaterThan(0);
  });
});
