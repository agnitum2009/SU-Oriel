import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SlotProjectionView } from "../../lib/console-api.js";
import { AnchorStartStrip } from "./AnchorStartStrip.js";

function renderWithRouter(ui: ReactElement) {
  return render(<MemoryRouter initialEntries={["/projects/project-1/tasks/task-1"]}>{ui}</MemoryRouter>);
}

vi.mock("../../lib/console-api.js", () => ({
  fetchSlots: vi.fn()
}));

vi.mock("../../lib/user-intent-api.js", () => ({
  fetchPendingIntent: vi.fn(),
  resumeWithIntent: vi.fn(),
  stopAndAppend: vi.fn()
}));

import * as consoleApi from "../../lib/console-api.js";
import * as userIntentApi from "../../lib/user-intent-api.js";
import { useProjectStore } from "../../stores/project-store.js";
import { useUIStore } from "../../stores/ui-store.js";

const slotProjection: SlotProjectionView = {
  project: { id: "project-1", name: "SU-CCB", slotCount: 3 },
  slotCount: 3,
  main: { slotId: "main", lane: "coordination", state: "available", canBindBusiness: false },
  slots: [
    {
      slotId: "slot-1",
      state: "idle",
      requirement: null,
      boundAt: null,
      busySince: null,
      lastActivityAt: null,
      stale: null,
      unhealthy: null,
      queued: []
    },
    {
      slotId: "slot-2",
      state: "idle",
      requirement: null,
      boundAt: null,
      busySince: null,
      lastActivityAt: null,
      stale: null,
      unhealthy: null,
      queued: []
    },
    {
      slotId: "slot-3",
      state: "bound",
      requirement: { id: "req-1", title: "Parent Requirement" },
      boundAt: "2026-05-24T00:00:00.000Z",
      busySince: null,
      lastActivityAt: "2026-05-24T00:01:00.000Z",
      stale: null,
      unhealthy: null,
      queued: []
    }
  ],
  queue: [],
  shrinkEligibility: {
    projectId: "project-1",
    slotCount: 3,
    tailSlotId: "slot-3",
    canShrink: true,
    eligible: false,
    checks: {
      slotBindingIdle: false,
      queueClear: true,
      runtimeIdle: true
    },
    reasons: ["slot_not_idle"],
    details: {}
  },
  generatedAt: "2026-05-24T00:02:00.000Z"
};

describe("AnchorStartStrip", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useUIStore.setState({ toasts: [] });
    useProjectStore.setState({
      projects: [
        {
          id: "project-1",
          name: "SU-CCB",
          localPath: "/tmp/SU-CCB",
          summary: "test project",
          initStatus: "initialized",
          syncStatus: "idle",
          lastScanAt: null
        }
      ],
      selectedProjectId: "project-1"
    });
    vi.mocked(consoleApi.fetchSlots).mockResolvedValue(slotProjection);
    vi.mocked(userIntentApi.fetchPendingIntent).mockResolvedValue(null);
    vi.mocked(userIntentApi.resumeWithIntent).mockResolvedValue({
      slotId: "slot-3",
      slotState: "busy",
      jobId: "job-resume",
      intentId: "intent-1",
      intentType: "change_direction",
      body: "switch direction"
    });
    vi.mocked(userIntentApi.stopAndAppend).mockResolvedValue({
      intentId: "intent-1",
      cancelledJobId: "job-current",
      slotId: "slot-3",
      slotState: "bound"
    });
  });

  it("shows slot guidance without calling legacy anchor preview, start, or reset routes", async () => {
    renderWithRouter(<AnchorStartStrip taskId="task-1" taskTitle="Subtask One" requirementId="req-1" visible />);

    expect(await screen.findByText("slot-3 已绑定")).toBeInTheDocument();
    expect(screen.getByText("终端请在 ccb 原生 sidebar 查看 slot 窗口")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "打开 Slots" })).toHaveAttribute("href", "/projects/project-1/anchors");
    expect(screen.queryByRole("button", { name: "启动 Anchor" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "重置 anchor" })).not.toBeInTheDocument();
    expect(screen.queryByText(/worktree/i)).not.toBeInTheDocument();
  });

  it("shows pending user intent joined with the bound slot and resumes on that slot", async () => {
    vi.mocked(userIntentApi.fetchPendingIntent).mockResolvedValue({
      id: "intent-1",
      intentType: "change_direction",
      body: "switch direction",
      createdAt: "2026-05-24T00:02:00.000Z",
      ccbJobId: "job-current"
    });

    renderWithRouter(
      <AnchorStartStrip
        taskId="task-1"
        taskTitle="Subtask One"
        taskKind="subtask"
        requirementId="req-1"
        visible
      />
    );

    expect(await screen.findByText(/绑定 req-1.*有待恢复意图/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "恢复 · 改向" }));

    await waitFor(() => expect(userIntentApi.resumeWithIntent).toHaveBeenCalledWith("task-1"));
  });

  it("opens stop-and-append without idle_dirty copy and records the intent", async () => {
    vi.mocked(consoleApi.fetchSlots).mockResolvedValue({
      ...slotProjection,
      slots: slotProjection.slots.map((slot) =>
        slot.slotId === "slot-3" ? { ...slot, state: "busy", busySince: "2026-05-24T00:03:00.000Z" } : slot
      )
    });

    renderWithRouter(
      <AnchorStartStrip
        taskId="task-1"
        taskTitle="Subtask One"
        taskKind="subtask"
        requirementId="req-1"
        visible
      />
    );

    expect(await screen.findByText("slot-3")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "停止追加" }));

    expect(await screen.findByRole("dialog", { name: "停止当前 slot 并追加说明" })).toBeInTheDocument();
    expect(screen.queryByText(/idle_dirty/)).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/详细内容/), {
      target: { value: "stop and add this constraint" }
    });
    fireEvent.click(screen.getByRole("button", { name: "停止并追加" }));

    await waitFor(() =>
      expect(userIntentApi.stopAndAppend).toHaveBeenCalledWith("task-1", {
        intentType: "append_instruction",
        body: "stop and add this constraint"
      })
    );
  });
});
