import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AttentionAckResponse, AttentionItem, AttentionSettingsResponse } from "../../lib/console-api.js";
import { useUIStore } from "../../stores/ui-store.js";

vi.mock("../../lib/console-api.js", async () => {
  const actual = await vi.importActual<typeof import("../../lib/console-api.js")>("../../lib/console-api.js");
  return {
    ...actual,
    ackAttention: vi.fn(),
    fetchAttentionSettings: vi.fn(),
    updateAttentionSettings: vi.fn()
  };
});

vi.mock("../../lib/browser-notify.js", async () => {
  const actual = await vi.importActual<typeof import("../../lib/browser-notify.js")>("../../lib/browser-notify.js");
  return {
    ...actual,
    getBrowserNotificationPermission: vi.fn(() => "default")
  };
});

import { getBrowserNotificationPermission } from "../../lib/browser-notify.js";
import * as consoleApi from "../../lib/console-api.js";
import { NotificationBell } from "./NotificationBell.js";

const NOW = new Date("2026-06-10T12:00:00.000Z");
const ONE_HOUR_LATER = new Date("2026-06-10T13:00:00.000Z").toISOString();

const mockAckAttention = vi.mocked(consoleApi.ackAttention);
const mockFetchAttentionSettings = vi.mocked(consoleApi.fetchAttentionSettings);
const mockUpdateAttentionSettings = vi.mocked(consoleApi.updateAttentionSettings);
const mockGetBrowserNotificationPermission = vi.mocked(getBrowserNotificationPermission);

function attentionItem(overrides: Partial<AttentionItem> & Pick<AttentionItem, "ref">): AttentionItem {
  const projectId = overrides.projectId ?? "p1";
  const requirementId = overrides.requirementId ?? "req-1";
  const taskId = overrides.taskId ?? null;
  return {
    ref: overrides.ref,
    kind: overrides.kind ?? "review_intent",
    source: overrides.source ?? "review_intent",
    severity: overrides.severity ?? "attention",
    subjectType: overrides.subjectType ?? (taskId ? "task" : "requirement"),
    projectId,
    requirementId,
    taskId,
    taskKey: overrides.taskKey ?? null,
    slotId: overrides.slotId ?? null,
    title: overrides.title ?? "需要处理",
    summary: overrides.summary ?? "有一条新的 attention",
    createdAt: overrides.createdAt ?? "2026-06-10T11:57:00.000Z",
    updatedAt: overrides.updatedAt ?? null,
    cta:
      overrides.cta ?? {
        type: taskId ? "task" : "requirement",
        label: "打开",
        projectId,
        requirementId,
        taskId,
        taskKey: null,
        slotId: null
      },
    metadata: overrides.metadata
  };
}

function settings(dndUntil: string | null): AttentionSettingsResponse {
  return {
    project_id: "p1",
    dnd_until: dndUntil,
    updated_at: "2026-06-10T12:00:00.000Z"
  };
}

function ackResponse(projectId: string, ref: string): AttentionAckResponse {
  return {
    project_id: projectId,
    ref,
    acked_at: "2026-06-10T12:00:00.000Z"
  };
}

function seedSnapshot(
  projectId: string,
  items: AttentionItem[],
  overrides: Partial<NonNullable<ReturnType<typeof useUIStore.getState>["attentionSnapshot"]>> = {}
) {
  useUIStore.setState({
    attentionSnapshot: {
      projectId,
      items,
      count: items.length,
      dndActive: false,
      dndUntil: null,
      fetchedAt: "2026-06-10T12:00:00.000Z",
      ...overrides
    }
  });
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

function renderBell(projectId: string | null = "p1") {
  return render(
    <MemoryRouter initialEntries={["/projects/p1/overview"]}>
      <NotificationBell projectId={projectId} />
      <LocationProbe />
    </MemoryRouter>
  );
}

async function openBell() {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "通知" }));
  return user;
}

