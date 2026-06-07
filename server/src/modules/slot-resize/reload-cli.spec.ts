import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { test } from "vitest";

import { parseCcbReloadOutput } from "./reload-cli.js";

async function fixture(name: string): Promise<string> {
  return await readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
}

test("parseCcbReloadOutput parses add-window dry-run fixture", async () => {
  const result = parseCcbReloadOutput({
    stdout: await fixture("add-window-dry-run.stdout"),
    exitCode: 0
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "ok");
  assert.equal(result.dryRun, true);
  assert.equal(result.mutationEnabled, false);
  assert.equal(result.planClass, "add_window");
  assert.equal(result.safeToApply, false);
  assert.equal(result.futureSafeToApply, true);
  assert.equal(result.operations.length, 3);
  assert.deepEqual(result.operations[0], {
    raw: "op=add_window window=slot-4 agents=slot4_claude,slot4_codex reason=window exists only in new config",
    op: "add_window",
    window: "slot-4",
    agent: undefined,
    agents: ["slot4_claude", "slot4_codex"],
    reason: "window exists only in new config",
    fields: {
      op: "add_window",
      window: "slot-4",
      agents: "slot4_claude,slot4_codex",
      reason: "window exists only in new config"
    }
  });
  assert.equal(result.reasons[0], "add_window slot-4: window exists only in new config");
});

test("parseCcbReloadOutput parses add-window published fixture", async () => {
  const result = parseCcbReloadOutput({
    stdout: await fixture("add-window-published.stdout"),
    exitCode: 0
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "published");
  assert.equal(result.dryRun, false);
  assert.equal(result.mutationEnabled, true);
  assert.equal(result.planClass, "add_window");
  assert.equal(result.safeToApply, true);
  assert.equal(result.futureSafeToApply, true);
  assert.equal(result.operations.length, 3);
  assert.ok(result.diagnostics.includes("graph_published=true"));
});

test("parseCcbReloadOutput ignores unknown lines but preserves raw output", () => {
  const stdout = [
    "reload_status: published",
    "ignored_future_line: value",
    "plan_class: add_window",
    "safe_to_apply: true"
  ].join("\n");

  const result = parseCcbReloadOutput({ stdout, exitCode: 0 });

  assert.equal(result.ok, true);
  assert.equal(result.status, "published");
  assert.equal(result.planClass, "add_window");
  assert.equal(result.rawStdout, stdout);
});

test("parseCcbReloadOutput returns structured failure for malformed output", () => {
  const stdout = "this is not the reload line protocol\n";
  const result = parseCcbReloadOutput({ stdout, stderr: "bad", exitCode: 12 });

  assert.equal(result.ok, false);
  assert.equal(result.status, null);
  assert.equal(result.errorMessage, "unable to parse ccb reload output");
  assert.equal(result.rawStdout, stdout);
  assert.equal(result.rawStderr, "bad");
  assert.equal(result.exitCode, 12);
});
