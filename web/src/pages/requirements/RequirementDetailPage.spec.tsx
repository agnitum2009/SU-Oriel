import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RequirementDetailView } from "../../types/requirement.js";
import type { SlotProjectionView } from "../../lib/console-api.js";
import type { DocumentDetailView, DocumentView } from "../../types/document.js";
import type { RequirementAggregationView, TaskView } from "../../types/task.js";

vi.mock("../../lib/console-api.js", () => ({
  ConsoleApiError: class ConsoleApiError extends Error {
    constructor(
      message: string,
      public readonly status: number,
      public readonly code?: string,
      public readonly retryAfter?: string
    ) {
      super(message);
    }
  },
  batchDispatchSubtasks: vi.fn(),
  bindSlot: vi.fn(),
  dispatchRequirementAnchorCommand: vi.fn(),
  fetchDocumentDetail: vi.fn(),
  fetchEventJournalEvents: vi.fn(),
  fetchRequirementAggregation: vi.fn().mockResolvedValue(null),
  fetchRequirementDetail: vi.fn(),
  fetchRequirementMarkdown: vi.fn(),
  fetchSlots: vi.fn(),
  fetchSubtaskBatchCandidates: vi.fn(),
  fetchTaskMarkdown: vi.fn(),
  fetchTerminalDescriptor: vi.fn(
    async (
      target:
        | { kind: "requirement"; projectId: string; requirementId: string }
        | { kind: "agentGroup"; projectId: string; group: string }
    ) => {
      const path =
        target.kind === "requirement"
          ? `/api/projects/${encodeURIComponent(target.projectId)}/requirements/${encodeURIComponent(target.requirementId)}/slot-terminal`
          : `/api/projects/${encodeURIComponent(target.projectId)}/agent-terminal/${encodeURIComponent(target.group)}`;
      const response = await fetch(path);
      if (!response.ok) {
        throw new Error(response.status === 404 ? "slot terminal unavailable" : `slot terminal resolver failed: ${response.status}`);
      }
      return await response.json();
    }
  ),
  fetchTasks: vi.fn().mockResolvedValue([]),
  getReanalyzeJobStatus: vi.fn(),
  patchRequirement: vi.fn(),
  reindexRequirement: vi.fn(),
  reanalyzeRequirement: vi.fn(),
  releaseSlot: vi.fn(),
  startRequirementPlanningAnchor: vi.fn(),
  uploadRequirementAsset: vi.fn()
}));

vi.mock("../../components/requirements/RequirementMarkdownEditor.js", () => ({
  RequirementMarkdownEditor: (props: {
    value: string;
    onChange: (value: string) => void;
    disabled?: boolean;
  }) => (
    <textarea
      aria-label="需求 Markdown 编辑器"
      data-readonly={String(Boolean(props.disabled))}
      onChange={(event) => props.onChange(event.currentTarget.value)}
      readOnly={props.disabled}
      value={props.value}
    />
  )
}));

vi.mock("../../components/slot-terminal/SlotTerminalSurface.js", () => ({
  SlotTerminalSurface: (props: { pane: string; title?: string }) => (
    <div data-testid={`slot-terminal-surface-${props.pane}`}>{props.title ?? props.pane}</div>
  )
}));

import { MemoryRouter, Route, Routes } from "react-router";

import * as consoleApi from "../../lib/console-api.js";
import { useProjectStore } from "../../stores/project-store.js";
import { useUIStore } from "../../stores/ui-store.js";
import { RequirementDetailPage } from "./RequirementDetailPage.js";

function buildRequirement(overrides: Partial<RequirementDetailView> = {}): RequirementDetailView {
  return {
    id: "req-1",
    projectId: "project-1",
    title: "可编辑需求",
    description: "## 背景\n\n最新描述\n\n- 保留 Markdown",
    status: "drafting",
    source: "manual",
    outputMode: "requirement_only",
    splitMode: "direct_pr",
    generatedTaskId: null,
    verbatimSource: "用户原话",
    claudeInterpretation: "旧 AI 解读",
    ambiguities: "旧歧义",
    fidelityDiff: "旧保真差异",
    analysisInputHash: "old-hash",
    analysisStaleAt: "2026-05-17T01:00:00.000Z",
    createdAt: "2026-05-17T00:00:00.000Z",
    updatedAt: "2026-05-17T00:00:00.000Z",
    mdHash: "a".repeat(64),
    ...overrides
  };
}

function buildSubtask(overrides: Partial<TaskView> = {}): TaskView {
  return {
    id: "task-1",
    projectId: "project-1",
    taskKey: "CCB-1",
    title: "第一个子任务",
    summary: null,
    kind: "subtask",
    semanticKind: "subtask",
    specSectionId: null,
    implementationOwner: "ccb_codex",
    sprintId: null,
    storyPoints: null,
    status: "reviewing",
    phase: "dispatch",
    currentNode: "dispatch",
    nodeSubstate: null,
    runtimeState: "idle",
    lastTransitionId: null,
    priority: "medium",
    progress: 10,
    step: 1,
    blockedReason: null,
    requirementId: "req-1",
    reviewStatus: null,
    updatedAt: "2026-05-17T00:00:00.000Z",
    ...overrides
  };
}

function buildBatchCandidate(overrides: Record<string, unknown> = {}) {
  return {
    taskId: "task-1",
    taskKey: "CCB-1",
    title: "第一个子任务",
    currentNode: "dispatch",
    status: "reviewing",
    hasActiveAnchor: false,
    isPendingDispatch: false,
    eligible: true,
    ineligibleReason: null,
    ...overrides
  };
}

function buildSlotProjection(
  overrides: Partial<SlotProjectionView> = {},
  slotOverrides: Array<Partial<SlotProjectionView["slots"][number]>> = []
): SlotProjectionView {
  const slots = Array.from({ length: 3 }, (_, index): SlotProjectionView["slots"][number] => {
    const slotId = `slot-${index + 1}`;
    const override = slotOverrides.find((slot) => slot.slotId === slotId) ?? {};
    return {
      slotId,
      state: "idle",
      requirement: null,
      boundAt: null,
      busySince: null,
      lastActivityAt: null,
      stale: null,
      unhealthy: null,
      queued: [],
      ...override
    };
  });
  return {
    project: { id: "project-1", name: "SU-CCB", slotCount: 3 },
    slotCount: 3,
    main: { slotId: "main", lane: "coordination", state: "available", canBindBusiness: false },
    slots,
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
    generatedAt: "2026-05-24T00:00:00.000Z",
    ...overrides
  };
}

function slotTerminalResponse(slotId = "slot-3"): Response {
  return new Response(
    JSON.stringify({
      slotId,
      sessionName: "ccb-su-ccb-test-session",
      panes: [
        { role: "claude", target: "%7", paneIndex: 1 },
        { role: "codex", target: "%8", paneIndex: 2 }
      ]
    }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json"
      }
    }
  );
}

function buildDocument(overrides: Partial<DocumentView> = {}): DocumentView {
  return {
    id: "doc-plan",
    projectId: "project-1",
    taskKey: null,
    path: "docs/design.md",
    kind: "plan",
    title: "技术设计",
    status: "active",
    summary: null,
    parseStatus: "parsed",
    mtime: "2026-05-17T00:00:00.000Z",
    updatedAt: "2026-05-17T00:00:00.000Z",
    governance: { tier: "生效中", requirementId: null, entityStatus: null, taskId: null, healthFlags: { parseError: false } },
    ...overrides
  };
}

