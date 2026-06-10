import { render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RequirementView } from "../types/requirement.js";
vi.mock("../lib/console-api.js", () => ({
  refreshProjectRequirementStatus: vi.fn().mockResolvedValue({ updated: 0, checked: 0 }),
  refreshRequirementStatus: vi.fn().mockResolvedValue({ updated: false, oldStatus: null, newStatus: null })
}));

import { MemoryRouter } from "react-router";

import { RequirementsPage } from "../pages/requirements/RequirementsPage.js";
import { useProjectStore } from "../stores/project-store.js";
import { useUIStore } from "../stores/ui-store.js";

const baseRequirement = (overrides: Partial<RequirementView>): RequirementView => ({
  id: "req-x",
  projectId: "project-1",
  title: "需求 X",
  description: "描述",
  status: "drafting",
  source: "manual",
  outputMode: "requirement_only",
  generatedTaskId: null,
  verbatimSource: "原话",
  claudeInterpretation: null,
  ambiguities: null,
  fidelityDiff: null,
  analysisInputHash: null,
  analysisStaleAt: null,
  createdAt: "2026-05-10T00:00:00.000Z",
  updatedAt: "2026-05-10T00:00:00.000Z",
  ...overrides
});

const FIXTURES: RequirementView[] = [
  baseRequirement({ id: "req-draft", title: "草稿需求", status: "drafting" }),
  baseRequirement({ id: "req-planning", title: "计划中需求", status: "planning" }),
  baseRequirement({ id: "req-delivering", title: "推进中需求", status: "delivering" }),
  baseRequirement({
    id: "req-delivering-2",
    title: "推进中需求 2",
    status: "delivering",
    generatedTaskId: "task-1"
  }),
  baseRequirement({ id: "req-delivered", title: "已交付需求", status: "delivered" }),
  baseRequirement({ id: "req-cancelled", title: "已取消需求", status: "cancelled" }),
  baseRequirement({ id: "req-unknown", title: "未知 status 需求", status: "future_state" })
];

function renderPage() {
  return render(
    <MemoryRouter>
      <RequirementsPage />
    </MemoryRouter>
  );
}

/** 按 data-column 定位看板列，列内断言用 within 收敛，避免列标题与中文徽章文案撞名。 */
function column(container: HTMLElement, key: string): HTMLElement {
  const section = container.querySelector<HTMLElement>(`[data-column="${key}"]`);
  if (!section) throw new Error(`找不到看板列 data-column="${key}"`);
  return section;
}

