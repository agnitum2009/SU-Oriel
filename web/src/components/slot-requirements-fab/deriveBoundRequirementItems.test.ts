import { describe, expect, it } from "vitest";

import type { SlotBindingState, SlotLaneView, SlotProjectionView } from "../../lib/console-api.js";
import { deriveBoundRequirementItems } from "./deriveBoundRequirementItems.js";

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
    project: { id: "p1", name: "P1" },
    main: { slotId: "main", lane: "coordination", state: "idle", canBindBusiness: false },
    slots,
    queue: []
  };
}

describe("deriveBoundRequirementItems", () => {
  it("returns empty for null / undefined / empty projection", () => {
    expect(deriveBoundRequirementItems(null)).toEqual([]);
    expect(deriveBoundRequirementItems(undefined)).toEqual([]);
    expect(deriveBoundRequirementItems(projection([]))).toEqual([]);
  });

  it("skips idle / unbound slots (requirement === null)", () => {
    const result = deriveBoundRequirementItems(
      projection([lane({ slotId: "slot-1", state: "idle", requirement: null })])
    );
    expect(result).toEqual([]);
  });

  it("includes every occupied state, not just bound/busy", () => {
    const states: SlotBindingState[] = ["bound", "busy", "unhealthy", "recovering", "draining"];
    const slots = states.map((state, i) =>
      lane({ slotId: `slot-${i}`, state, requirement: { id: `r${i}`, title: `R${i}` } })
    );
    const result = deriveBoundRequirementItems(projection(slots));
    expect(result).toHaveLength(5);
    expect(result.map((item) => item.requirementId).sort()).toEqual(["r0", "r1", "r2", "r3", "r4"]);
  });

  it("aggregates a requirement spanning multiple slots into one item with all slot chips", () => {
    const result = deriveBoundRequirementItems(
      projection([
        lane({ slotId: "slot-1", state: "bound", requirement: { id: "r1", title: "R1" } }),
        lane({ slotId: "slot-2", state: "busy", requirement: { id: "r1", title: "R1" } })
      ])
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ requirementId: "r1", title: "R1" });
    expect(result[0].slots).toEqual([
      { slotId: "slot-1", state: "bound" },
      { slotId: "slot-2", state: "busy" }
    ]);
  });
});
