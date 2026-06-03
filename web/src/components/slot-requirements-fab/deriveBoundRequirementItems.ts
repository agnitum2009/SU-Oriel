import type { SlotBindingState, SlotProjectionView } from "../../lib/console-api.js";

/** One slot a requirement currently occupies. */
export interface BoundRequirementSlotRef {
  slotId: string;
  state: SlotBindingState;
}

/** A requirement that currently occupies at least one slot. */
export interface BoundRequirementItem {
  requirementId: string;
  title: string;
  /** Every slot this requirement occupies (a requirement may span multiple slots). */
  slots: BoundRequirementSlotRef[];
}

/**
 * Derive the "绑定 slot 的需求" list from a slots projection.
 *
 * - Keeps every business slot whose `requirement` is non-null, i.e. all occupied
 *   states (bound / busy / unhealthy / recovering / draining). `idle` slots have a
 *   null requirement and are skipped.
 * - The coordination `main` lane is not part of `projection.slots`, so it is
 *   naturally excluded. Queued items (`projection.queue` / `slot.queued`) are not
 *   occupying a slot and are intentionally not included.
 * - A requirement spanning multiple slots is aggregated into a single item that
 *   carries one chip per occupied slot (slot info is preserved, not dropped).
 */
export function deriveBoundRequirementItems(
  projection: SlotProjectionView | null | undefined
): BoundRequirementItem[] {
  const slots = projection?.slots;
  if (!slots || slots.length === 0) {
    return [];
  }

  const byRequirement = new Map<string, BoundRequirementItem>();
  for (const slot of slots) {
    const requirement = slot.requirement;
    if (!requirement) {
      continue; // idle / unbound slot
    }
    let item = byRequirement.get(requirement.id);
    if (!item) {
      item = { requirementId: requirement.id, title: requirement.title, slots: [] };
      byRequirement.set(requirement.id, item);
    }
    item.slots.push({ slotId: slot.slotId, state: slot.state });
  }

  return Array.from(byRequirement.values());
}