describe("RequirementsPage 看板", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    useProjectStore.setState({
      selectedProjectId: "project-1",
      requirements: FIXTURES,
      loadingData: false
    });
    useUIStore.setState({ toasts: [] });
  });

  afterEach(() => {
    warnSpy.mockRestore();
    useProjectStore.setState({ requirements: [], selectedProjectId: null });
  });

  it("渲染 5 个生命周期列，所有需求同时可见（不再需要切 tab）", () => {
    const { container } = renderPage();

    expect(column(container, "pending")).toBeTruthy();
    expect(column(container, "planning")).toBeTruthy();
    expect(column(container, "delivering")).toBeTruthy();
    expect(column(container, "delivered")).toBeTruthy();
    expect(column(container, "archived")).toBeTruthy();

    // 旧 UI 一次只显示一个 tab；看板下全部需求同时渲染
    expect(screen.getByText("草稿需求")).toBeTruthy();
    expect(screen.getByText("计划中需求")).toBeTruthy();
    expect(screen.getByText("推进中需求")).toBeTruthy();
    expect(screen.getByText("推进中需求 2")).toBeTruthy();
    expect(screen.getByText("已交付需求")).toBeTruthy();
    expect(screen.getByText("已取消需求")).toBeTruthy();
    expect(screen.getByText("未知 status 需求")).toBeTruthy();
  });

  it("卡片按 classifyRequirementTab 归桶：待处理1 / 规划中1 / 推进中2 / 已交付1 / 已搁置2", () => {
    const { container } = renderPage();

    expect(within(column(container, "pending")).getAllByRole("link")).toHaveLength(1);
    expect(within(column(container, "planning")).getAllByRole("link")).toHaveLength(1);
    expect(within(column(container, "delivering")).getAllByRole("link")).toHaveLength(2);
    expect(within(column(container, "delivered")).getAllByRole("link")).toHaveLength(1);
    expect(within(column(container, "archived")).getAllByRole("link")).toHaveLength(2);
  });

  it("cancelled 与未知 status 落到已搁置列，不丢失", () => {
    const { container } = renderPage();
    const archived = column(container, "archived");

    expect(within(archived).getByText("已取消需求")).toBeTruthy();
    expect(within(archived).getByText("未知 status 需求")).toBeTruthy();
  });

  it("卡片前进操作按状态区分；cancelled 卡片无前进操作（整卡仍可点开详情）", () => {
    const { container } = renderPage();

    expect(within(column(container, "pending")).getByText(/开始分析/)).toBeTruthy();
    expect(within(column(container, "planning")).getByText(/继续设计/)).toBeTruthy();
    expect(within(column(container, "delivering")).getAllByText(/查看子任务/)).toHaveLength(2);

    // cancelled/deferred（getRequirementAction kind=archived）无前进操作文案；
    // 未知 status 仍兜底为“查看详情”，所以断言收敛到 cancelled 卡片本身。
    const cancelledCard = screen.getByText("已取消需求").closest("[role='link']");
    expect(cancelledCard).toBeTruthy();
    expect(within(cancelledCard as HTMLElement).queryByText(/→/)).toBeNull();
  });

  it("空列显示 暂无需求 占位", () => {
    useProjectStore.setState({
      requirements: [baseRequirement({ id: "only-draft", status: "drafting", title: "唯一草稿" })]
    });
    const { container } = renderPage();

    expect(within(column(container, "pending")).getByText("唯一草稿")).toBeTruthy();
    expect(within(column(container, "planning")).getByText("暂无需求")).toBeTruthy();
    expect(within(column(container, "delivering")).getByText("暂无需求")).toBeTruthy();
    expect(within(column(container, "delivered")).getByText("暂无需求")).toBeTruthy();
    expect(within(column(container, "archived")).getByText("暂无需求")).toBeTruthy();
  });

  it("已搁置列改名生效、视觉降权 muted，且每列都有滚动内容区", () => {
    const { container } = renderPage();

    // 改名：archived 列标题为「已搁置」，不再出现旧词「已归档」
    const archived = column(container, "archived");
    expect(within(archived).getByText("已搁置")).toBeTruthy();
    expect(within(archived).queryByText("已归档")).toBeNull();

    // muted：archived 列 data-archived=true（走 column.muted，不绑 key 字符串），其余列无该标记
    expect(archived.getAttribute("data-archived")).toBe("true");
    for (const key of ["pending", "planning", "delivering", "delivered"]) {
      expect(column(container, key).getAttribute("data-archived")).toBeNull();
    }

    // 列内滚动容器存在：真实滚动 happy-dom 测不到，仅断言每列 .columnBody 结构在位（行为见浏览器/视觉验证）
    for (const key of ["pending", "planning", "delivering", "delivered", "archived"]) {
      expect(column(container, key).querySelector('[class*="columnBody"]')).toBeTruthy();
    }
  });
});

describe("RequirementsPage 状态徽章", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    useProjectStore.setState({
      selectedProjectId: "project-1",
      loadingData: false
    });
    useUIStore.setState({ toasts: [] });
  });

  afterEach(() => {
    useProjectStore.setState({ requirements: [], selectedProjectId: null });
  });

  it("delivering 卡片徽章显示中文 推进中，不再显示英文原文", () => {
    useProjectStore.setState({
      requirements: [baseRequirement({ id: "req-d", status: "delivering", title: "T" })]
    });
    renderPage();

    const card = screen.getByText("T").closest("[role='link']");
    expect(card).toBeTruthy();
    expect(within(card as HTMLElement).getByText("推进中")).toBeTruthy();
    expect(screen.queryByText("delivering")).toBeNull();
  });

  it("legacy converted 数据：前端未识别时兜底归已归档列，不崩溃不丢失", () => {
    useProjectStore.setState({
      requirements: [
        baseRequirement({
          id: "req-stale",
          status: "converted",
          title: "Stale legacy",
          generatedTaskId: "task-1"
        })
      ]
    });
    const { container } = renderPage();

    expect(within(column(container, "archived")).getByText("Stale legacy")).toBeTruthy();
  });
});
