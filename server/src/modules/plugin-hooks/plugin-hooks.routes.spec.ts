import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, test } from "vitest";

import { buildApp } from "../../app.js";
import { prisma } from "../../db/prisma.js";

const tmpRoots: string[] = [];

function envelope(projectRoot: string, overrides: Record<string, unknown> = {}) {
  return {
    schema_version: "plugin-hook-v0.1",
    source: "ccb-claude-plugin",
    project_root: projectRoot,
    journal_path: "docs/.ccb/events/journal.jsonl",
    event_hash: "a".repeat(64),
    event: {
      type: "file_written",
      subject_type: "requirement",
      subject_id: "req-1",
      payload: { path: "docs/02_需求设计/req-1-需求.md" },
      idempotency_key: "hook-route-test",
      emitted_at: "2026-05-22T10:00:00.000Z",
      source_actor: "ccb_claude"
    },
    ...overrides
  };
}

async function createProjectFixture() {
  const localPath = await mkdtemp(join(tmpdir(), "ccb-plugin-hook-route-"));
  tmpRoots.push(localPath);
  const project = await prisma.project.create({
    data: {
      name: `plugin-hook-route-${randomUUID()}`,
      localPath,
      updatedAt: new Date()
    }
  });
  return { project, localPath };
}

async function waitForCondition(assertion: () => boolean, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (assertion()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("等待条件超时");
}

function pluginJournalEvent(overrides: Record<string, unknown> = {}) {
  return {
    type: "codex_receipt_ready",
    subject_type: "subtask",
    subject_id: "task-watermark",
    payload: { receipt_summary: "done" },
    idempotency_key: `watermark-${randomUUID()}`,
    emitted_at: "2026-05-22T10:00:00.000Z",
    source_actor: "ccb_codex",
    ...overrides
  };
}

async function writePluginJournal(projectRoot: string, lines: string[]): Promise<void> {
  const journalDir = join(projectRoot, "docs", ".ccb", "events");
  await mkdir(journalDir, { recursive: true });
  await writeFile(join(journalDir, "journal.jsonl"), `${lines.join("\n")}\n`, "utf8");
}

function pluginJournalEventId(event: { idempotency_key?: unknown }, rawLine: string): string {
  const idempotencyKey = typeof event.idempotency_key === "string" ? event.idempotency_key.trim() : "";
  const hash = createHash("sha256")
    .update(idempotencyKey ? `idempotency:${idempotencyKey}` : rawLine)
    .digest("hex");
  return `plugin:${hash}`;
}

afterEach(async () => {
  await prisma.project.deleteMany({
    where: {
      name: {
        startsWith: "plugin-hook-route-"
      }
    }
  });
  await Promise.all(tmpRoots.map((root) => rm(root, { recursive: true, force: true })));
  tmpRoots.length = 0;
});

test("POST /api/plugin-hooks/event-journal queues scan when journal watermark is ahead of DB and stops after ingestion catches up", async () => {
  const { project, localPath } = await createProjectFixture();
  const journalEvent = pluginJournalEvent({ idempotency_key: "watermark-catch-up" });
  const rawLine = JSON.stringify(journalEvent);
  await writePluginJournal(localPath, [rawLine]);
  const scans: string[] = [];
  const app = buildApp({
    enableFileWatcher: false,
    pluginHooks: {
      debounceMs: 20,
      journalReconcileCooldownMs: 60_000,
      scanProject: async (_prisma, projectId) => {
        scans.push(projectId);
      }
    }
  });

  try {
    const first = await app.inject({
      method: "POST",
      url: "/api/plugin-hooks/event-journal",
      payload: envelope(localPath, { event: journalEvent })
    });

    assert.equal(first.statusCode, 202, first.body);
    assert.equal(first.json().scanQueued, true);
    await waitForCondition(() => scans.length === 1);

    await prisma.eventJournal.create({
      data: {
        eventId: pluginJournalEventId(journalEvent, rawLine),
        eventType: journalEvent.type,
        projectId: project.id,
        subjectType: journalEvent.subject_type,
        subjectId: journalEvent.subject_id,
        payloadJson: JSON.stringify(journalEvent.payload),
        emittedAt: new Date(journalEvent.emitted_at),
        sourceActor: journalEvent.source_actor,
        sourceComponent: "ccb-claude-plugin",
        idempotencyKey: journalEvent.idempotency_key
      }
    });

    const second = await app.inject({
      method: "POST",
      url: "/api/plugin-hooks/event-journal",
      payload: envelope(localPath, {
        event_hash: "b".repeat(64),
        event: { ...journalEvent, idempotency_key: "watermark-catch-up-hook-2" }
      })
    });

    assert.equal(second.statusCode, 202, second.body);
    assert.equal(second.json().scanQueued, false);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(scans, [project.id]);
  } finally {
    await app.close();
  }
});

test("POST /api/plugin-hooks/event-journal applies journal watermark cooldown to avoid repeated scans", async () => {
  const { project, localPath } = await createProjectFixture();
  const journalEvent = pluginJournalEvent({ idempotency_key: "watermark-cooldown" });
  await writePluginJournal(localPath, [JSON.stringify(journalEvent)]);
  const scans: string[] = [];
  const app = buildApp({
    enableFileWatcher: false,
    pluginHooks: {
      debounceMs: 20,
      journalReconcileCooldownMs: 60_000,
      scanProject: async (_prisma, projectId) => {
        scans.push(projectId);
      }
    }
  });

  try {
    const first = await app.inject({
      method: "POST",
      url: "/api/plugin-hooks/event-journal",
      payload: envelope(localPath, { event: journalEvent })
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/plugin-hooks/event-journal",
      payload: envelope(localPath, {
        event_hash: "c".repeat(64),
        event: { ...journalEvent, idempotency_key: "watermark-cooldown-hook-2" }
      })
    });

    assert.equal(first.statusCode, 202, first.body);
    assert.equal(second.statusCode, 202, second.body);
    assert.equal(first.json().scanQueued, true);
    assert.equal(second.json().scanQueued, false);
    await waitForCondition(() => scans.length === 1);
    assert.deepEqual(scans, [project.id]);
  } finally {
    await app.close();
  }
});

test("POST /api/plugin-hooks/event-journal skips reconcile scans for consecutive bad journal lines", async () => {
  const { localPath } = await createProjectFixture();
  await writePluginJournal(localPath, ["{bad", "{still_bad"]);
  const scans: string[] = [];
  const app = buildApp({
    enableFileWatcher: false,
    pluginHooks: {
      debounceMs: 20,
      journalReconcileCooldownMs: 0,
      scanProject: async (_prisma, projectId) => {
        scans.push(projectId);
      }
    }
  });

  try {
    const first = await app.inject({
      method: "POST",
      url: "/api/plugin-hooks/event-journal",
      payload: envelope(localPath, { event: pluginJournalEvent({ idempotency_key: "bad-hook-1" }) })
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/plugin-hooks/event-journal",
      payload: envelope(localPath, {
        event_hash: "d".repeat(64),
        event: pluginJournalEvent({ idempotency_key: "bad-hook-2" })
      })
    });

    assert.equal(first.statusCode, 202, first.body);
    assert.equal(second.statusCode, 202, second.body);
    assert.equal(first.json().scanQueued, false);
    assert.equal(second.json().scanQueued, false);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(scans, []);
  } finally {
    await app.close();
  }
});

test("POST /api/plugin-hooks/event-journal queues fallback scan for unknown artifact events", async () => {
  const { localPath } = await createProjectFixture();
  const scans: string[] = [];
  const app = buildApp({
    enableFileWatcher: false,
    pluginHooks: {
      debounceMs: 20,
      scanProject: async (_prisma, projectId) => {
        scans.push(projectId);
      }
    }
  });

  try {
    const first = await app.inject({
      method: "POST",
      url: "/api/plugin-hooks/event-journal",
      payload: envelope(localPath, {
        event: {
          type: "file_written",
          subject_type: "project",
          subject_id: "project",
          payload: { path: "README.md", resource_type: "unknown" },
          idempotency_key: "unknown-artifact-1",
          emitted_at: "2026-05-22T10:00:00.000Z",
          source_actor: "ccb_claude"
        }
      })
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/plugin-hooks/event-journal",
      payload: envelope(localPath, {
        event_hash: "b".repeat(64),
        event: {
          type: "file_written",
          subject_type: "project",
          subject_id: "project",
          payload: { path: "README.md", resource_type: "unknown" },
          idempotency_key: "unknown-artifact-2",
          emitted_at: "2026-05-22T10:00:01.000Z",
          source_actor: "ccb_claude"
        }
      })
    });

    assert.equal(first.statusCode, 202, first.body);
    assert.equal(second.statusCode, 202, second.body);
    await waitForCondition(() => scans.length === 1);
  } finally {
    await app.close();
  }
});

test("POST /api/plugin-hooks/event-journal immediately reindexes requirement file_written events", async () => {
  const { project, localPath } = await createProjectFixture();
  const reindexed: Array<{ projectId: string; requirementId: string }> = [];
  const scans: string[] = [];
  const app = buildApp({
    enableFileWatcher: false,
    pluginHooks: {
      debounceMs: 20,
      reindexRequirementFromMarkdown: async (_prisma, projectId, requirementId) => {
        reindexed.push({ projectId, requirementId });
      },
      scanProject: async (_prisma, projectId) => {
        scans.push(projectId);
      }
    }
  });

  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/plugin-hooks/event-journal",
      payload: envelope(localPath)
    });

    assert.equal(response.statusCode, 202, response.body);
    assert.deepEqual(reindexed, [{ projectId: project.id, requirementId: "req-1" }]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(scans, []);
  } finally {
    await app.close();
  }
});