describe("NotificationBell", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(Date, "now").mockReturnValue(NOW.getTime());
    localStorage.clear();
    mockGetBrowserNotificationPermission.mockReturnValue("default");
    mockFetchAttentionSettings.mockResolvedValue(settings(null));
    mockUpdateAttentionSettings.mockResolvedValue(settings(null));
    mockAckAttention.mockImplementation(async (projectId, ref) => ackResponse(projectId, ref));
    useUIStore.setState({
      attentionSnapshot: null,
      notificationSettings: { browserEnabled: true, soundEnabled: true },
      toasts: []
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    useUIStore.setState({
      attentionSnapshot: null,
      notificationSettings: { browserEnabled: true, soundEnabled: true },
      toasts: []
    });
  });

  it("渲染未读列表、severity、摘要、相对时间和空态", async () => {
    seedSnapshot("p1", [
      attentionItem({
        ref: "attention-1",
        title: "审查回执待处理",
        summary: "slot4 已提交实现回执，需要主控处理",
        severity: "attention"
      }),
      attentionItem({
        ref: "warning-1",
        title: "运行时健康告警",
        summary: "slot2 已超过活跃阈值",
        severity: "warning"
      })
    ]);

    renderBell();
    await openBell();
    const dialog = screen.getByRole("dialog", { name: "通知" });

    expect(within(dialog).getByText("2 条未读")).toBeInTheDocument();
    expect(within(dialog).getByText("审查回执待处理")).toBeInTheDocument();
    expect(within(dialog).getByText("slot4 已提交实现回执，需要主控处理")).toBeInTheDocument();
    expect(within(dialog).getAllByText("3 分钟前")).toHaveLength(2);
    expect(within(dialog).getByText("需处理")).toBeInTheDocument();
    expect(within(dialog).getByText("警示")).toBeInTheDocument();

    act(() => {
      useUIStore.getState().removeAttentionRefs(["attention-1", "warning-1"]);
    });
    await waitFor(() => expect(within(dialog).getByText("暂无未读通知")).toBeInTheDocument());
    expect(within(dialog).getByText("0 条未读")).toBeInTheDocument();
  });

  it("单条点击会导航并在 ack 成功后移除条目与角标", async () => {
    seedSnapshot("p1", [
      attentionItem({
        ref: "task-ref",
        title: "任务待处理",
        requirementId: null,
        taskId: "task-1",
        cta: {
          type: "task",
          label: "打开任务",
          projectId: "p1",
          requirementId: null,
          taskId: "task-1",
          taskKey: "T-1",
          slotId: null
        }
      })
    ]);

    renderBell();
    const user = await openBell();
    await user.click(screen.getByRole("button", { name: /任务待处理/ }));

    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/projects/p1/tasks/task-1"));
    expect(mockAckAttention).toHaveBeenCalledWith("p1", "task-ref");
    await waitFor(() => expect(screen.queryByText("任务待处理")).not.toBeInTheDocument());
    expect(useUIStore.getState().attentionSnapshot?.count).toBe(0);
  });

  it("单条 ack 失败时保留条目并提示错误", async () => {
    mockAckAttention.mockRejectedValueOnce(new Error("ack failed"));
    seedSnapshot("p1", [attentionItem({ ref: "fail-ref", title: "失败仍保留" })]);

    renderBell();
    const user = await openBell();
    await user.click(screen.getByRole("button", { name: /失败仍保留/ }));

    await waitFor(() => expect(useUIStore.getState().toasts.at(-1)?.message).toBe("标记已读失败"));
    expect(screen.getByText("失败仍保留")).toBeInTheDocument();
    expect(useUIStore.getState().attentionSnapshot?.count).toBe(1);
  });

  it("全部已读全成功时清空列表与角标", async () => {
    seedSnapshot("p1", [
      attentionItem({ ref: "success-1", title: "第一条" }),
      attentionItem({ ref: "success-2", title: "第二条" })
    ]);

    renderBell();
    const user = await openBell();
    await user.click(screen.getByRole("button", { name: "全部已读" }));

    await waitFor(() => expect(useUIStore.getState().attentionSnapshot?.count).toBe(0));
    expect(screen.getByText("暂无未读通知")).toBeInTheDocument();
    expect(mockAckAttention).toHaveBeenCalledWith("p1", "success-1");
    expect(mockAckAttention).toHaveBeenCalledWith("p1", "success-2");
  });

  it("全部已读部分失败时只移除成功 refs 并保留失败项", async () => {
    mockAckAttention.mockImplementation(async (projectId, ref) => {
      if (ref === "keep-ref") {
        throw new Error("ack failed");
      }
      return ackResponse(projectId, ref);
    });
    seedSnapshot("p1", [
      attentionItem({ ref: "remove-1", title: "会移除一" }),
      attentionItem({ ref: "keep-ref", title: "失败保留" }),
      attentionItem({ ref: "remove-2", title: "会移除二" })
    ]);

    renderBell();
    const user = await openBell();
    await user.click(screen.getByRole("button", { name: "全部已读" }));

    await waitFor(() => expect(useUIStore.getState().attentionSnapshot?.count).toBe(1));
    expect(screen.queryByText("会移除一")).not.toBeInTheDocument();
    expect(screen.getByText("失败保留")).toBeInTheDocument();
    expect(screen.queryByText("会移除二")).not.toBeInTheDocument();
    expect(useUIStore.getState().toasts.at(-1)?.message).toBe("1 条标记失败");
  });

  it("saveDnd 成功后立即同步 snapshot 并显示 DND 横幅", async () => {
    mockUpdateAttentionSettings.mockResolvedValue(settings(ONE_HOUR_LATER));
    seedSnapshot("p1", [attentionItem({ ref: "dnd-ref", title: "暂停期间仍可见" })]);

    renderBell();
    const user = await openBell();
    expect(screen.queryByText(/消息仍可见/)).not.toBeInTheDocument();

    await user.click(screen.getByText("通知设置"));
    await user.click(screen.getByRole("button", { name: "1 小时" }));

    await waitFor(() =>
      expect(mockUpdateAttentionSettings).toHaveBeenCalledWith("p1", { dnd_until: ONE_HOUR_LATER })
    );
    await waitFor(() => expect(useUIStore.getState().attentionSnapshot?.dndActive).toBe(true));
    expect(useUIStore.getState().attentionSnapshot?.dndUntil).toBe(ONE_HOUR_LATER);
    expect(screen.getByText(/已暂停投递至 .*消息仍可见/)).toBeInTheDocument();
  });

  it("snapshot projectId 不匹配时不渲染其它项目列表或未读数", async () => {
    seedSnapshot("p2", [attentionItem({ ref: "foreign-ref", projectId: "p2", title: "其它项目消息" })], {
      count: 1
    });

    renderBell("p1");
    await openBell();

    expect(screen.queryByText("其它项目消息")).not.toBeInTheDocument();
    expect(screen.getByText("0 条未读")).toBeInTheDocument();
    expect(screen.getByText("暂无未读通知")).toBeInTheDocument();
  });

  it("折叠设置区开关、DND 按钮和 aria-label 不回归", async () => {
    renderBell();
    expect(screen.getByRole("button", { name: "通知" })).toBeInTheDocument();

    const user = await openBell();
    expect(screen.getByRole("dialog", { name: "通知" })).toBeInTheDocument();
    await user.click(screen.getByText("通知设置"));

    await user.click(screen.getByLabelText("浏览器通知"));
    await user.click(screen.getByLabelText("声音"));
    expect(useUIStore.getState().notificationSettings.browserEnabled).toBe(false);
    expect(useUIStore.getState().notificationSettings.soundEnabled).toBe(false);

    expect(screen.getByRole("button", { name: "1 小时" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "24 小时" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "恢复" }));
    await waitFor(() => expect(mockUpdateAttentionSettings).toHaveBeenCalledWith("p1", { dnd_until: null }));
    expect(screen.getByText("权限：未询问")).toBeInTheDocument();
  });
});
