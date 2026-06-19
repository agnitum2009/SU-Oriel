import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import { AppShell } from "./AppShell.js";

function renderShell(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppShell
        header={<div>项目概览 / SU-CCB</div>}
        sidebar={<nav>任务 文档 需求 设置</nav>}
        sidebarCollapsed={false}
      >
        <div>当前页面</div>
      </AppShell>
    </MemoryRouter>
  );
}

describe("AppShell v2 layout", () => {
  it("renders topbar / sidebar / main on any route; aside placeholder removed", () => {
    const { container } = renderShell("/tasks/task-1");

    expect(container.querySelector('[data-layout-region="topbar"]')).toBeInTheDocument();
    expect(container.querySelector('[data-layout-region="sidebar"]')).toBeInTheDocument();
    expect(container.querySelector('[data-layout-region="main"]')).toBeInTheDocument();
    // PR-12.6 移除全局占位 aside（每个详情页有自己的内部 sidebar）
    expect(container.querySelector('[data-layout-region="aside"]')).not.toBeInTheDocument();
  });

  it("preserves layout regions on non-detail routes", () => {
    const { container } = renderShell("/overview");

    expect(container.querySelector('[data-layout-region="topbar"]')).toBeInTheDocument();
    expect(container.querySelector('[data-layout-region="sidebar"]')).toBeInTheDocument();
    expect(container.querySelector('[data-layout-region="main"]')).toBeInTheDocument();
    expect(container.querySelector('[data-layout-region="aside"]')).not.toBeInTheDocument();
  });

  it("renders the projectStrip slot above the topbar (project = top-level band)", () => {
    const { container } = render(
      <MemoryRouter initialEntries={["/overview"]}>
        <AppShell
          header={<div>项目概览</div>}
          projectStrip={<div data-layout-region="project-strip">项目条</div>}
          sidebar={<nav>导航</nav>}
          sidebarCollapsed={false}
        >
          <div>当前页面</div>
        </AppShell>
      </MemoryRouter>
    );

    const strip = container.querySelector('[data-layout-region="project-strip"]');
    const topbar = container.querySelector('[data-layout-region="topbar"]');
    expect(strip).toBeInTheDocument();
    expect(topbar).toBeInTheDocument();
    // 项目条必须排在面包屑 topbar 之前（DOM 顺序）
    expect(strip!.compareDocumentPosition(topbar!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