test("POST /api/plugin-hooks/event-journal dispatches technical design file_written by payload path", async () => {
  const { project, localPath } = await createProjectFixture();
  const reindexed: Array<{ projectId: string; requirementId: string; path: string }> = [];
  const app = buildApp({
    enableFileWatcher: false,
    pluginHooks: {
      debounceMs: 20,
      reindexRequirementDesignDocFromMarkdown: async (_prisma, projectId, path, requirementId) => {
        reindexed.push({ projectId, requirementId, path });
      },
      reindexRequirementFromMarkdown: async () => {
        throw new Error("requirement md reindex should not be called for design docs");
      }
    }
  });

  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/plugin-hooks/event-journal",
      payload: envelope(localPath, {
        event: {
          type: "file_written",
          subject_type: "requirement",
          subject_id: "req-1",
          payload: {
            doc_type: "technical_design",
            path: `${localPath}/docs/03_开发计划/2026-05-25-req-1-技术设计.md`
          },
          idempotency_key: "design-doc-1",
          emitted_at: "2026-05-22T10:00:00.000Z",
          source_actor: "ccb_claude"
        }
      })
    });

    assert.equal(response.statusCode, 202, response.body);
    assert.deepEqual(reindexed, [
      {
        projectId: project.id,
        requirementId: "req-1",
        path: `${localPath}/docs/03_开发计划/2026-05-25-req-1-技术设计.md`
      }
    ]);
  } finally {
    await app.close();
  }
});

