import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, useLocation } from "react-router";

import type {
  AttentionItem,
  AttentionListResponse
} from "../../lib/console-api.js";
import type { BrowserNotificationInput } from "../../lib/browser-notify.js";
import { useUIStore } from "../../stores/ui-store.js";

vi.mock("../../lib/console-api.js", async () => {
  const actual = await vi.importActual<typeof import("../../lib/console-api.js")>("../../lib/console-api.js");
  return {
    ...actual,
    ackAttention: vi.fn(),
    fetchAttention: vi.fn()
  };
});

import * as browserNotify from "../../lib/browser-notify.js";
import * as consoleApi from "../../lib/console-api.js";
import { NotificationManager } from "./NotificationManager.js";

const POLL_MS = 25;

const mockFetchAttention = vi.mocked(consoleApi.fetchAttention);
const mockAckAttention = vi.mocked(consoleApi.ackAttention);

class FakeBroadcastChannel {
  static channels = new Map<string, Set<FakeBroadcastChannel>>();

  onmessage: ((event: MessageEvent) => void) | null = null;

  constructor(readonly name: string) {
    const peers = FakeBroadcastChannel.channels.get(name) ?? new Set<FakeBroadcastChannel>();
    peers.add(this);
    FakeBroadcastChannel.channels.set(name, peers);
  }

  postMessage(data: unknown) {
    const peers = FakeBroadcastChannel.channels.get(this.name) ?? new Set<FakeBroadcastChannel>();
    for (const peer of peers) {
      if (peer !== this) {
        peer.onmessage?.({ data } as MessageEvent);
      }
    }
  }

  close() {
    FakeBroadcastChannel.channels.get(this.name)?.delete(this);
  }

  static reset() {
    FakeBroadcastChannel.channels.clear();
  }
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

function renderManager(projectId: string | null = "p1") {
  return render(
    <MemoryRouter initialEntries={["/projects/p1/overview"]}>
      <NotificationManager pollMs={POLL_MS} projectId={projectId} />
      <LocationProbe />
    </MemoryRouter>
  );
}

function renderTwoManagers() {
  return render(
    <MemoryRouter initialEntries={["/projects/p1/overview"]}>
      <NotificationManager pollMs={POLL_MS} projectId="p1" />
      <NotificationManager pollMs={POLL_MS} projectId="p1" />
    </MemoryRouter>
  );
}

function item(overrides: Partial<AttentionItem> & Pick<AttentionItem, "ref">): AttentionItem {
  const projectId = overrides.projectId ?? "p1";
  const requirementId = overrides.requirementId ?? "r1";
  const taskId = overrides.taskId ?? null;
  return {
    ref: overrides.ref,
    kind: overrides.kind ?? "review_intent",
    source: overrides.source ?? "review_intent",
    severity: overrides.severity ?? "attention",
    subjectType: overrides.subjectType ?? "requirement",
    projectId,
    requirementId,
    taskId,
    taskKey: overrides.taskKey ?? null,
    slotId: overrides.slotId ?? null,
    title: overrides.title ?? "需要处理",
    summary: overrides.summary ?? "有一条新的 attention",
    createdAt: overrides.createdAt ?? "2026-06-06T12:00:00.000Z",
    updatedAt: overrides.updatedAt ?? null,
    cta: overrides.cta ?? {
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

function list(
  projectId: string,
  items: AttentionItem[],
  overrides: Partial<Pick<AttentionListResponse, "dnd_active" | "dnd_until">> = {}
): AttentionListResponse {
  return {
    project_id: projectId,
    items,
    count: items.length,
    dnd_active: overrides.dnd_active ?? false,
    dnd_until: overrides.dnd_until ?? null
  };
}

async function flushAsync() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function advancePoll() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(POLL_MS);
  });
}

function setDocumentVisibility(visibilityState: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: visibilityState });
  Object.defineProperty(document, "hidden", { configurable: true, value: visibilityState !== "visible" });
}

