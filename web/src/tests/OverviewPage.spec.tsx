import { render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MemoryRouter } from "react-router";

import type { RequirementView } from "../types/requirement.js";
import { OverviewPage } from "../pages/overview/OverviewPage.js";
import { useProjectStore } from "../stores/project-store.js";
import { useUIStore } from "../stores/ui-store.js";

// 项目接入引导卡片会拉远端 onboarding 状态，与本用例无关；mock 成空节点，隔离活跃聚合逻辑。
vi.mock("../components/projects/ProjectOnboardingBanner.js", () => ({
  ProjectOnboardingBanner: () => null
}));

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

function renderPage() {
  return render(
    <MemoryRouter>
      <OverviewPage />
    </MemoryRouter>
  );
}

/** 活跃需求卡片：用唯一 subStatus 文案定位卡片容器，再在容器内断言计数值。 */
function activeCard(): HTMLElement {
  const subStatus = screen.getByText("待处理 + 规划中 + 推进中");
  const card = subStatus.parentElement;
  if (!card) throw new Error("找不到活跃需求卡片");
  return card;
}

describe("OverviewPage 活跃需求聚合（含 planning，防静默漏算）", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    useProjectStore.setState({
      selectedProjectId: "project-1",
      requirements: [],
      tasks: [],
      documents: [],
      syncJobs: [],
      indexHealth: null,
      loadingData: false,
      // 概览数据盘现需接入就绪才渲染(未就绪走整页引导);本用例聚焦活跃聚合,故置就绪态。
      onboardingByProject: {
        "project-1": {
          value: {
            projectId: "project-1",
            localPath: "/tmp/project-1",
            ccbRuntimeReady: true,
            knowledgeBaseReady: true,
            ccbConfigPath: "/tmp/project-1/.ccb/ccb.config",
            knowledgeBaseRootPath: "/tmp/project-1/docs/.ccb/index",
            manualCommand: "cd /tmp/project-1 && ccb",
            checkedAt: "2026-05-10T00:00:00.000Z"
          },
          fetchedAt: Date.now(),
          loading: false,
          error: null
        }
      }
    });
    useUIStore.setState({ toasts: [] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    useProjectStore.setState({ requirements: [], selectedProjectId: null });
  });

  it("活跃 = 待处理 + 规划中 + 推进中（drafting/planning/delivering 各计一，delivered/archived 不计）", () => {
    useProjectStore.setState({
      requirements: [
        baseRequirement({ id: "r-draft", status: "drafting" }),
        baseRequirement({ id: "r-planning", status: "planning" }),
        baseRequirement({ id: "r-delivering", status: "delivering" }),
        baseRequirement({ id: "r-delivered", status: "delivered" }),
        baseRequirement({ id: "r-cancelled", status: "cancelled" })
      ]
    });
    renderPage();

    expect(within(activeCard()).getByText("3")).toBeTruthy();
  });

  it("仅一条 planning 需求 → 活跃=1（头号回归点：planning 不得从首页活跃漏算）", () => {
    useProjectStore.setState({
      requirements: [baseRequirement({ id: "only-planning", status: "planning" })]
    });
    renderPage();

    expect(within(activeCard()).getByText("1")).toBeTruthy();
  });

  it("delivered / deferred / cancelled 不计入活跃（活跃=0）", () => {
    useProjectStore.setState({
      requirements: [
        baseRequirement({ id: "r-delivered", status: "delivered" }),
        baseRequirement({ id: "r-deferred", status: "deferred" }),
        baseRequirement({ id: "r-cancelled", status: "cancelled" })
      ]
    });
    renderPage();

    expect(within(activeCard()).getByText("0")).toBeTruthy();
  });
});