test("POST /api/plugin-hooks/event-journal queues scan for dev_task docs under docs/03", async () => {
  const { project, localPath } = await createProjectFixture();
  const scans: string[] = [];
  const app = buildApp({
    enableFileWatcher: false,
    pluginHooks: {
      debounceMs: 20,
      reindexRequirementFromMarkdown: async () => {
        throw new Error("requirement md reindex should not be called for dev_task docs");
      },
      scanProject: async (_prisma, projectId) => {
        scans.push(projectId);
      }
    }
  });

  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/plugin-hooks/event-journal",
      payload: envelope(localPath, {
        event: {
          type: "file_written",
          subject_type: "requirement",
          subject_id: "req-1",
          payload: {
            path: "docs/03_开发计划/req-1-dev-task.md"
          },
          idempotency_key: "dev-task-doc-1",
          emitted_at: "2026-05-22T10:00:00.000Z",
          source_actor: "ccb_claude"
        }
      })
    });

    assert.equal(response.statusCode, 202, response.body);
    await waitForCondition(() => scans.length === 1);
    assert.deepEqual(scans, [project.id]);
  } finally {
    await app.close();
  }
});

test("POST /api/plugin-hooks/event-journal dispatches breakdown draft events to single-requirement reindex", async () => {
  const { project, localPath } = await createProjectFixture();
  const reindexed: Array<{ projectId: string; requirementId: string }> = [];
  const app = buildApp({
    enableFileWatcher: false,
    pluginHooks: {
      debounceMs: 20,
      reindexBreakdownDraftForRequirement: async (_prisma, projectId, requirementId) => {
        reindexed.push({ projectId, requirementId });
      }
    }
  });

  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/plugin-hooks/event-journal",
      payload: envelope(localPath, {
        event: {
          type: "breakdown_draft_updated",
          subject_type: "requirement",
          subject_id: "req-1",
          payload: {
            path: "docs/.ccb/drafts/breakdown/req-1.json",
            hash: "draft-hash"
          },
          idempotency_key: "breakdown-draft-1",
          emitted_at: "2026-05-22T10:00:00.000Z",
          source_actor: "ccb_claude"
        }
      })
    });

    assert.equal(response.statusCode, 202, response.body);
    assert.deepEqual(reindexed, [{ projectId: project.id, requirementId: "req-1" }]);
  } finally {
    await app.close();
  }
});

