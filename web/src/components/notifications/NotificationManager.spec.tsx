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
    <MemoryRouter initialEntries={["/overview"]}>
      <NotificationManager pollMs={POLL_MS} projectId={projectId} />
      <LocationProbe />
    </MemoryRouter>
  );
}

function renderTwoManagers() {
  return render(
    <MemoryRouter initialEntries={["/overview"]}>
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

function list(projectId: string, items: AttentionItem[]): AttentionListResponse {
  return { project_id: projectId, items, count: items.length };
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

describe("NotificationManager", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    FakeBroadcastChannel.reset();
    document.title = "Console";
    localStorage.clear();
    browserNotify.resetBrowserNotifyForTests();
    vi.spyOn(window, "focus").mockImplementation(() => undefined);
    vi.spyOn(browserNotify, "showBrowserNotification").mockResolvedValue({ status: "shown" });
    mockAckAttention.mockResolvedValue({
      project_id: "p1",
      ref: "attention-1",
      acked_at: "2026-06-06T12:00:00.000Z"
    });
    useUIStore.setState({
      attentionUnreadCount: 0,
      notificationSettings: { browserEnabled: true, soundEnabled: true },
      toasts: []
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    localStorage.clear();
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    document.title = "Console";
    browserNotify.resetBrowserNotifyForTests();
    useUIStore.setState({ attentionUnreadCount: 0, toasts: [] });
  });

  it("leader 选举只让一个标签弹出同一条新增 attention", async () => {
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

    expect(screen.getByTestId("location").textContent).toBe("/requirements/req-1");
    expect(mockAckAttention).toHaveBeenCalledWith("p1", "attention-1");
  });

  it("ack 失败会 toast，并在下一轮 poll 重试但不重复弹窗", async () => {
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
    vi.mocked(browserNotify.showBrowserNotification).mockResolvedValue({ status: "denied" });
    const next = item({ ref: "attention-1" });
    mockFetchAttention
      .mockResolvedValueOnce(list("p1", []))
      .mockResolvedValueOnce(list("p1", [next]));

    renderManager();
    await flushAsync();
    await advancePoll();

    expect(browserNotify.showBrowserNotification).toHaveBeenCalledTimes(1);
    expect(useUIStore.getState().attentionUnreadCount).toBe(1);
    expect(document.title).toBe("(1) Console");
  });

  it("project 切换会重置 diff 基线，避免把新项目既有 item 误弹", async () => {
    const p1Existing = item({ ref: "p1-existing", projectId: "p1" });
    const p2Existing = item({ ref: "p2-existing", projectId: "p2", requirementId: "req-2" });
    const p2New = item({ ref: "p2-new", projectId: "p2", requirementId: "req-3", title: "p2 新增" });
    mockFetchAttention
      .mockResolvedValueOnce(list("p1", [p1Existing]))
      .mockResolvedValueOnce(list("p2", [p2Existing]))
      .mockResolvedValueOnce(list("p2", [p2Existing, p2New]));

    const rendered = render(
      <MemoryRouter initialEntries={["/overview"]}>
        <NotificationManager pollMs={POLL_MS} projectId="p1" />
      </MemoryRouter>
    );
    await flushAsync();
    rendered.rerender(
      <MemoryRouter initialEntries={["/overview"]}>
        <NotificationManager pollMs={POLL_MS} projectId="p2" />
      </MemoryRouter>
    );
    await flushAsync();

    expect(browserNotify.showBrowserNotification).not.toHaveBeenCalled();
    await advancePoll();

    expect(browserNotify.showBrowserNotification).toHaveBeenCalledTimes(1);
    expect(browserNotify.showBrowserNotification).toHaveBeenCalledWith(
      expect.objectContaining({ title: "p2 新增" })
    );
  });

  it("hidden tab 下仍会弹浏览器通知", async () => {
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    const next = item({ ref: "attention-1" });
    mockFetchAttention
      .mockResolvedValueOnce(list("p1", []))
      .mockResolvedValueOnce(list("p1", [next]));

    renderManager();
    await flushAsync();
    await advancePoll();

    expect(browserNotify.showBrowserNotification).toHaveBeenCalledTimes(1);
  });

  it("仅 severity=attention 进入弹窗候选，warning/info 只计入 unread", async () => {
    const warning = item({ ref: "warn", severity: "warning", title: "warning" });
    const info = item({ ref: "info", severity: "info", title: "info" });
    const attention = item({ ref: "attention", severity: "attention", title: "attention" });
    mockFetchAttention
      .mockResolvedValueOnce(list("p1", []))
      .mockResolvedValueOnce(list("p1", [warning, info, attention]));

    renderManager();
    await flushAsync();
    await advancePoll();

    expect(useUIStore.getState().attentionUnreadCount).toBe(3);
    expect(browserNotify.showBrowserNotification).toHaveBeenCalledTimes(1);
    expect(browserNotify.showBrowserNotification).toHaveBeenCalledWith(
      expect.objectContaining({ title: "attention" })
    );
  });
});