describe("NotificationManager", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    FakeBroadcastChannel.reset();
    document.title = "Console";
    localStorage.clear();
    browserNotify.resetBrowserNotifyForTests();
    setDocumentVisibility("visible");
    vi.spyOn(window, "focus").mockImplementation(() => undefined);
    vi.spyOn(browserNotify, "showBrowserNotification").mockResolvedValue({ status: "shown" });
    vi.spyOn(browserNotify, "playAttentionSound").mockImplementation(() => undefined);
    mockAckAttention.mockResolvedValue({
      project_id: "p1",
      ref: "attention-1",
      acked_at: "2026-06-06T12:00:00.000Z"
    });
    useUIStore.setState({
      attentionSnapshot: null,
      notificationSettings: { browserEnabled: true, soundEnabled: true },
      toasts: []
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    localStorage.clear();
    setDocumentVisibility("visible");
    document.title = "Console";
    browserNotify.resetBrowserNotifyForTests();
    useUIStore.setState({ attentionSnapshot: null, toasts: [] });
  });

  it("leader 选举只让一个标签弹出同一条新增 attention", async () => {
    setDocumentVisibility("hidden");
    vi.stubGlobal("BroadcastChannel", FakeBroadcastChannel);
    const baseline = item({ ref: "baseline" });
    const next = item({ ref: "attention-1", title: "只弹一次" });
    mockFetchAttention
      .mockResolvedValueOnce(list("p1", [baseline]))
      .mockResolvedValueOnce(list("p1", [baseline]))
      .mockResolvedValueOnce(list("p1", [baseline, next]))
      .mockResolvedValueOnce(list("p1", [baseline, next]));

    renderTwoManagers();
    await flushAsync();
    await advancePoll();

    expect(browserNotify.showBrowserNotification).toHaveBeenCalledTimes(1);
    expect(browserNotify.showBrowserNotification).toHaveBeenCalledWith(
      expect.objectContaining({ title: "只弹一次" })
    );
  });

  it("BroadcastChannel 缺失时降级到本地 leader，不抛错且仍可弹", async () => {
    setDocumentVisibility("hidden");
    vi.stubGlobal("BroadcastChannel", undefined);
    const next = item({ ref: "attention-1" });
    mockFetchAttention
      .mockResolvedValueOnce(list("p1", []))
      .mockResolvedValueOnce(list("p1", [next]));

    renderManager();
    await flushAsync();
    await advancePoll();

    expect(browserNotify.showBrowserNotification).toHaveBeenCalledTimes(1);
  });

  it("BroadcastChannel 与 localStorage 都不可用时降级为每标签 ref 节流", async () => {
    setDocumentVisibility("hidden");
    vi.stubGlobal("BroadcastChannel", undefined);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage disabled");
    });
    const next = item({ ref: "attention-1" });
    mockFetchAttention
      .mockResolvedValueOnce(list("p1", []))
      .mockResolvedValueOnce(list("p1", [next]));

    renderManager();
    await flushAsync();
    await advancePoll();

    expect(browserNotify.showBrowserNotification).toHaveBeenCalledTimes(1);
  });

  it("onclick 会导航到 deep-link 并 POST ack", async () => {
    setDocumentVisibility("hidden");
    const notificationInputRef: { current: BrowserNotificationInput | null } = { current: null };
    vi.mocked(browserNotify.showBrowserNotification).mockImplementation(async (input) => {
      notificationInputRef.current = input;
      return { status: "shown" };
    });
    const next = item({ ref: "attention-1", requirementId: "req-1" });
    mockFetchAttention
      .mockResolvedValueOnce(list("p1", []))
      .mockResolvedValueOnce(list("p1", [next]));

    renderManager();
    await flushAsync();
    await advancePoll();
    notificationInputRef.current?.onClick?.();
    await flushAsync();

    expect(screen.getByTestId("location").textContent).toBe("/projects/p1/requirements/req-1");
    expect(mockAckAttention).toHaveBeenCalledWith("p1", "attention-1");
  });

  it("ack 失败会 toast，并在下一轮 poll 重试但不重复弹窗", async () => {
    setDocumentVisibility("hidden");
    const notificationInputRef: { current: BrowserNotificationInput | null } = { current: null };
    vi.mocked(browserNotify.showBrowserNotification).mockImplementation(async (input) => {
      notificationInputRef.current = input;
      return { status: "shown" };
    });
    mockAckAttention
      .mockRejectedValueOnce(new Error("ack failed"))
      .mockResolvedValueOnce({
        project_id: "p1",
        ref: "attention-1",
        acked_at: "2026-06-06T12:00:05.000Z"
      });
    const next = item({ ref: "attention-1" });
    mockFetchAttention
      .mockResolvedValueOnce(list("p1", []))
      .mockResolvedValueOnce(list("p1", [next]))
      .mockResolvedValueOnce(list("p1", [next]));

    renderManager();
    await flushAsync();
    await advancePoll();
    notificationInputRef.current?.onClick?.();
    await flushAsync();

    expect(useUIStore.getState().toasts.some((toast) => toast.message.includes("标记已读失败"))).toBe(true);
    await advancePoll();

    expect(mockAckAttention).toHaveBeenCalledTimes(2);
    expect(browserNotify.showBrowserNotification).toHaveBeenCalledTimes(1);
  });

  it("权限拒绝时保留 unread/title badge，不再视为成功弹窗", async () => {
    setDocumentVisibility("hidden");
    vi.mocked(browserNotify.showBrowserNotification).mockResolvedValue({ status: "denied" });
    const next = item({ ref: "attention-1" });
    mockFetchAttention
      .mockResolvedValueOnce(list("p1", []))
      .mockResolvedValueOnce(list("p1", [next]));

    renderManager();
    await flushAsync();
    await advancePoll();

    expect(browserNotify.showBrowserNotification).toHaveBeenCalledTimes(1);
    expect(useUIStore.getState().attentionSnapshot?.count).toBe(1);
    expect(document.title).toBe("(1) Console");
  });

  it("project 切换会重置 diff 基线，避免把新项目既有 item 误提醒", async () => {
    const p1Existing = item({ ref: "p1-existing", projectId: "p1" });
    const p2Existing = item({ ref: "p2-existing", projectId: "p2", requirementId: "req-2" });
    const p2New = item({ ref: "p2-new", projectId: "p2", requirementId: "req-3", title: "p2 新增" });
    mockFetchAttention
      .mockResolvedValueOnce(list("p1", [p1Existing]))
      .mockResolvedValueOnce(list("p2", [p2Existing]))
      .mockResolvedValueOnce(list("p2", [p2Existing, p2New]));

    const rendered = render(
      <MemoryRouter initialEntries={["/projects/p1/overview"]}>
        <NotificationManager pollMs={POLL_MS} projectId="p1" />
      </MemoryRouter>
    );
    await flushAsync();
    rendered.rerender(
      <MemoryRouter initialEntries={["/projects/p2/overview"]}>
        <NotificationManager pollMs={POLL_MS} projectId="p2" />
      </MemoryRouter>
    );
    await flushAsync();

    expect(browserNotify.showBrowserNotification).not.toHaveBeenCalled();
    expect(useUIStore.getState().toasts).toHaveLength(0);
    await advancePoll();

    expect(browserNotify.showBrowserNotification).not.toHaveBeenCalled();
    expect(useUIStore.getState().toasts.some((toast) => toast.message === "新通知：p2 新增")).toBe(true);
    expect(useUIStore.getState().attentionSnapshot?.projectId).toBe("p2");
  });

  it("hidden tab 下仍会弹浏览器通知", async () => {
    setDocumentVisibility("hidden");
    const next = item({ ref: "attention-1" });
    mockFetchAttention
      .mockResolvedValueOnce(list("p1", []))
      .mockResolvedValueOnce(list("p1", [next]));

    renderManager();
    await flushAsync();
    await advancePoll();

    expect(browserNotify.showBrowserNotification).toHaveBeenCalledTimes(1);
  });

  it("visible tab 下仅 severity=attention 进入 Toast 候选，warning/info 只计入 unread", async () => {
    const warning = item({ ref: "warn", severity: "warning", title: "warning" });
    const info = item({ ref: "info", severity: "info", title: "info" });
    const attention = item({ ref: "attention", severity: "attention", title: "attention" });
    mockFetchAttention
      .mockResolvedValueOnce(list("p1", []))
      .mockResolvedValueOnce(list("p1", [warning, info, attention]));

    renderManager();
    await flushAsync();
    await advancePoll();

    expect(useUIStore.getState().attentionSnapshot?.count).toBe(3);
    expect(browserNotify.showBrowserNotification).not.toHaveBeenCalled();
    expect(useUIStore.getState().toasts.some((toast) => toast.message === "新通知：attention")).toBe(true);
    expect(browserNotify.playAttentionSound).toHaveBeenCalledTimes(1);
  });

  it("同一轮 visible 新增多条 attention 时聚合 Toast", async () => {
    const first = item({ ref: "attention-1" });
    const second = item({ ref: "attention-2" });
    mockFetchAttention
      .mockResolvedValueOnce(list("p1", []))
      .mockResolvedValueOnce(list("p1", [first, second]));

    renderManager();
    await flushAsync();
    await advancePoll();

    expect(browserNotify.showBrowserNotification).not.toHaveBeenCalled();
    expect(useUIStore.getState().toasts.some((toast) => toast.message === "2 条新通知")).toBe(true);
    expect(browserNotify.playAttentionSound).toHaveBeenCalledTimes(1);
  });

  it("DND 激活时只更新 snapshot/badge，不投递 Toast、浏览器通知或声音", async () => {
    const dndUntil = "2026-06-06T13:00:00.000Z";
    const next = item({ ref: "attention-1" });
    mockFetchAttention
      .mockResolvedValueOnce(list("p1", []))
      .mockResolvedValueOnce(list("p1", [next], { dnd_active: true, dnd_until: dndUntil }));

    renderManager();
    await flushAsync();
    await advancePoll();

    expect(useUIStore.getState().attentionSnapshot).toMatchObject({
      projectId: "p1",
      count: 1,
      dndActive: true,
      dndUntil
    });
    expect(document.title).toBe("(1) Console");
    expect(useUIStore.getState().toasts).toHaveLength(0);
    expect(browserNotify.showBrowserNotification).not.toHaveBeenCalled();
    expect(browserNotify.playAttentionSound).not.toHaveBeenCalled();
  });

  it("projectId 为空时清理 snapshot 与 badge", async () => {
    useUIStore.setState({
      attentionSnapshot: {
        projectId: "p1",
        items: [item({ ref: "attention-1" })],
        count: 1,
        dndActive: false,
        dndUntil: null,
        fetchedAt: "2026-06-06T12:00:00.000Z"
      }
    });
    browserNotify.setAttentionBadge(1);

    renderManager(null);
    await flushAsync();

    expect(useUIStore.getState().attentionSnapshot).toBeNull();
    expect(document.title).toBe("Console");
  });
});
