import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  classifyRequirementTab,
  getRequirementAction,
  getRequirementStatusBadge,
  isActiveRequirementTab
} from "../lib/ui-mapping.js";

describe("getRequirementStatusBadge", () => {
  it.each([
    ["draft", "草稿", "gray"],
    ["planning", "规划中", "blue"],
    ["delivering", "推进中", "orange"],
    ["delivered", "已交付", "green"],
    ["deferred", "已暂缓", "gray"],
    ["cancelled", "已取消", "red"]
  ] as const)("status=%s 映射到中文标签 %s 与颜色 %s", (status, label, color) => {
    expect(getRequirementStatusBadge(status)).toEqual({ label, color });
  });

  it("legacy converted（已废弃枚举）走未知分支：gray fallback + console.warn", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = getRequirementStatusBadge("converted");
    expect(result).toEqual({ label: "converted", color: "gray" });
    expect(warnSpy).toHaveBeenCalledWith("未知需求状态: converted");
    warnSpy.mockRestore();
  });

  describe("未知 status fallback", () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    });

    afterEach(() => {
      warnSpy.mockRestore();
    });

    it("回退到 gray 并保留原文", () => {
      const result = getRequirementStatusBadge("unknown_state");
      expect(result).toEqual({ label: "unknown_state", color: "gray" });
    });

    it("发出 console.warn 留痕", () => {
      getRequirementStatusBadge("future_state");
      expect(warnSpy).toHaveBeenCalledWith("未知需求状态: future_state");
    });
  });
});

describe("classifyRequirementTab", () => {
  it.each([
    ["drafting", "pending"],
    ["planning", "planning"],
    ["delivering", "delivering"],
    ["delivered", "delivered"],
    ["deferred", "archived"],
    ["cancelled", "archived"]
  ] as const)("status=%s 归到 %s tab", (status, expected) => {
    expect(classifyRequirementTab(status)).toBe(expected);
  });

  it("未知 / legacy converted status 兜底到 archived，避免数据从 UI 消失", () => {
    expect(classifyRequirementTab("legacy_unknown")).toBe("archived");
    expect(classifyRequirementTab("converted")).toBe("archived"); // 老数据未被 migration 命中时的兜底
    expect(classifyRequirementTab("")).toBe("archived");
  });
});

describe("isActiveRequirementTab", () => {
  it.each([
    ["pending", true],
    ["planning", true],
    ["delivering", true],
    ["delivered", false],
    ["archived", false]
  ] as const)("tab=%s → 活跃=%s（首页活跃口径含 planning）", (tab, expected) => {
    expect(isActiveRequirementTab(tab)).toBe(expected);
  });
});

describe("getRequirementAction", () => {
  it.each([
    ["drafting", "open-detail", "开始分析"],
    ["planning", "open-detail", "继续设计"]
  ] as const)("status=%s → %s 按钮", (status, kind, label) => {
    const action = getRequirementAction(status, null);
    expect(action.kind).toBe(kind);
    expect(action.label).toBe(label);
    expect(action.disabled).toBeUndefined();
  });

  it.each(["delivering", "delivered"] as const)(
    "status=%s → 打开详情",
    (status) => {
      const action = getRequirementAction(status, null);
      expect(action.kind).toBe("open-detail");
      expect(action.label).toBe(status === "delivering" ? "查看子任务" : "查看详情");
    }
  );

  it.each(["deferred", "cancelled"] as const)(
    "status=%s → 已搁置（disabled）",
    (status) => {
      const action = getRequirementAction(status, "task-id-anything");
      expect(action.kind).toBe("archived");
      expect(action.label).toBe("已搁置");
      expect(action.disabled).toBe(true);
    }
  );

  describe("未知 status 兜底", () => {
    it("有 generatedTaskId → 仍进入需求详情", () => {
      const action = getRequirementAction("legacy_unknown", "task-old-1");
      expect(action.kind).toBe("open-detail");
      expect(action.label).toBe("查看详情");
    });

    it("无 generatedTaskId → 仍进入需求详情", () => {
      const action = getRequirementAction("legacy_unknown", null);
      expect(action.kind).toBe("open-detail");
      expect(action.label).toBe("查看详情");
    });
  });
});
