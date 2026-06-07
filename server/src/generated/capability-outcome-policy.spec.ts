import assert from "node:assert/strict";

import { test } from "vitest";

import { resolveCapabilityOutcomePolicy } from "./capability-outcome-policy.js";

test("generated capability outcome policy includes requirement promote delivering", () => {
  const policy = resolveCapabilityOutcomePolicy({
    capabilityId: "requirement.promote",
    outcomeType: "delivering",
    subjectType: "requirement"
  });

  assert.ok(policy);
  assert.equal(policy.policy_id, "requirement.promote:delivering:requirement");
  assert.equal(policy.write_target, "requirement_md");
  assert.equal(policy.state_effects.status, "set:delivering");
});
