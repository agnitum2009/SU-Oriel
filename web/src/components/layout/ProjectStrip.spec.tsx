import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ProjectView } from "../../types/project.js";
import { ProjectStrip } from "./ProjectStrip.js";

function project(id: string, name: string, overrides: Partial<ProjectView> = {}): ProjectView {
  return {
    id,
    name,
    localPath: `/dev/${id}`,
    summary: null,
    initStatus: "initialized",
    syncStatus: "idle",
    lastScanAt: null,
    ...overrides
  };
}

const three = [project("a", "Alpha"), project("b", "Beta"), project("c", "Gamma")];
const ten = Array.from({ length: 10 }, (_, i) => project(`p${i}`, `Proj${i}`));

function setup(overrides: Partial<Parameters<typeof ProjectStrip>[0]> = {}) {
  const onSelectProject = vi.fn();
  const onCreateProject = vi.fn();
  render(
    <ProjectStrip
      loading={false}
      onCreateProject={onCreateProject}
      onSelectProject={onSelectProject}
      projects={three}
      selectedProjectId="b"
      {...overrides}
    />
  );
  return { onSelectProject, onCreateProject };
}

describe("ProjectStrip", () => {
  it("renders the strip above the topbar as a project-switch nav region", () => {
    const { container } = render(
      <ProjectStrip loading={false} onCreateProject={() => {}} onSelectProject={() => {}} projects={three} selectedProjectId="b" />
    );
    expect(container.querySelector('[data-layout-region="project-strip"]')).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "项目切换" })).toBeInTheDocument();
  });

  it("renders a chip per project and marks the current one with aria-current", () => {
    setup();
    expect(screen.getByRole("button", { name: /Alpha/ })).toBeInTheDocument();
    const current = screen.getByRole("button", { name: /Beta/ });
    expect(current).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: /Alpha/ })).not.toHaveAttribute("aria-current");
  });

  it("switches via onSelectProject (never sets store directly)", () => {
    const { onSelectProject } = setup();
    fireEvent.click(screen.getByRole("button", { name: /Alpha/ }));
    expect(onSelectProject).toHaveBeenCalledWith("a");
  });

  it("triggers create from the tail button", () => {
    const { onCreateProject } = setup();
    fireEvent.click(screen.getByRole("button", { name: /新建项目/ }));
    expect(onCreateProject).toHaveBeenCalledTimes(1);
  });

  it("collapses extras into a 更多 popover that searches all projects and closes on Esc", () => {
    const { onSelectProject } = setup({ projects: ten, selectedProjectId: "p0" });
    // p0..p5 visible, 4 overflow
    expect(screen.queryByRole("button", { name: /^Proj8$/ })).not.toBeInTheDocument();
    const more = screen.getByRole("button", { name: /更多·4/ });
    fireEvent.click(more);
    const search = screen.getByLabelText("搜索项目");
    expect(search).toBeInTheDocument();
    fireEvent.change(search, { target: { value: "Proj8" } });
    const item = screen.getByRole("button", { name: /Proj8/ });
    fireEvent.click(item);
    expect(onSelectProject).toHaveBeenCalledWith("p8");
    // re-open and close via Esc
    fireEvent.click(screen.getByRole("button", { name: /更多·4/ }));
    fireEvent.keyDown(screen.getByLabelText("搜索项目"), { key: "Escape" });
    expect(screen.queryByLabelText("搜索项目")).not.toBeInTheDocument();
  });

  it("shows skeletons while loading and no project chips", () => {
    setup({ loading: true });
    expect(screen.queryByRole("button", { name: /Alpha/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /新建项目/ })).toBeInTheDocument();
  });

  it("shows empty hint and a primary create button when there are no projects", () => {
    setup({ projects: [], selectedProjectId: null });
    expect(screen.getByText("还没有项目")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /新建项目/ })).toHaveAttribute("data-emphasis", "primary");
  });
});
