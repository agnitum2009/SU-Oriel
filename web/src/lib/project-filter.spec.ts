import { describe, expect, it } from "vitest";

import type { ProjectView } from "../types/project.js";
import { computeVisibleProjects, filterProjects, projectStatusTone } from "./project-filter.js";

function project(id: string, name: string, localPath: string, overrides: Partial<ProjectView> = {}): ProjectView {
  return {
    id,
    name,
    localPath,
    summary: null,
    initStatus: "initialized",
    syncStatus: "idle",
    lastScanAt: null,
    ...overrides
  };
}

const projects = [
  project("a", "Alpha", "/home/dev/alpha"),
  project("b", "Beta", "/home/dev/beta"),
  project("c", "Gamma", "/srv/GAMMA")
];

describe("filterProjects", () => {
  it("returns all projects when keyword is empty or whitespace", () => {
    expect(filterProjects(projects, "")).toHaveLength(3);
    expect(filterProjects(projects, "   ")).toHaveLength(3);
  });

  it("matches project name case-insensitively", () => {
    expect(filterProjects(projects, "alpha").map((p) => p.id)).toEqual(["a"]);
    expect(filterProjects(projects, "BETA").map((p) => p.id)).toEqual(["b"]);
  });

  it("matches local path case-insensitively and trims keyword", () => {
    expect(filterProjects(projects, "  gamma  ").map((p) => p.id)).toEqual(["c"]);
    expect(filterProjects(projects, "/home/dev").map((p) => p.id)).toEqual(["a", "b"]);
  });
});

describe("computeVisibleProjects", () => {
  const many = Array.from({ length: 10 }, (_, i) => project(`p${i}`, `P${i}`, `/p/${i}`));

  it("shows all when count <= maxVisible (no overflow)", () => {
    const { visible, overflow } = computeVisibleProjects(many.slice(0, 4), "p0", 6);
    expect(visible).toHaveLength(4);
    expect(overflow).toHaveLength(0);
  });

  it("keeps first N visible when current is already in head", () => {
    const { visible, overflow } = computeVisibleProjects(many, "p2", 6);
    expect(visible.map((p) => p.id)).toEqual(["p0", "p1", "p2", "p3", "p4", "p5"]);
    expect(overflow).toHaveLength(4);
  });

  it("pins current to last visible slot when it falls in overflow, without duplication", () => {
    const { visible, overflow } = computeVisibleProjects(many, "p8", 6);
    expect(visible.map((p) => p.id)).toEqual(["p0", "p1", "p2", "p3", "p4", "p8"]);
    // no duplicate of current
    expect(visible.filter((p) => p.id === "p8")).toHaveLength(1);
    // overflow count stays total - maxVisible (pin does not distort the "更多" count)
    expect(overflow).toHaveLength(4);
    expect(overflow.map((p) => p.id)).not.toContain("p8");
    expect(overflow.map((p) => p.id)).toContain("p5");
  });

  it("falls back to head when there is no selection", () => {
    const { visible, overflow } = computeVisibleProjects(many, null, 6);
    expect(visible.map((p) => p.id)).toEqual(["p0", "p1", "p2", "p3", "p4", "p5"]);
    expect(overflow).toHaveLength(4);
  });
});

describe("projectStatusTone", () => {
  it("returns null for healthy projects", () => {
    expect(projectStatusTone(project("a", "A", "/a"))).toBeNull();
  });
  it("returns error for init error or sync failure", () => {
    expect(projectStatusTone(project("a", "A", "/a", { initStatus: "error" }))).toBe("error");
    expect(projectStatusTone(project("a", "A", "/a", { syncStatus: "failed" }))).toBe("error");
  });
  it("returns busy while running or scanning", () => {
    expect(projectStatusTone(project("a", "A", "/a", { syncStatus: "scanning" }))).toBe("busy");
  });
  it("returns idle when not initialized", () => {
    expect(projectStatusTone(project("a", "A", "/a", { initStatus: "not_initialized" }))).toBe("idle");
  });
});
