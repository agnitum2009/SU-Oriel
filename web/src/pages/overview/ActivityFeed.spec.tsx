import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ActivityFeed } from "./ActivityFeed.js";

const activityResponse = {
  events: [
    {
      event_id: "event-receipt",
      event_type: "codex_receipt_ready",
      task_id: "task-1",
      project_id: "project-1",
      at: "2026-05-04T10:00:00.000Z",
      payload: {}
    },
    {
      event_id: "event-transition",
      event_type: "transition.applied",
      task_id: "task-2",
      project_id: "project-1",
      at: "2026-05-04T10:01:00.000Z",
      payload: {
        source: "implementation",
        target: "review"
      }
    },
    {
      event_id: "event-fallback",
      event_type: "capability.fallback",
      task_id: "task-3",
      project_id: "project-1",
      at: "2026-05-04T10:02:00.000Z",
      payload: {
        cap_id: "analysis.deep",
        provider: "claude_native_design"
      }
    },
    {
      event_id: "event-missing",
      event_type: "capability.missing",
      task_id: "task-4",
      project_id: "project-1",
      at: "2026-05-04T10:03:00.000Z",
      payload: {
        cap_id: "gate.user_decision"
      }
    },
    {
      event_id: "event-other",
      event_type: "verification_finished",
      task_id: "task-5",
      project_id: "project-1",
      at: "2026-05-04T10:04:00.000Z",
      summary: "task-5 verification_finished",
      payload: {}
    }
  ]
};

describe("ActivityFeed", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("maps known activity event types to tone, copy and task tab targets", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(activityResponse)));

    render(
      <MemoryRouter initialEntries={["/projects/project-1/overview"]}>
        <Routes>
          <Route element={<ActivityFeed />} path="/projects/:projectId/overview" />
          <Route element={<TaskRouteProbe />} path="/projects/:projectId/tasks/:taskId" />
        </Routes>
      </MemoryRouter>
    );

    expect(await screen.findByTestId("activity-event-event-receipt")).toHaveAttribute("data-tone", "success");
    expect(screen.getByTestId("activity-event-event-transition")).toHaveAttribute("data-tone", "success");
    expect(screen.getByTestId("activity-event-event-fallback")).toHaveAttribute("data-tone", "warn");
    expect(screen.getByTestId("activity-event-event-missing")).toHaveAttribute("data-tone", "danger");
    expect(screen.getByTestId("activity-event-event-other")).toHaveAttribute("data-tone", "info");

    expect(screen.getByText("task-1 receipt ready (codex)")).toBeInTheDocument();
    expect(screen.getByText("task-2 transition apply (implementation→review)")).toBeInTheDocument();
    expect(screen.getByText("task-3 capability fallback (analysis.deep → claude_native_design)")).toBeInTheDocument();
    expect(screen.getByText("task-4 capability missing (gate.user_decision)")).toBeInTheDocument();
    expect(screen.getByText("task-5 verification_finished")).toBeInTheDocument();

    expect(screen.getByTestId("activity-event-event-other").tagName.toLowerCase()).toBe("div");

    await user.click(screen.getByRole("button", { name: "Open task-3 consultation activity" }));
    expect(await screen.findByText("task detail route")).toBeInTheDocument();
    expect(screen.getByTestId("route-search")).toHaveTextContent("?tab=consultation");
  });
});

function TaskRouteProbe() {
  const location = useLocation();
  return (
    <div>
      <span>task detail route</span>
      <span data-testid="route-search">{location.search}</span>
    </div>
  );
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      "Content-Type": "application/json"
    }
  });
}
