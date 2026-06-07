import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SlotLaneView, SlotProjectionView } from "../../lib/console-api.js";

vi.mock("../../lib/console-api.js", () => ({ fetchSlots: vi.fn() }));

import { MemoryRouter, useLocation } from "react-router";

import { fetchSlots } from "../../lib/console-api.js";
import { useProjectStore } from "../../stores/project-store.js";
import { SlotRequirementsFab } from "./SlotRequirementsFab.js";

const mockFetchSlots = vi.mocked(fetchSlots);
const FAB_LABEL = "绑定 slot 的需求快捷入口";

function lane(overrides: Partial<SlotLaneView> & Pick<SlotLaneView, "slotId" | "state">): SlotLaneView {
  return {
    requirement: null,
    boundAt: null,
    busySince: null,
    lastActivityAt: null,
    stale: null,
    unhealthy: null,
    queued: [],
    ...overrides
  };
}

function projection(slots: SlotLaneView[]): SlotProjectionView {
  return {
    project: { id: "p1", name: "P1", slotCount: 3 },
    slotCount: 3,
    main: { slotId: "main", lane: "coordination", state: "idle", canBindBusiness: false },
    slots,
    queue: [],
    shrinkEligibility: {
      projectId: "p1",
      slotCount: 3,
      tailSlotId: "slot-3",
      canShrink: true,
      eligible: true,
      checks: {
        slotBindingIdle: true,
        queueClear: true,
        runtimeIdle: true
      },
      reasons: [],
      details: {}
    }
  };
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="loc">{location.pathname}</div>;
}

function renderFab(initialPath = "/") {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <SlotRequirementsFab />
      <LocationProbe />
    </MemoryRouter>
  );
}

describe("SlotRequirementsFab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useProjectStore.setState({ selectedProjectId: "p1" });
  });

  afterEach(() => {
    useProjectStore.setState({ selectedProjectId: null });
  });

  it("renders nothing when no project is selected", () => {
    useProjectStore.setState({ selectedProjectId: null });
    const { container } = renderFab();
    expect(container.querySelector("button")).toBeNull();
  });

  it("lazily fetches on open, lists bound requirements, and navigates on click", async () => {
    mockFetchSlots.mockResolvedValue(
      projection([lane({ slotId: "slot-1", state: "bound", requirement: { id: "r1", title: "需求一" } })])
    );
    const user = userEvent.setup();
    renderFab();

    expect(mockFetchSlots).not.toHaveBeenCalled(); // lazy: no fetch until opened

    await user.click(screen.getByLabelText(FAB_LABEL));
    expect(mockFetchSlots).toHaveBeenCalledWith("p1");

    await user.click(await screen.findByText("需求一"));
    expect(screen.getByTestId("loc").textContent).toBe("/projects/p1/requirements/r1");
  });

  it("shows an empty state when nothing is bound", async () => {
    mockFetchSlots.mockResolvedValue(projection([]));
    const user = userEvent.setup();
    renderFab();

    await user.click(screen.getByLabelText(FAB_LABEL));
    expect(await screen.findByText("暂无绑定 slot 的需求")).toBeTruthy();
  });

  it("shows an error state with a working retry", async () => {
    mockFetchSlots
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(
        projection([lane({ slotId: "slot-1", state: "busy", requirement: { id: "r9", title: "恢复后的需求" } })])
      );
    const user = userEvent.setup();
    renderFab();

    await user.click(screen.getByLabelText(FAB_LABEL));
    await user.click(await screen.findByText("重试"));
    expect(await screen.findByText("恢复后的需求")).toBeTruthy();
  });

  it("marks the current requirement and disables its row", async () => {
    mockFetchSlots.mockResolvedValue(
      projection([lane({ slotId: "slot-1", state: "bound", requirement: { id: "r1", title: "当前需求" } })])
    );
    const user = userEvent.setup();
    renderFab("/projects/p1/requirements/r1");

    await user.click(screen.getByLabelText(FAB_LABEL));
    await screen.findByText("当前");
    const row = screen.getByText("当前需求").closest("button") as HTMLButtonElement;
    expect(row.disabled).toBe(true);
  });
});