function buildDocumentDetail(overrides: Partial<DocumentDetailView> = {}): DocumentDetailView {
  return {
    ...buildDocument(),
    frontmatter: {},
    content: "# 技术设计正文\n\n设计内容",
    ...overrides
  };
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/projects/project-1/requirements/req-1"]}>
      <Routes>
        <Route element={<RequirementDetailPage />} path="/projects/:projectId/requirements/:requirementId" />
        <Route element={<div>拆分审查页</div>} path="/projects/:projectId/requirements/:requirementId/breakdown-review" />
        <Route element={<div data-testid="task-detail-sentinel">任务详情页哨兵</div>} path="/projects/:projectId/tasks/:taskId" />
      </Routes>
    </MemoryRouter>
  );
}

describe("RequirementDetailPage 极简详情页", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    vi.mocked(consoleApi.fetchRequirementAggregation).mockResolvedValue(null as unknown as RequirementAggregationView);
    vi.mocked(consoleApi.batchDispatchSubtasks).mockReset();
    vi.mocked(consoleApi.fetchSubtaskBatchCandidates).mockReset();
    vi.mocked(consoleApi.fetchSubtaskBatchCandidates).mockResolvedValue({ candidates: [] });
    vi.mocked(consoleApi.fetchDocumentDetail).mockReset();
    vi.mocked(consoleApi.fetchDocumentDetail).mockResolvedValue(buildDocumentDetail());
    vi.mocked(consoleApi.fetchRequirementMarkdown).mockReset();
    vi.mocked(consoleApi.fetchRequirementMarkdown).mockResolvedValue({
      path: "docs/02_需求设计/req.md",
      content: "# 完整需求文档\n\n需求正文内容"
    });
    vi.mocked(consoleApi.fetchTaskMarkdown).mockReset();
    vi.mocked(consoleApi.fetchTaskMarkdown).mockResolvedValue({
      path: "docs/03_开发计划/task-1-开发任务.md",
      content: "# 子任务文档\n\n实现内容"
    });
    vi.mocked(consoleApi.fetchEventJournalEvents).mockReset();
    vi.mocked(consoleApi.fetchEventJournalEvents).mockResolvedValue({ items: [], pageInfo: { limit: 20, offset: 0, count: 0 } });
    vi.mocked(consoleApi.fetchRequirementDetail).mockReset();
    vi.mocked(consoleApi.fetchTasks).mockResolvedValue([]);
    vi.mocked(consoleApi.fetchSlots).mockReset();
    vi.mocked(consoleApi.fetchSlots).mockResolvedValue(buildSlotProjection());
    vi.mocked(consoleApi.dispatchRequirementAnchorCommand).mockReset();
    vi.mocked(consoleApi.bindSlot).mockReset();
    vi.mocked(consoleApi.bindSlot).mockResolvedValue({
      ...buildSlotProjection({}, [
        {
          slotId: "slot-1",
          state: "bound",
          requirement: { id: "req-1", title: "可编辑需求" },
          boundAt: "2026-05-24T00:00:00.000Z",
          lastActivityAt: "2026-05-24T00:00:00.000Z"
        }
      ]),
      slot: {
        slotId: "slot-1",
        state: "bound",
        requirement: { id: "req-1", title: "可编辑需求" },
        boundAt: "2026-05-24T00:00:00.000Z",
        busySince: null,
        lastActivityAt: "2026-05-24T00:00:00.000Z",
        stale: null,
        unhealthy: null,
        queued: []
      }
    });
    vi.mocked(consoleApi.releaseSlot).mockReset();
    vi.mocked(consoleApi.releaseSlot).mockResolvedValue(buildSlotProjection() as never);
    vi.mocked(consoleApi.getReanalyzeJobStatus).mockReset();
    vi.mocked(consoleApi.patchRequirement).mockReset();
    vi.mocked(consoleApi.reindexRequirement).mockReset();
    vi.mocked(consoleApi.reindexRequirement).mockResolvedValue({
      reindexed: true,
      deduped: false,
      status: "success",
      projectId: "project-1",
      requirementId: "req-1",
      issues: []
    });
    vi.mocked(consoleApi.reanalyzeRequirement).mockReset();
    vi.mocked(consoleApi.startRequirementPlanningAnchor).mockReset();
    vi.mocked(consoleApi.uploadRequirementAsset).mockResolvedValue({
      path: "./assets/requirements/req-1/paste.png",
      filename: "paste.png",
      mimeType: "image/png",
      size: 3
    });
    useProjectStore.setState({
      selectedProjectId: "project-1",
      documents: [],
      loadProjectData: vi.fn()
    });
    useUIStore.setState({ toasts: [] });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(slotTerminalResponse()));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the artifact catalog with slot guidance instead of the legacy anchor terminal", async () => {
    vi.mocked(consoleApi.fetchRequirementDetail).mockResolvedValue(
      buildRequirement({
        status: "planning",
        currentPlanningStep: "design",
        breakdownDraftPath: "docs/03_开发计划/req-1-breakdown.md",
        planDocPath: "docs/01_架构设计/req-1.md",
        planningRuntimeState: "running",
        planningAnchorId: "slot-3",
        analysisStaleAt: null
      })
    );
    vi.mocked(consoleApi.fetchTasks).mockResolvedValue([buildSubtask()]);
    vi.mocked(consoleApi.fetchSubtaskBatchCandidates).mockResolvedValue({
      candidates: [buildBatchCandidate()]
    });
    vi.mocked(consoleApi.fetchSlots).mockResolvedValue(buildSlotProjection({}, [
      {
        slotId: "slot-3",
        state: "bound",
        requirement: { id: "req-1", title: "可编辑需求" },
        boundAt: "2026-05-24T00:00:00.000Z",
        lastActivityAt: "2026-05-24T00:00:00.000Z"
      }
    ]));

    const { asFragment } = renderPage();

    expect(await screen.findByTestId("requirement-detail-workspace")).toBeInTheDocument();
    expect(screen.getByText("产物 4/4")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "需求文档" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "产物索引" })).toBeInTheDocument();
    const slotRegion = screen.getByRole("region", { name: "Slot 运行位置" });
    expect(slotRegion).toBeInTheDocument();
    expect(await within(slotRegion).findByText("正在写 slot-3 的 claude")).toBeInTheDocument();
    expect(within(slotRegion).getByRole("tab", { name: "claude" })).toHaveAttribute("aria-selected", "true");
    expect(within(slotRegion).getByRole("tab", { name: "codex" })).toHaveAttribute("aria-selected", "false");
    expect(within(slotRegion).getByTestId("slot-terminal-surface-claude")).toHaveTextContent("slot-3 · claude");
    expect(within(slotRegion).getByRole("link", { name: "打开 Slots" })).toHaveAttribute("href", "/projects/project-1/anchors");
    expect(screen.queryByRole("region", { name: "Anchor 终端" })).not.toBeInTheDocument();
    expect(screen.queryByTestId("anchor-terminal-panel")).not.toBeInTheDocument();
    expect(screen.queryByText("暂停运行时")).not.toBeInTheDocument();
    expect(screen.queryByText("复原 Anchor")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "📖 阅读解读" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重新解析" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "📖 阅读设计" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "重新生成" })).toHaveLength(2);
    expect(screen.getByRole("button", { name: "📂 打开审查页" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "批量推进 1 个子任务" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "展开子任务" })).toBeInTheDocument();
    expect(within(screen.getByTestId("artifact-subtasks")).getByText("1 个")).toBeInTheDocument();
    expect(screen.queryByText("计划阶段")).toBeNull();
    expect(screen.queryByText("活动时间线")).toBeNull();
    expect(asFragment()).toMatchSnapshot();
    fireEvent.click(within(slotRegion).getByRole("tab", { name: "codex" }));
    expect(await within(slotRegion).findByText("正在写 slot-3 的 codex")).toBeInTheDocument();
    expect(within(slotRegion).getByTestId("slot-terminal-surface-codex")).toHaveTextContent("slot-3 · codex");
  });

  it("falls back to the original slot guidance when the terminal resolver returns 404", async () => {
    vi.mocked(consoleApi.fetchRequirementDetail).mockResolvedValue(buildRequirement({ status: "planning" }));
    vi.mocked(consoleApi.fetchSlots).mockResolvedValue(buildSlotProjection({}, [
      {
        slotId: "slot-3",
        state: "bound",
        requirement: { id: "req-1", title: "可编辑需求" },
        boundAt: "2026-05-24T00:00:00.000Z",
        lastActivityAt: "2026-05-24T00:00:00.000Z"
      }
    ]));
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ message: "missing" }), { status: 404 }));

    renderPage();

    const slotRegion = await screen.findByRole("region", { name: "Slot 运行位置" });
    expect(await within(slotRegion).findByText("已绑定 slot-3 · bound")).toBeInTheDocument();
    expect(within(slotRegion).getByText("终端请在 ccb 原生 sidebar 查看对应 slot 窗口。")).toBeInTheDocument();
    expect(within(slotRegion).queryByRole("tab", { name: "claude" })).not.toBeInTheDocument();
  });

  it("marks stale AI analysis as expired instead of completed", async () => {
    vi.mocked(consoleApi.fetchRequirementDetail).mockResolvedValue(
      buildRequirement({
        analysisStaleAt: "2026-05-17T01:00:00.000Z",
        planDocPath: null,
        breakdownDraftPath: null
      })
    );

    renderPage();

    const aiCard = await screen.findByTestId("artifact-ai-analysis");
    expect(within(aiCard).getByText("已过期")).toBeInTheDocument();
    expect(within(aiCard).queryByText("已生成")).not.toBeInTheDocument();
    expect(screen.getByText("产物 0/4")).toBeInTheDocument();
    expect(within(aiCard).getByRole("button", { name: "重新解析" })).toBeInTheDocument();
    expect(within(screen.getByTestId("artifact-subtasks")).getByText("未生成")).toBeInTheDocument();
  });

  it("binds and releases a requirement slot from the slot location panel", async () => {
    vi.mocked(consoleApi.fetchRequirementDetail).mockResolvedValue(buildRequirement({ status: "planning" }));
    vi.mocked(consoleApi.fetchSlots)
      .mockResolvedValueOnce(buildSlotProjection())
      .mockResolvedValueOnce(buildSlotProjection({}, [
        {
          slotId: "slot-1",
          state: "bound",
          requirement: { id: "req-1", title: "可编辑需求" },
          boundAt: "2026-05-24T00:00:00.000Z",
          lastActivityAt: "2026-05-24T00:00:00.000Z"
        }
      ]))
      .mockResolvedValueOnce(buildSlotProjection());

    renderPage();

    const slotRegion = await screen.findByRole("region", { name: "Slot 运行位置" });
    expect(await within(slotRegion).findByText("未绑定 slot")).toBeInTheDocument();
    fireEvent.click(within(slotRegion).getByRole("button", { name: "绑定 slot" }));

    await screen.findByText("已绑定 slot-1 · bound");
    expect(consoleApi.bindSlot).toHaveBeenCalledWith("project-1", "req-1");
    expect(within(slotRegion).getByRole("button", { name: "解绑 slot" })).toBeInTheDocument();

    fireEvent.click(within(slotRegion).getByRole("button", { name: "解绑 slot" }));

    const dialog = await screen.findByRole("dialog", { name: "确认解绑 slot-1" });
    expect(within(dialog).getByText(/释放后该 slot 可能被队列中其它需求立即占用/)).toBeInTheDocument();
    expect(consoleApi.releaseSlot).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "确认解绑" }));

    await within(slotRegion).findByText("未绑定 slot");
    expect(consoleApi.releaseSlot).toHaveBeenCalledWith("project-1", "slot-1", { confirm: true });
  });

  it("shows slot full feedback when bind-slot reports no idle slot", async () => {
    vi.mocked(consoleApi.fetchRequirementDetail).mockResolvedValue(buildRequirement({ status: "planning" }));
    vi.mocked(consoleApi.bindSlot).mockRejectedValue(new Error("slot 已满，去 SlotsPage 看排队"));

    renderPage();

    const slotRegion = await screen.findByRole("region", { name: "Slot 运行位置" });
    fireEvent.click(await within(slotRegion).findByRole("button", { name: "绑定 slot" }));

    await act(async () => {
      await Promise.resolve();
    });
    expect(useUIStore.getState().toasts.at(-1)?.message).toBe("slot 已满，去 SlotsPage 看排队");
  });

  it("force releases a busy slot from the detail page with a required reason", async () => {
    vi.mocked(consoleApi.fetchRequirementDetail).mockResolvedValue(buildRequirement({ status: "planning" }));
    vi.mocked(consoleApi.fetchSlots)
      .mockResolvedValueOnce(buildSlotProjection({}, [
        {
          slotId: "slot-2",
          state: "busy",
          requirement: { id: "req-1", title: "可编辑需求" },
          boundAt: "2026-05-24T00:00:00.000Z",
          busySince: "2026-05-24T01:00:00.000Z",
          lastActivityAt: "2026-05-24T01:00:00.000Z"
        }
      ]))
      .mockResolvedValueOnce(buildSlotProjection());
    vi.mocked(fetch).mockResolvedValueOnce(slotTerminalResponse("slot-2"));

    renderPage();

    const slotRegion = await screen.findByRole("region", { name: "Slot 运行位置" });
    expect(await within(slotRegion).findByText("正在写 slot-2 的 claude")).toBeInTheDocument();
    fireEvent.click(within(slotRegion).getByRole("button", { name: "解绑 slot" }));

    const dialog = await screen.findByRole("dialog", { name: "确认解绑 slot-2" });
    expect(within(dialog).getByRole("alert")).toHaveTextContent("该 slot 有 agent 正在运行，解绑会中断其工作");
    expect(consoleApi.releaseSlot).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "确认解绑" }));
    expect(await within(dialog).findByText("请填写解绑原因")).toBeInTheDocument();
    expect(consoleApi.releaseSlot).not.toHaveBeenCalled();

    fireEvent.change(within(dialog).getByLabelText("解绑原因"), { target: { value: "人工中断异常执行" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "确认解绑" }));

    await within(slotRegion).findByText("未绑定 slot");
    expect(consoleApi.releaseSlot).toHaveBeenCalledWith("project-1", "slot-2", {
      confirm: true,
      force: true,
      reason: "人工中断异常执行"
    });
  });

  it("does not show the unbind action for a draining slot", async () => {
    vi.mocked(consoleApi.fetchRequirementDetail).mockResolvedValue(buildRequirement({ status: "planning" }));
    vi.mocked(consoleApi.fetchSlots).mockResolvedValue(buildSlotProjection({}, [
      {
        slotId: "slot-3",
        state: "draining",
        requirement: { id: "req-1", title: "可编辑需求" },
        boundAt: "2026-05-24T00:00:00.000Z",
        lastActivityAt: "2026-05-24T01:00:00.000Z"
      }
    ]));
    vi.mocked(fetch).mockResolvedValueOnce(slotTerminalResponse("slot-3"));

    renderPage();

    const slotRegion = await screen.findByRole("region", { name: "Slot 运行位置" });
    expect(await within(slotRegion).findByText("正在写 slot-3 的 claude")).toBeInTheDocument();
    expect(within(slotRegion).queryByRole("button", { name: "解绑 slot" })).not.toBeInTheDocument();
    expect(within(slotRegion).getByRole("link", { name: "打开 Slots" })).toHaveAttribute("href", "/projects/project-1/anchors");
  });

  it("opens the AI analysis modal with the full requirement document and closes it", async () => {
    vi.mocked(consoleApi.fetchRequirementDetail).mockResolvedValue(buildRequirement());
    vi.mocked(consoleApi.fetchRequirementMarkdown).mockResolvedValue({
      path: "docs/02_需求设计/req-1.md",
      content: "# 完整需求文档\n\n需求描述与 AI 解读全文"
    });

    renderPage();

    const card = await screen.findByTestId("artifact-ai-analysis");
    fireEvent.click(within(card).getByRole("button", { name: "📖 阅读解读" }));

    const modal = await screen.findByRole("dialog", { name: "AI 解析 · 需求文档" });
    expect(consoleApi.fetchRequirementMarkdown).toHaveBeenCalledWith("project-1", "req-1");
    expect(await within(modal).findByRole("heading", { name: "完整需求文档" })).toBeInTheDocument();
    expect(within(modal).getByText("需求描述与 AI 解读全文")).toBeInTheDocument();

    fireEvent.click(within(modal).getByRole("button", { name: "关闭" }));
    expect(screen.queryByRole("dialog", { name: "AI 解析 · 需求文档" })).toBeNull();
  });

  it("shows a not-found fallback when the requirement markdown endpoint returns 404", async () => {
    vi.mocked(consoleApi.fetchRequirementDetail).mockResolvedValue(buildRequirement());
    vi.mocked(consoleApi.fetchRequirementMarkdown).mockRejectedValue(
      new consoleApi.ConsoleApiError("Not Found", 404)
    );

    renderPage();

    const card = await screen.findByTestId("artifact-ai-analysis");
    fireEvent.click(within(card).getByRole("button", { name: "📖 阅读解读" }));

    const modal = await screen.findByRole("dialog", { name: "AI 解析 · 需求文档" });
    expect(await within(modal).findByText("需求文档不存在或已被删除")).toBeInTheDocument();
  });

  it("drops late AI markdown responses after the modal closes", async () => {
    let resolveLate!: (value: { path: string; content: string }) => void;
    vi.mocked(consoleApi.fetchRequirementDetail).mockResolvedValue(buildRequirement());
    vi.mocked(consoleApi.fetchRequirementMarkdown).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveLate = resolve;
      })
    );

    renderPage();

    const card = await screen.findByTestId("artifact-ai-analysis");
    fireEvent.click(within(card).getByRole("button", { name: "📖 阅读解读" }));
    expect(await screen.findByText("正在加载需求文档...")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(screen.queryByRole("dialog", { name: "AI 解析 · 需求文档" })).toBeNull();

    await act(async () => {
      resolveLate({ path: "docs/02_需求设计/req-1.md", content: "# 迟到内容" });
      await Promise.resolve();
    });

    expect(screen.queryByRole("dialog", { name: "AI 解析 · 需求文档" })).toBeNull();
    expect(screen.queryByText("迟到内容")).toBeNull();
  });

  it("opens subtask markdown reader in-place without navigating to task detail", async () => {
    let resolveTaskMarkdown!: (value: { path: string; content: string }) => void;
    vi.mocked(consoleApi.fetchRequirementDetail).mockResolvedValue(buildRequirement());
    vi.mocked(consoleApi.fetchTasks).mockResolvedValue([buildSubtask()]);
    vi.mocked(consoleApi.fetchTaskMarkdown).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveTaskMarkdown = resolve;
      })
    );

    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "展开子任务" }));
    const subtaskButton = screen.getByRole("button", { name: /第一个子任务/ });
    subtaskButton.focus();
    fireEvent.click(subtaskButton);

    const modal = await screen.findByRole("dialog", { name: "任务文档 · 第一个子任务" });
    expect(within(modal).getByText("正在加载任务文档...")).toBeInTheDocument();
    expect(consoleApi.fetchTaskMarkdown).toHaveBeenCalledWith("project-1", "task-1");
    expect(screen.queryByTestId("task-detail-sentinel")).toBeNull();
    expect(screen.getByTestId("requirement-detail-page")).toBeInTheDocument();

    await act(async () => {
      resolveTaskMarkdown({
        path: "docs/03_开发计划/task-1-开发任务.md",
        content: "# 子任务文档\n\n实现内容"
      });
      await Promise.resolve();
    });

    expect(await within(modal).findByRole("heading", { name: "子任务文档" })).toBeInTheDocument();
    expect(within(modal).getByText("实现内容")).toBeInTheDocument();

    await act(async () => {
      fireEvent.keyDown(document, { key: "Escape" });
      await Promise.resolve();
    });
    expect(screen.queryByRole("dialog", { name: "任务文档 · 第一个子任务" })).toBeNull();
    expect(document.activeElement).toBe(subtaskButton);
  });

  it("drops late subtask markdown responses when switching from A to B", async () => {
    let resolveA!: (value: { path: string; content: string }) => void;
    let resolveB!: (value: { path: string; content: string }) => void;
    vi.mocked(consoleApi.fetchRequirementDetail).mockResolvedValue(buildRequirement());
    vi.mocked(consoleApi.fetchTasks).mockResolvedValue([
      buildSubtask({ id: "task-a", title: "A 子任务", step: 1 }),
      buildSubtask({ id: "task-b", title: "B 子任务", step: 2 })
    ]);
    vi.mocked(consoleApi.fetchTaskMarkdown).mockImplementation((_projectId, taskId) =>
      new Promise((resolve) => {
        if (taskId === "task-a") {
          resolveA = resolve;
          return;
        }
        resolveB = resolve;
      })
    );

    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "展开子任务" }));
    fireEvent.click(screen.getByRole("button", { name: /A 子任务/ }));
    expect(await screen.findByRole("dialog", { name: "任务文档 · A 子任务" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /B 子任务/ }));
    const modal = await screen.findByRole("dialog", { name: "任务文档 · B 子任务" });

    await act(async () => {
      resolveB({ path: "docs/03_开发计划/b.md", content: "# B 内容" });
      await Promise.resolve();
    });
    expect(await within(modal).findByRole("heading", { name: "B 内容" })).toBeInTheDocument();

    await act(async () => {
      resolveA({ path: "docs/03_开发计划/a.md", content: "# A 内容" });
      await Promise.resolve();
    });

    expect(screen.queryByRole("heading", { name: "A 内容" })).toBeNull();
    expect(within(modal).getByRole("heading", { name: "B 内容" })).toBeInTheDocument();
  });

  it("shows a not-found fallback when the subtask markdown endpoint returns 404", async () => {
    vi.mocked(consoleApi.fetchRequirementDetail).mockResolvedValue(buildRequirement());
    vi.mocked(consoleApi.fetchTasks).mockResolvedValue([buildSubtask()]);
    vi.mocked(consoleApi.fetchTaskMarkdown).mockRejectedValue(
      new consoleApi.ConsoleApiError("Not Found", 404)
    );

    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "展开子任务" }));
    fireEvent.click(screen.getByRole("button", { name: /第一个子任务/ }));

    const modal = await screen.findByRole("dialog", { name: "任务文档 · 第一个子任务" });
    expect(await within(modal).findByText("任务文档不存在或尚未进入索引")).toBeInTheDocument();
  });

  it("shows an empty fallback when the subtask markdown body is empty", async () => {
    vi.mocked(consoleApi.fetchRequirementDetail).mockResolvedValue(buildRequirement());
    vi.mocked(consoleApi.fetchTasks).mockResolvedValue([buildSubtask()]);
    vi.mocked(consoleApi.fetchTaskMarkdown).mockResolvedValue({
      path: "docs/03_开发计划/task-1-开发任务.md",
      content: "   "
    });

    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "展开子任务" }));
    fireEvent.click(screen.getByRole("button", { name: /第一个子任务/ }));

    const modal = await screen.findByRole("dialog", { name: "任务文档 · 第一个子任务" });
    expect(await within(modal).findByText("任务文档正文为空")).toBeInTheDocument();
  });

  it("shows only generate action when AI analysis is missing", async () => {
    vi.mocked(consoleApi.fetchRequirementDetail).mockResolvedValue(
      buildRequirement({
        claudeInterpretation: null,
        ambiguities: null,
        fidelityDiff: null
      })
    );

    renderPage();

    const card = await screen.findByTestId("artifact-ai-analysis");
    expect(within(card).getByRole("button", { name: "生成 AI 解析" })).toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: "📖 阅读解读" })).toBeNull();
    expect(within(card).queryByRole("button", { name: "重新解析" })).toBeNull();
  });

  it("edits requirement markdown with the unified editor modal", async () => {
    vi.mocked(consoleApi.fetchRequirementDetail)
      .mockResolvedValueOnce(buildRequirement())
      .mockResolvedValueOnce(buildRequirement({ description: "更新后的 **Markdown**" }));
    vi.mocked(consoleApi.patchRequirement).mockResolvedValue(buildRequirement({ description: "更新后的 **Markdown**" }));

    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "编辑需求文档" }));
    const dialog = await screen.findByRole("dialog", { name: "编辑需求文档" });
    const editor = within(dialog).getByLabelText("需求 Markdown 编辑器");

    await userEvent.clear(editor);
    await userEvent.type(editor, "更新后的 **Markdown**");
    fireEvent.click(within(dialog).getByRole("button", { name: "保存内容" }));

    await act(async () => {
      await Promise.resolve();
    });

    expect(consoleApi.patchRequirement).toHaveBeenCalledWith("project-1", "req-1", {
      description: "更新后的 **Markdown**",
      expectedMdHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    });
  });

  it("opens requirement read modal as rendered markdown and rewrites uploaded image URLs", async () => {
    vi.mocked(consoleApi.fetchRequirementDetail).mockResolvedValue(
      buildRequirement({
        description: "## 背景\n\n![截图](./assets/requirements/req-1/paste.png)",
        verbatimSource: "不应展示的原话"
      })
    );

    renderPage();

    expect(await screen.findByRole("button", { name: "全屏阅读" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "展开" })).not.toBeInTheDocument();
    expect(screen.queryByText("不应展示的原话")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "全屏阅读" }));

    const dialog = await screen.findByRole("dialog", { name: "需求文档" });
    expect(within(dialog).getByRole("heading", { name: "背景" })).toBeInTheDocument();
    expect(within(dialog).queryByLabelText("需求 Markdown 编辑器")).not.toBeInTheDocument();
    expect(within(dialog).getByRole("img", { name: "截图" })).toHaveAttribute(
      "src",
      "/api/projects/project-1/requirements/req-1/assets/paste.png"
    );
  });

  it("does not show stale edit errors when reopening the read modal", async () => {
    vi.mocked(consoleApi.fetchRequirementDetail).mockResolvedValue(buildRequirement());
    vi.mocked(consoleApi.patchRequirement).mockRejectedValue(new Error("保存失败：hash mismatch"));

    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "编辑需求文档" }));
    const editDialog = await screen.findByRole("dialog", { name: "编辑需求文档" });
    fireEvent.click(within(editDialog).getByRole("button", { name: "保存内容" }));

    expect(await within(editDialog).findByText("保存失败：hash mismatch")).toBeInTheDocument();
    fireEvent.click(within(editDialog).getByRole("button", { name: "取消" }));
    fireEvent.click(screen.getByRole("button", { name: "全屏阅读" }));

    const readDialog = await screen.findByRole("dialog", { name: "需求文档" });
    expect(within(readDialog).queryByText("保存失败：hash mismatch")).not.toBeInTheDocument();
  });

  it("loads the generated design document by normalized planDocPath", async () => {
    useProjectStore.setState({
      documents: [buildDocument({ id: "doc-normalized", path: " docs\\design.md " })]
    });
    vi.mocked(consoleApi.fetchRequirementDetail).mockResolvedValue(
      buildRequirement({ planDocPath: "./docs/design.md" })
    );
    vi.mocked(consoleApi.fetchDocumentDetail).mockResolvedValue(
      buildDocumentDetail({
        id: "doc-normalized",
        path: "docs/design.md",
        content: "---\ntitle: hidden\n---\n# 技术设计正文\n\n正文内容"
      })
    );

    renderPage();

    const card = await screen.findByTestId("artifact-design");
    fireEvent.click(within(card).getByRole("button", { name: "📖 阅读设计" }));

    const drawer = await screen.findByRole("dialog", { name: "技术设计" });
    expect(consoleApi.fetchDocumentDetail).toHaveBeenCalledWith("doc-normalized");
    expect(await within(drawer).findByRole("heading", { name: "技术设计正文" })).toBeInTheDocument();
    expect(within(drawer).getByText("正文内容")).toBeInTheDocument();
    expect(within(drawer).queryByText("title: hidden")).not.toBeInTheDocument();
  });

  it("shows design drawer fallbacks for loading, missing index, stale index, 404, read failure, and empty body", async () => {
    let resolveLoading!: (value: DocumentDetailView) => void;
    vi.mocked(consoleApi.fetchRequirementDetail).mockResolvedValue(
      buildRequirement({ planDocPath: "docs/loading.md" })
    );
    useProjectStore.setState({ documents: [buildDocument({ id: "doc-loading", path: "docs/loading.md" })] });
    vi.mocked(consoleApi.fetchDocumentDetail).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveLoading = resolve;
      })
    );

    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "📖 阅读设计" }));
    expect(await screen.findByText("正在加载技术设计正文...")).toBeInTheDocument();

    await act(async () => {
      resolveLoading(buildDocumentDetail({ id: "doc-loading", path: "docs/loading.md" }));
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));

    vi.mocked(consoleApi.fetchRequirementDetail).mockResolvedValue(
      buildRequirement({ planDocPath: "docs/missing.md" })
    );
    useProjectStore.setState({ documents: [] });
    window.dispatchEvent(new Event("focus"));
    await screen.findByText("docs/missing.md");
    fireEvent.click(screen.getByRole("button", { name: "📖 阅读设计" }));
    expect(await screen.findByText("技术设计文档尚未进入文档索引")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));

    vi.mocked(consoleApi.fetchRequirementDetail).mockResolvedValue(
      buildRequirement({ planDocPath: "docs/stale.md" })
    );
    useProjectStore.setState({ documents: [buildDocument({ id: "doc-stale", path: "docs/stale.md" })] });
    vi.mocked(consoleApi.fetchDocumentDetail).mockResolvedValueOnce(
      buildDocumentDetail({ id: "doc-stale", path: "docs/other.md" })
    );
    window.dispatchEvent(new Event("focus"));
    await screen.findByText("docs/stale.md");
    fireEvent.click(screen.getByRole("button", { name: "📖 阅读设计" }));
    expect(await screen.findByText("文档索引已过期")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));

    vi.mocked(consoleApi.fetchRequirementDetail).mockResolvedValue(
      buildRequirement({ planDocPath: "docs/not-found.md" })
    );
    useProjectStore.setState({ documents: [buildDocument({ id: "doc-404", path: "docs/not-found.md" })] });
    vi.mocked(consoleApi.fetchDocumentDetail).mockRejectedValueOnce(
      new consoleApi.ConsoleApiError("Not Found", 404)
    );
    window.dispatchEvent(new Event("focus"));
    await screen.findByText("docs/not-found.md");
    fireEvent.click(screen.getByRole("button", { name: "📖 阅读设计" }));
    expect(await screen.findByText("技术设计文档不存在或已被删除")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));

    vi.mocked(consoleApi.fetchRequirementDetail).mockResolvedValue(
      buildRequirement({ planDocPath: "docs/error.md" })
    );
    useProjectStore.setState({ documents: [buildDocument({ id: "doc-error", path: "docs/error.md" })] });
    vi.mocked(consoleApi.fetchDocumentDetail).mockRejectedValueOnce(new Error("网络失败"));
    window.dispatchEvent(new Event("focus"));
    await screen.findByText("docs/error.md");
    fireEvent.click(screen.getByRole("button", { name: "📖 阅读设计" }));
    expect(await screen.findByText("读取技术设计文档失败：网络失败")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));

    vi.mocked(consoleApi.fetchRequirementDetail).mockResolvedValue(
      buildRequirement({ planDocPath: "docs/empty.md" })
    );
    useProjectStore.setState({ documents: [buildDocument({ id: "doc-empty", path: "docs/empty.md" })] });
    vi.mocked(consoleApi.fetchDocumentDetail).mockResolvedValueOnce(
      buildDocumentDetail({ id: "doc-empty", path: "docs/empty.md", content: "---\ntitle: only meta\n---\n" })
    );
    window.dispatchEvent(new Event("focus"));
    await screen.findByText("docs/empty.md");
    fireEvent.click(screen.getByRole("button", { name: "📖 阅读设计" }));
    expect(await screen.findByText("技术设计文档正文为空")).toBeInTheDocument();
  });

  it("drops late design document responses after the drawer target changes", async () => {
    let resolveOld!: (value: DocumentDetailView) => void;
    let resolveNew!: (value: DocumentDetailView) => void;
    useProjectStore.setState({
      documents: [
        buildDocument({ id: "doc-old", path: "docs/old.md" }),
        buildDocument({ id: "doc-new", path: "docs/new.md" })
      ]
    });
    vi.mocked(consoleApi.fetchRequirementDetail)
      .mockResolvedValueOnce(buildRequirement({ planDocPath: "docs/old.md" }))
      .mockResolvedValue(buildRequirement({ planDocPath: "docs/new.md" }));
    vi.mocked(consoleApi.fetchDocumentDetail).mockImplementation((documentId: string) => {
      if (documentId === "doc-old") {
        return new Promise((resolve) => {
          resolveOld = resolve;
        });
      }
      return new Promise((resolve) => {
        resolveNew = resolve;
      });
    });

    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "📖 阅读设计" }));
    expect(consoleApi.fetchDocumentDetail).toHaveBeenCalledWith("doc-old");

    window.dispatchEvent(new Event("focus"));
    await screen.findByText("docs/new.md");
    expect(consoleApi.fetchDocumentDetail).toHaveBeenCalledWith("doc-new");

    await act(async () => {
      resolveNew(buildDocumentDetail({ id: "doc-new", path: "docs/new.md", content: "# 新设计正文" }));
      await Promise.resolve();
    });
    expect(await screen.findByRole("heading", { name: "新设计正文" })).toBeInTheDocument();

    await act(async () => {
      resolveOld(buildDocumentDetail({ id: "doc-old", path: "docs/old.md", content: "# 旧设计正文" }));
      await Promise.resolve();
    });

    expect(screen.queryByRole("heading", { name: "旧设计正文" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "新设计正文" })).toBeInTheDocument();
  });

  it("dispatches the analysis step and keeps the artifact action queued until dispatch submitted event", async () => {
    vi.mocked(consoleApi.fetchRequirementDetail).mockResolvedValue(
      buildRequirement({
        status: "planning",
        currentPlanningStep: "analysis",
        planningRuntimeState: "idle",
        planningAnchorId: null
      })
    );
    vi.mocked(consoleApi.startRequirementPlanningAnchor).mockResolvedValue({
      anchorId: "anchor-req-1",
      anchorPath: "/repo/SU-CCB-requirement-req-1",
      socketPath: "/repo/SU-CCB-requirement-req-1/.ccb/ccbd/ccbd.sock",
      status: "ready"
    });
    vi.mocked(consoleApi.dispatchRequirementAnchorCommand).mockResolvedValue({
      jobId: "job_su_flow_analysis",
      anchorId: "anchor-req-1",
      subjectId: "req-1",
      requirementId: "req-1",
      status: "queued",
      queuedAt: "2026-05-20T00:00:00.000Z"
    });

    renderPage();

    const aiCard = await screen.findByTestId("artifact-ai-analysis");
    fireEvent.click(within(aiCard).getByRole("button", { name: "重新解析" }));

    await act(async () => {
      await Promise.resolve();
    });

    expect(consoleApi.startRequirementPlanningAnchor).toHaveBeenCalledWith("project-1", "req-1");
    expect(consoleApi.dispatchRequirementAnchorCommand).toHaveBeenCalledWith("project-1", "req-1", {
      command: "su-flow",
      payload: { step: "analysis" }
    });
    expect(within(aiCard).getByRole("button", { name: "派出中..." })).toBeDisabled();
    expect(useUIStore.getState().toasts.at(-1)?.message).toContain("已排队");

    vi.mocked(consoleApi.fetchEventJournalEvents).mockResolvedValue({
      items: [
        {
          eventId: "event-dispatch-submitted",
          eventType: "anchor_dispatch_submitted",
          subjectType: "requirement",
          subjectId: "req-1",
          payload: {
            jobId: "job_su_flow_analysis",
            readinessWarning: false
          },
          emittedAt: "2026-05-20T00:00:03.000Z"
        }
      ],
      pageInfo: { limit: 20, offset: 0, count: 1 }
    });

    window.dispatchEvent(new Event("focus"));
    await act(async () => {
      await Promise.resolve();
    });

    expect(consoleApi.fetchEventJournalEvents).toHaveBeenCalledWith({
      subjectType: "requirement",
      subjectId: "req-1",
      limit: 20
    });
    expect(within(aiCard).getByRole("button", { name: "重新解析" })).not.toBeDisabled();
    expect(useUIStore.getState().toasts.at(-1)?.message).toContain("已派出");
  });

  it("shows lifecycle actions with status and runtime constraints", async () => {
    vi.mocked(consoleApi.fetchRequirementDetail).mockResolvedValue(
      buildRequirement({
        status: "delivered",
        planningRuntimeState: "paused",
        planningAnchorId: "anchor-req-1"
      })
    );

    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "更多操作" }));

    const menu = screen.getByRole("menu", { name: "需求生命周期操作" });
    expect(within(menu).getByRole("menuitem", { name: "恢复运行时" })).not.toBeDisabled();
    expect(within(menu).getByRole("menuitem", { name: "暂缓" })).toBeDisabled();
    expect(within(menu).getByRole("menuitem", { name: "复活" })).toBeDisabled();
    expect(within(menu).getByRole("menuitem", { name: "归档" })).not.toBeDisabled();
    expect(within(menu).getByRole("menuitem", { name: "取消" })).toBeDisabled();
    expect(within(menu).getByRole("menuitem", { name: "暂缓" })).toHaveAttribute(
      "title",
      "仅 drafting / planning / delivering 状态可暂缓"
    );
  });

  it.each([
    {
      label: "恢复运行时",
      command: "su-resume",
      requirement: buildRequirement({ status: "planning", planningRuntimeState: "paused", planningAnchorId: "anchor-req-1" })
    },
    {
      label: "暂缓",
      command: "su-defer",
      requirement: buildRequirement({ status: "planning", planningRuntimeState: "running", planningAnchorId: "anchor-req-1" })
    },
    {
      label: "复活",
      command: "su-reactivate",
      requirement: buildRequirement({ status: "deferred", planningRuntimeState: "idle", planningAnchorId: "anchor-req-1" })
    },
    {
      label: "归档",
      command: "su-archive",
      dialog: "确认归档需求",
      confirm: "确认归档",
      requirement: buildRequirement({ status: "delivered", planningRuntimeState: "running", planningAnchorId: "anchor-req-1" })
    },
    {
      label: "取消",
      command: "su-cancel",
      dialog: "确认取消需求",
      confirm: "确认取消",
      requirement: buildRequirement({ status: "planning", planningRuntimeState: "running", planningAnchorId: "anchor-req-1" })
    }
  ])("dispatches lifecycle command $command from the actions menu", async ({ label, command, dialog, confirm, requirement }) => {
    vi.mocked(consoleApi.fetchRequirementDetail).mockResolvedValue(requirement);
    vi.mocked(consoleApi.dispatchRequirementAnchorCommand).mockResolvedValue({
      jobId: `job_${command.replace("su-", "")}`,
      anchorId: "anchor-req-1",
      subjectId: "req-1",
      requirementId: "req-1",
      status: "queued",
      queuedAt: "2026-05-20T00:00:00.000Z"
    });

    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "更多操作" }));
    fireEvent.click(within(screen.getByRole("menu", { name: "需求生命周期操作" })).getByRole("menuitem", { name: label }));

    if (dialog && confirm) {
      expect(await screen.findByRole("dialog", { name: dialog })).toBeInTheDocument();
      expect(consoleApi.dispatchRequirementAnchorCommand).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: confirm }));
    } else {
      expect(screen.queryByRole("dialog")).toBeNull();
    }

    await act(async () => {
      await Promise.resolve();
    });

    expect(consoleApi.startRequirementPlanningAnchor).not.toHaveBeenCalled();
    expect(consoleApi.dispatchRequirementAnchorCommand).toHaveBeenCalledWith("project-1", "req-1", {
      command,
      payload: {}
    });
    expect(useUIStore.getState().toasts.at(-1)?.message).toContain(`已排队 /ccb:${command}`);
    expect(screen.getByRole("menuitem", { name: "派出中..." })).toBeDisabled();
  });

  it("opens the subtask batch dispatch modal with eligible items selected and ineligible items disabled", async () => {
    vi.mocked(consoleApi.fetchRequirementDetail).mockResolvedValue(buildRequirement({ status: "delivering" }));
    vi.mocked(consoleApi.fetchTasks).mockResolvedValue([
      buildSubtask({ id: "task-1", title: "第一个子任务" }),
      buildSubtask({ id: "task-2", title: "第二个子任务", currentNode: "implementation", progress: 40 })
    ]);
    vi.mocked(consoleApi.fetchSubtaskBatchCandidates).mockResolvedValue({
      candidates: [
        buildBatchCandidate({ taskId: "task-1", title: "第一个子任务", eligible: true }),
        buildBatchCandidate({
          taskId: "task-2",
          taskKey: "CCB-2",
          title: "第二个子任务",
          currentNode: "implementation",
          eligible: false,
          ineligibleReason: "子任务不在 dispatch 节点"
        })
      ]
    });

    renderPage();

    const button = await screen.findByRole("button", { name: "批量推进 1 个子任务" });
    fireEvent.click(button);

    const dialog = await screen.findByRole("dialog", { name: "批量推进子任务" });
    expect(within(dialog).getByText("以下子任务将交给同一个 slot 的 su-batch 自驱编排")).toBeInTheDocument();
    expect(
      within(dialog).getByText('/ccb:su-batch --payload {"scope":"subtasks","task_ids":[...]}')
    ).toBeInTheDocument();
    expect(within(dialog).getByLabelText("第一个子任务")).toBeChecked();
    expect(within(dialog).getByLabelText("第二个子任务")).toBeDisabled();
    expect(within(dialog).getByText("子任务不在 dispatch 节点")).toBeInTheDocument();
    expect(within(dialog).getByText("将派出 1 个")).toBeInTheDocument();
  });

  it("batch dispatches selected subtasks as one su-batch coordinator job", async () => {
    vi.mocked(consoleApi.fetchRequirementDetail).mockResolvedValue(buildRequirement({ status: "delivering" }));
    vi.mocked(consoleApi.fetchTasks).mockResolvedValue([
      buildSubtask({ id: "task-1", title: "第一个子任务" }),
      buildSubtask({ id: "task-2", title: "第二个子任务" })
    ]);
    vi.mocked(consoleApi.fetchSubtaskBatchCandidates).mockResolvedValue({
      candidates: [
        buildBatchCandidate({ taskId: "task-1", title: "第一个子任务", eligible: true }),
        buildBatchCandidate({ taskId: "task-2", taskKey: "CCB-2", title: "第二个子任务", eligible: true })
      ]
    });
    vi.mocked(consoleApi.batchDispatchSubtasks).mockResolvedValue({
      jobId: "job_batch_1",
      command: "su-batch",
      slotId: "slot-1",
      status: "queued",
      taskIds: ["task-1", "task-2"],
      totalQueued: 1,
      totalFailed: 0,
      items: []
    });

    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "批量推进 2 个子任务" }));
    const dialog = await screen.findByRole("dialog", { name: "批量推进子任务" });
    fireEvent.click(within(dialog).getByRole("button", { name: "确认批量派出" }));

    await act(async () => {
      await Promise.resolve();
    });

    expect(consoleApi.batchDispatchSubtasks).toHaveBeenCalledWith("project-1", "req-1", {
      taskIds: ["task-1", "task-2"],
      step: "execution"
    });
    expect(useUIStore.getState().toasts.at(-1)?.message).toContain("已派出 1 条 su-batch，覆盖 2 个子任务");

    vi.mocked(consoleApi.fetchEventJournalEvents)
      .mockResolvedValueOnce({
        items: [],
        pageInfo: { limit: 20, offset: 0, count: 0 }
      })
      .mockResolvedValueOnce({
        items: [
          {
            eventId: "event-task-1-submitted",
            eventType: "anchor_dispatch_submitted",
            subjectType: "subtask",
            subjectId: "task-1",
            payload: { jobId: "job_task_1" },
            emittedAt: "2026-05-20T00:00:03.000Z"
          }
        ],
        pageInfo: { limit: 20, offset: 0, count: 1 }
      })
      .mockResolvedValueOnce({
        items: [
          {
            eventId: "event-task-2-submitted",
            eventType: "anchor_dispatch_submitted",
            subjectType: "subtask",
            subjectId: "task-2",
            payload: { jobId: "job_task_2" },
            emittedAt: "2026-05-20T00:00:04.000Z"
          }
        ],
        pageInfo: { limit: 20, offset: 0, count: 1 }
      });

    window.dispatchEvent(new Event("focus"));
    await act(async () => {
      await Promise.resolve();
    });

    expect(consoleApi.fetchEventJournalEvents).not.toHaveBeenCalledWith({
      subjectType: "subtask",
      subjectId: "task-1",
      limit: 20
    });
    expect(consoleApi.fetchEventJournalEvents).not.toHaveBeenCalledWith({
      subjectType: "subtask",
      subjectId: "task-2",
      limit: 20
    });
  });

  it("disables subtask batch dispatch when there is no eligible candidate", async () => {
    vi.mocked(consoleApi.fetchRequirementDetail).mockResolvedValue(buildRequirement({ status: "delivering" }));
    vi.mocked(consoleApi.fetchTasks).mockResolvedValue([
      buildSubtask({ id: "task-1", title: "已实施子任务", currentNode: "implementation" })
    ]);
    vi.mocked(consoleApi.fetchSubtaskBatchCandidates).mockResolvedValue({
      candidates: [
        buildBatchCandidate({
          taskId: "task-1",
          title: "已实施子任务",
          currentNode: "implementation",
          eligible: false,
          ineligibleReason: "子任务不在 dispatch 节点"
        })
      ]
    });

    renderPage();

    const button = await screen.findByRole("button", { name: "批量推进 0 个子任务" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "暂无可派工子任务");
  });

  it("reindexes immediately, polls every 10s, and cleans up timer and listeners on unmount", async () => {
    vi.useFakeTimers();
    vi.mocked(consoleApi.fetchRequirementDetail).mockResolvedValue(buildRequirement());

    const { unmount } = renderPage();

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByTestId("requirement-detail-workspace")).toBeInTheDocument();
    expect(consoleApi.reindexRequirement).toHaveBeenCalledTimes(1);
    expect(consoleApi.fetchRequirementDetail).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(10_000);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(consoleApi.reindexRequirement).toHaveBeenCalledTimes(2);
    expect(consoleApi.fetchRequirementDetail).toHaveBeenCalledTimes(2);

    unmount();

    await act(async () => {
      vi.advanceTimersByTime(10_000);
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });

    expect(consoleApi.reindexRequirement).toHaveBeenCalledTimes(2);
    expect(consoleApi.fetchRequirementDetail).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("pauses requirement reindex polling while the page is hidden and resumes when visible", async () => {
    vi.useFakeTimers();
    let visibilityState: DocumentVisibilityState = "visible";
    const visibilitySpy = vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibilityState);
    vi.mocked(consoleApi.fetchRequirementDetail).mockResolvedValue(buildRequirement());

    renderPage();

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(consoleApi.reindexRequirement).toHaveBeenCalledTimes(1);

    visibilityState = "hidden";
    await act(async () => {
      vi.advanceTimersByTime(10_000);
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });
    expect(consoleApi.reindexRequirement).toHaveBeenCalledTimes(1);

    visibilityState = "visible";
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(consoleApi.reindexRequirement).toHaveBeenCalledTimes(2);

    visibilitySpy.mockRestore();
    vi.useRealTimers();
  });

  it("reindexes on visible tab and focus without stacking in-flight requests", async () => {
    vi.useFakeTimers();
    const visibilitySpy = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    let resolveInitialReindex!: () => void;
    const initialReindex = new Promise<Awaited<ReturnType<typeof consoleApi.reindexRequirement>>>((resolve) => {
      resolveInitialReindex = () =>
        resolve({
          reindexed: true,
          deduped: false,
          status: "success",
          projectId: "project-1",
          requirementId: "req-1",
          issues: []
        });
    });
    vi.mocked(consoleApi.reindexRequirement)
      .mockReturnValueOnce(initialReindex)
      .mockResolvedValue({
        reindexed: true,
        deduped: false,
        status: "success",
        projectId: "project-1",
        requirementId: "req-1",
        issues: []
      });
    vi.mocked(consoleApi.fetchRequirementDetail).mockResolvedValue(buildRequirement({ title: "刷新后的需求" }));

    renderPage();

    expect(consoleApi.reindexRequirement).toHaveBeenCalledTimes(1);
    expect(consoleApi.fetchRequirementDetail).toHaveBeenCalledTimes(0);

    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("focus"));
      vi.advanceTimersByTime(10_000);
    });

    expect(consoleApi.reindexRequirement).toHaveBeenCalledTimes(1);
    expect(consoleApi.fetchRequirementDetail).toHaveBeenCalledTimes(0);

    await act(async () => {
      resolveInitialReindex();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByTestId("requirement-detail-workspace")).toBeInTheDocument();
    expect(consoleApi.fetchRequirementDetail).toHaveBeenCalledTimes(1);

    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(consoleApi.reindexRequirement).toHaveBeenCalledTimes(2);
    expect(consoleApi.fetchRequirementDetail).toHaveBeenCalledTimes(2);

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(consoleApi.reindexRequirement).toHaveBeenCalledTimes(3);
    expect(consoleApi.fetchRequirementDetail).toHaveBeenCalledTimes(3);

    visibilitySpy.mockRestore();
    vi.useRealTimers();
  });
});