test("POST /api/plugin-hooks/event-journal fail-opens precise reindex and queues fallback scan", async () => {
  const { project, localPath } = await createProjectFixture();
  const scans: string[] = [];
  const app = buildApp({
    enableFileWatcher: false,
    pluginHooks: {
      debounceMs: 20,
      reindexRequirementDesignDocFromMarkdown: async () => {
        throw new Error("precise reindex failed");
      },
      scanProject: async (_prisma, projectId) => {
        scans.push(projectId);
      }
    }
  });

  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/plugin-hooks/event-journal",
      payload: envelope(localPath, {
        event: {
          type: "file_written",
          subject_type: "requirement",
          subject_id: "req-1",
          payload: {
            doc_type: "technical_design",
            path: "docs/03_开发计划/2026-05-25-req-1-技术设计.md"
          },
          idempotency_key: "design-doc-fail-open",
          emitted_at: "2026-05-22T10:00:00.000Z",
          source_actor: "ccb_claude"
        }
      })
    });

    assert.equal(response.statusCode, 202, response.body);
    await waitForCondition(() => scans.length === 1);
    assert.deepEqual(scans, [project.id]);
  } finally {
    await app.close();
  }
});

test("POST /api/plugin-hooks/event-journal rejects non-localhost callers", async () => {
  const { localPath } = await createProjectFixture();
  const app = buildApp({ enableFileWatcher: false });

  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/plugin-hooks/event-journal",
      remoteAddress: "10.0.0.20",
      payload: envelope(localPath)
    });

    assert.equal(response.statusCode, 403);
  } finally {
    await app.close();
  }
});

test("POST /api/plugin-hooks/event-journal rejects browser origin and referer headers", async () => {
  const { localPath } = await createProjectFixture();
  const app = buildApp({ enableFileWatcher: false });

  try {
    const originResponse = await app.inject({
      method: "POST",
      url: "/api/plugin-hooks/event-journal",
      headers: { origin: "http://localhost:5173" },
      payload: envelope(localPath)
    });
    const refererResponse = await app.inject({
      method: "POST",
      url: "/api/plugin-hooks/event-journal",
      headers: { referer: "http://localhost:5173/requirements" },
      payload: envelope(localPath)
    });

    assert.equal(originResponse.statusCode, 403);
    assert.equal(refererResponse.statusCode, 403);
  } finally {
    await app.close();
  }
});

test("POST /api/plugin-hooks/event-journal validates envelope shape", async () => {
  const { localPath } = await createProjectFixture();
  const app = buildApp({ enableFileWatcher: false });

  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/plugin-hooks/event-journal",
      payload: envelope(localPath, { event_hash: "not-a-hash" })
    });

    assert.equal(response.statusCode, 400);
    assert.match(response.body, /hook envelope/);
  } finally {
    await app.close();
  }
});

test("POST /api/plugin-hooks/event-journal acks unknown project roots without scan", async () => {
  const scans: string[] = [];
  const app = buildApp({
    enableFileWatcher: false,
    pluginHooks: {
      debounceMs: 20,
      scanProject: async (_prisma, projectId) => {
        scans.push(projectId);
      }
    }
  });

  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/plugin-hooks/event-journal",
      payload: envelope(join(tmpdir(), `ccb-plugin-hook-missing-${randomUUID()}`))
    });

    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().projectFound, false);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(scans, []);
  } finally {
    await app.close();
  }
});

test("POST /api/plugin-hooks/event-journal refreshes SlotBinding activity for capability outcomes", async () => {
  const { project, localPath } = await createProjectFixture();
  const requirement = await prisma.requirement.create({
    data: {
      projectId: project.id,
      title: "Hook activity requirement",
      description: "Hook fixture",
      status: "planning"
    }
  });
  const binding = await prisma.slotBinding.create({
    data: {
      projectId: project.id,
      slotId: "slot-1",
      requirementId: requirement.id,
      state: "bound",
      boundAt: new Date("2026-05-20T00:00:00.000Z"),
      lastActivityAt: new Date("2026-05-20T00:00:00.000Z")
    }
  });
  const app = buildApp({
    enableFileWatcher: false,
    pluginHooks: {
      debounceMs: 20,
      scanProject: async () => undefined
    }
  });

  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/plugin-hooks/event-journal",
      payload: envelope(localPath, {
        event: {
          type: "capability_outcome_applied",
          subject_type: "requirement",
          subject_id: requirement.id,
          payload: { capability_id: "requirement.analysis", outcome_type: "passed" },
          idempotency_key: "capability-outcome-1",
          emitted_at: "2026-05-23T10:00:00.000Z",
          source_actor: "slot1_claude"
        }
      })
    });

    assert.equal(response.statusCode, 202, response.body);
    const updated = await prisma.slotBinding.findUniqueOrThrow({ where: { id: binding.id } });
    assert.equal(updated.lastActivityAt?.toISOString(), "2026-05-23T10:00:00.000Z");
  } finally {
    await app.close();
  }
});
