import { describe, expect, it } from "vitest";

import type { AttentionItem } from "./console-api.js";
import { buildAttentionNavigatePath } from "./attention-navigation.js";

function item(overrides: Partial<AttentionItem>): AttentionItem {
  const projectId = overrides.projectId ?? "p1";
  return {
    ref: overrides.ref ?? "review_intent:1",
    kind: overrides.kind ?? "review_intent",
    source: overrides.source ?? "review_intent",
    severity: overrides.severity ?? "attention",
    subjectType: overrides.subjectType ?? "project",
    projectId,
    requirementId: overrides.requirementId ?? null,
    taskId: overrides.taskId ?? null,
    taskKey: overrides.taskKey ?? null,
    slotId: overrides.slotId ?? null,
    title: overrides.title ?? "需要处理",
    summary: overrides.summary ?? "有一条新的 attention",
    createdAt: overrides.createdAt ?? "2026-06-06T12:00:00.000Z",
    updatedAt: overrides.updatedAt ?? null,
    cta: overrides.cta ?? {
      type: "project",
      label: "打开项目",
      projectId
    },
    metadata: overrides.metadata
  };
}

describe("buildAttentionNavigatePath", () => {
  it("task cta 导航到任务详情", () => {
    expect(
      buildAttentionNavigatePath(
        item({
          taskId: "task-1",
          cta: { type: "task", label: "打开任务", projectId: "p1", taskId: "task-1" }
        })
      )
    ).toBe("/projects/p1/tasks/task-1");
  });

  it("requirement cta 导航到需求详情", () => {
    expect(
      buildAttentionNavigatePath(
        item({
          requirementId: "req-1",
          cta: { type: "requirement", label: "打开需求", projectId: "p1", requirementId: "req-1" }
        })
      )
    ).toBe("/projects/p1/requirements/req-1");
  });

  it("project cta 沿用 overview fallback", () => {
    expect(buildAttentionNavigatePath(item({ cta: { type: "project", label: "打开项目", projectId: "p1" } }))).toBe(
      "/projects/p1/overview"
    );
  });

  it("slot cta 沿用关联需求 fallback", () => {
    expect(
      buildAttentionNavigatePath(
        item({
          requirementId: "req-1",
          slotId: "slot-1",
          cta: { type: "slot", label: "打开槽位", projectId: "p1", requirementId: "req-1", slotId: "slot-1" }
        })
      )
    ).toBe("/projects/p1/requirements/req-1");
  });
});
