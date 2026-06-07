import assert from "node:assert/strict";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, test, vi } from "vitest";

import { buildApp } from "../../app.js";
import { prisma } from "../../db/prisma.js";

async function resetDatabase(): Promise<void> {
  await prisma.anchorDispatchQueue.deleteMany();
  await prisma.eventJournal.deleteMany();
  await prisma.slotBinding.deleteMany();
  await prisma.task.deleteMany();
  await prisma.requirement.deleteMany();
  await prisma.anchorAllocation.deleteMany();
  await prisma.project.deleteMany();
}

async function createProjectRoot(): Promise<string> {
  return join(tmpdir(), `ccb-onboarding-${Date.now()}-${randomUUID()}`);
}

async function createProject(localPath: string, slotCount = 3): Promise<{ id: string; localPath: string }> {
  return await prisma.project.create({
    data: {
      name: "Onboarding Project",
      localPath,
      summary: "Project onboarding fixture",
      slotCount
    },
    select: {
      id: true,
      localPath: true
    }
  });
}

async function writeCcbConfig(projectRoot: string, agentName = "my_claude", provider = "claude"): Promise<void> {
  await mkdir(join(projectRoot, ".ccb"), { recursive: true });
  await writeFile(
    join(projectRoot, ".ccb", "ccb.config"),
    [
      "version = 2",
      `default_agents = ["${agentName}"]`,
      "",
      `[agents.${agentName}]`,
      `provider = "${provider}"`,
      'target = "."',
      'runtime_mode = "pane-backed"',
      ""
    ].join("\n"),
    "utf8"
  );
}

async function writeDocsStructureContract(projectRoot: string): Promise<void> {
  await mkdir(join(projectRoot, "docs", ".ccb"), { recursive: true });
  await writeFile(
    join(projectRoot, "docs", ".ccb", "docs-structure-contract.yaml"),
    "version: docs-structure-contract-v0.1\n",
    "utf8"
  );
}

async function writeDocumentMap(projectRoot: string): Promise<void> {
  await mkdir(join(projectRoot, "docs"), { recursive: true });
  await writeFile(join(projectRoot, "docs", "00_文档地图.md"), "# 文档地图\n", "utf8");
}

async function writeDocumentMapCache(projectRoot: string): Promise<void> {
  await mkdir(join(projectRoot, "docs", ".ccb", "index"), { recursive: true });
  await writeFile(
    join(projectRoot, "docs", ".ccb", "index", "document-map.json"),
    "{\"schema_version\":\"document-map-index-v0.1\",\"documents\":[]}\n",
    "utf8"
  );
}

async function writeMainTmuxSocket(projectRoot: string): Promise<string> {
  const ccbdDir = join(projectRoot, ".ccb", "ccbd");
  await mkdir(ccbdDir, { recursive: true });
  const tmuxSocketPath = join(ccbdDir, "tmux.sock");
  await writeFile(tmuxSocketPath, "mock tmux socket\n", "utf8");
  return tmuxSocketPath;
}

async function createMockCcbdSocket(
  projectRoot: string,
  handle: (request: Record<string, unknown>) => Record<string, unknown>
): Promise<{ socketPath: string; close: () => Promise<void> }> {
  const ccbdDir = join(projectRoot, ".ccb", "ccbd");
  await mkdir(ccbdDir, { recursive: true });
  const socketPath = join(ccbdDir, "ccbd.sock");
  await rm(socketPath, { force: true });
  const server = net.createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (!buffer.includes("\n")) return;
      const line = buffer.split("\n", 1)[0];
      const request = JSON.parse(line) as Record<string, unknown>;
      socket.write(`${JSON.stringify(handle(request))}\n`);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });

  return {
    socketPath,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(socketPath, { force: true });
    }
  };
}

beforeEach(async () => {
  await resetDatabase();
});

afterEach(async () => {
  await resetDatabase();
});

test("GET /api/projects/:projectId/onboarding-status reports runtime and knowledge-base readiness", async () => {
  const app = buildApp({ enableFileWatcher: false });
  const projectRoot = await createProjectRoot();
  const project = await createProject(projectRoot);

  try {
    const missingResponse = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/onboarding-status`
    });
    assert.equal(missingResponse.statusCode, 200);
    assert.equal(missingResponse.json().ccbRuntimeReady, false);
    assert.equal(missingResponse.json().knowledgeBaseReady, false);
    const manualCommand = missingResponse.json().manualCommand as string;
    assert.ok(manualCommand.includes(`cd ${projectRoot}`), "manualCommand 应包含 cd 到项目根");
    assert.ok(manualCommand.includes("mkdir -p .ccb"), "manualCommand 应创建 .ccb 目录");
    assert.ok(manualCommand.includes("cat > .ccb/ccb.config"), "manualCommand 应写入 ccb.config");
    assert.ok(manualCommand.includes(`[windows]`), "manualCommand 应包含 v7 windows topology");
    assert.ok(manualCommand.includes(`slot-3 = "slot3_claude:claude; slot3_codex:codex"`), "manualCommand 应包含 3 个业务 slot");
    assert.ok(!manualCommand.includes("[ui.sidebar.view]"), "manualCommand 不应包含动态 slot tips 投影");
    assert.ok(/\bccb\s*$/m.test(manualCommand) || manualCommand.trim().endsWith("ccb") || manualCommand.includes("EOF\n"), "manualCommand 应在 heredoc 后启动 ccb");

    await writeCcbConfig(projectRoot);
    const runtimeResponse = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/onboarding-status`
    });
    assert.equal(runtimeResponse.statusCode, 200);
    assert.equal(runtimeResponse.json().ccbRuntimeReady, true);
    assert.equal(runtimeResponse.json().knowledgeBaseReady, false);

    await writeDocsStructureContract(projectRoot);
    const contractOnlyResponse = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/onboarding-status`
    });
    assert.equal(contractOnlyResponse.statusCode, 200);
    assert.equal(contractOnlyResponse.json().knowledgeBaseReady, false);

    await writeDocumentMap(projectRoot);
    const readyResponse = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/onboarding-status`
    });
    assert.equal(readyResponse.statusCode, 200);
    assert.equal(readyResponse.json().ccbRuntimeReady, true);
    assert.equal(readyResponse.json().knowledgeBaseReady, true);
    assert.equal(readyResponse.json().knowledgeBaseRootPath, join(projectRoot, "docs"));
    assert.match(readyResponse.json().checkedAt, /^\d{4}-\d{2}-\d{2}T/);

    const missingProjectResponse = await app.inject({
      method: "GET",
      url: "/api/projects/missing-project/onboarding-status"
    });
    assert.equal(missingProjectResponse.statusCode, 404);
  } finally {
    await app.close();
  }
});

test("GET /api/projects/:projectId/onboarding-status accepts generated document-map cache", async () => {
  const app = buildApp({ enableFileWatcher: false });
  const projectRoot = await createProjectRoot();
  const project = await createProject(projectRoot);

  try {
    await writeDocsStructureContract(projectRoot);
    await writeDocumentMapCache(projectRoot);

    const response = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/onboarding-status`
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().knowledgeBaseReady, true);
  } finally {
    await app.close();
  }
});

test("GET /api/projects/:projectId/onboarding-status lazily renders the project slotCount template", async () => {
  const app = buildApp({ enableFileWatcher: false });
  const projectRoot = await createProjectRoot();
  const project = await createProject(projectRoot, 4);

  try {
    const response = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/onboarding-status`
    });

    assert.equal(response.statusCode, 200);
    const manualCommand = response.json().manualCommand as string;
    assert.ok(manualCommand.includes(`slot-4 = "slot4_claude:claude; slot4_codex:codex"`));
    assert.ok(manualCommand.includes("[agents.slot4_codex]"));
  } finally {
    await app.close();
  }
});

test("GET /api/projects/:projectId/project-ccbd/status exposes managed config drift for UI confirmation", async () => {
  const app = buildApp({ enableFileWatcher: false });
  const projectRoot = await createProjectRoot();
  const project = await createProject(projectRoot);
  await writeCcbConfig(projectRoot, "legacy_claude", "claude");

  try {
    const response = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/project-ccbd/status`
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().projectId, project.id);
    assert.equal(response.json().startupBlocked, true);
    assert.equal(response.json().config.drift.requiresUserConfirmation, true);
    assert.match(response.json().config.drift.diff, /\+ main = "main_claude:claude; main_codex:codex"/);

    const missingProjectResponse = await app.inject({
      method: "GET",
      url: "/api/projects/missing-project/project-ccbd/status"
    });
    assert.equal(missingProjectResponse.statusCode, 404);
  } finally {
    await app.close();
  }
});

test("POST /api/projects/:projectId/project-ccbd/confirm-restore restores config and starts project ccbd", async () => {
  const confirmRestore = vi.fn(async (projectId: string) => ({
    runtime: {
      projectId,
      projectRoot: "/tmp/project-root",
      socketPath: "/tmp/project-root/.ccb/ccbd/ccbd.sock",
      tmuxSocketPath: "/tmp/project-root/.ccb/ccbd/tmux.sock",
      topologySignature: "sig",
      status: "ready"
    },
    status: {
      projectId,
      projectRoot: "/tmp/project-root",
      socketPath: "/tmp/project-root/.ccb/ccbd/ccbd.sock",
      tmuxSocketPath: "/tmp/project-root/.ccb/ccbd/tmux.sock",
      startupBlocked: false,
      config: {
        path: "/tmp/project-root/.ccb/ccb.config",
        exists: true,
        coreSignature: "sig",
        drift: null
      }
    }
  }));
  const app = buildApp({
    enableFileWatcher: false,
    projectOnboarding: {
      projectCcbdManager: {
        getStatus: vi.fn(),
        confirmRestore
      }
    }
  });
  const projectRoot = await createProjectRoot();
  const project = await createProject(projectRoot);

  try {
    const response = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/project-ccbd/confirm-restore`
    });

    assert.equal(response.statusCode, 200, response.body);
    assert.equal(confirmRestore.mock.calls.length, 1);
    assert.equal(confirmRestore.mock.calls[0]?.[0], project.id);
    assert.equal(response.json().runtime.status, "ready");
    assert.equal(response.json().status.startupBlocked, false);

    const missingProjectResponse = await app.inject({
      method: "POST",
      url: "/api/projects/missing-project/project-ccbd/confirm-restore"
    });
    assert.equal(missingProjectResponse.statusCode, 404);
  } finally {
    await app.close();
  }
});

test("POST /api/projects/:projectId/init-knowledge-base submits /ccb:su-init to the configured claude agent", async () => {
  const app = buildApp({ enableFileWatcher: false });
  const projectRoot = await createProjectRoot();
  const project = await createProject(projectRoot);
  await writeCcbConfig(projectRoot, "project_claude", "claude");
  let submitRequest: Record<string, unknown> | null = null;
  const socket = await createMockCcbdSocket(projectRoot, (request) => {
    submitRequest = request;
    return {
      api_version: 2,
      ok: true,
      job_id: "job_su_init",
      submission_id: "sub_su_init",
      trace_ref: "trace_su_init"
    };
  });

  try {
    const response = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/init-knowledge-base`
    });

    assert.equal(response.statusCode, 202);
    assert.equal(response.json().jobId, "job_su_init");
    assert.equal(response.json().claudeAgentName, "project_claude");
    assert.match(response.json().submittedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.ok(submitRequest);
    assert.equal(submitRequest.op, "submit");
    assert.deepEqual((submitRequest.request as Record<string, unknown>).to_agent, "project_claude");
    assert.deepEqual((submitRequest.request as Record<string, unknown>).body, "/ccb:su-init");
    assert.deepEqual((submitRequest.request as Record<string, unknown>).from_actor, "system");
  } finally {
    await socket.close();
    await app.close();
  }
});

test("POST /api/projects/:projectId/init-knowledge-base supports YAML-style agents config", async () => {
  const app = buildApp({ enableFileWatcher: false });
  const projectRoot = await createProjectRoot();
  const project = await createProject(projectRoot);
  await mkdir(join(projectRoot, ".ccb"), { recursive: true });
  await writeFile(
    join(projectRoot, ".ccb", "ccb.config"),
    [
      "agents:",
      "  project_claude:",
      "    provider: claude",
      "  project_codex:",
      "    provider: codex",
      ""
    ].join("\n"),
    "utf8"
  );
  let submitRequest: Record<string, unknown> | null = null;
  const socket = await createMockCcbdSocket(projectRoot, (request) => {
    submitRequest = request;
    return {
      api_version: 2,
      ok: true,
      job_id: "job_yaml_su_init"
    };
  });

  try {
    const response = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/init-knowledge-base`
    });

    assert.equal(response.statusCode, 202);
    assert.equal(response.json().claudeAgentName, "project_claude");
    assert.ok(submitRequest);
    assert.equal((submitRequest.request as Record<string, unknown>).to_agent, "project_claude");
  } finally {
    await socket.close();
    await app.close();
  }
});

test("POST /api/projects/:projectId/init-knowledge-base handles missing runtime, missing claude agent, and submit failure", async () => {
  const app = buildApp({ enableFileWatcher: false });
  const noRuntimeRoot = await createProjectRoot();
  const noRuntimeProject = await createProject(noRuntimeRoot);
  await writeCcbConfig(noRuntimeRoot);

  const noRuntimeResponse = await app.inject({
    method: "POST",
    url: `/api/projects/${noRuntimeProject.id}/init-knowledge-base`
  });
  assert.equal(noRuntimeResponse.statusCode, 409);
  assert.equal(noRuntimeResponse.json().code, "ccb_runtime_missing");

  const noAgentRoot = await createProjectRoot();
  const noAgentProject = await createProject(noAgentRoot);
  await writeCcbConfig(noAgentRoot, "project_codex", "codex");
  const noAgentSocket = await createMockCcbdSocket(noAgentRoot, () => ({ api_version: 2, ok: true, job_id: "unused" }));

  try {
    const noAgentResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${noAgentProject.id}/init-knowledge-base`
    });
    assert.equal(noAgentResponse.statusCode, 409);
    assert.equal(noAgentResponse.json().code, "claude_agent_missing");
  } finally {
    await noAgentSocket.close();
  }

  const submitFailRoot = await createProjectRoot();
  const submitFailProject = await createProject(submitFailRoot);
  await writeCcbConfig(submitFailRoot);
  const failSocket = await createMockCcbdSocket(submitFailRoot, () => ({
    api_version: 2,
    ok: false,
    error: "queue busy"
  }));

  try {
    const failResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${submitFailProject.id}/init-knowledge-base`
    });
    assert.equal(failResponse.statusCode, 503);
    assert.equal(failResponse.json().code, "ccbd_submit_failed");
  } finally {
    await failSocket.close();
    await app.close();
  }
});

test("GET /api/projects/:projectId/init-job-status normalizes ccbd job state and failure reason", async () => {
  const app = buildApp({ enableFileWatcher: false });
  const projectRoot = await createProjectRoot();
  const project = await createProject(projectRoot);
  await writeCcbConfig(projectRoot);
  const socket = await createMockCcbdSocket(projectRoot, (request) => {
    assert.equal(request.op, "get");
    return {
      api_version: 2,
      ok: true,
      job_id: "job_su_init",
      status: "error",
      message: "kernel snapshot missing"
    };
  });

  try {
    const response = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/init-job-status?jobId=job_su_init`
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(
      {
        jobId: response.json().jobId,
        status: response.json().status,
        reason: response.json().reason
      },
      {
        jobId: "job_su_init",
        status: "failed",
        reason: "kernel snapshot missing"
      }
    );

    const badRequest = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/init-job-status`
    });
    assert.equal(badRequest.statusCode, 400);
  } finally {
    await socket.close();
    await app.close();
  }
});

test("POST /api/projects/:projectId/main-terminal/spawn returns native terminal spawn result", async () => {
  const projectRoot = await createProjectRoot();
  const project = await createProject(projectRoot);
  await writeMainTmuxSocket(projectRoot);
  const spawnResult = {
    spawned: true,
    attempted: ["xterm -e bash -lc tmux"],
    fallbackCommand: `tmux -S ${join(projectRoot, ".ccb", "ccbd", "tmux.sock")} attach -t ccb-main`,
    sessionName: "ccb-main",
    socketPath: join(projectRoot, ".ccb", "ccbd", "tmux.sock"),
    anchorPath: projectRoot
  };
  const nativeTerminal = {
    spawn: vi.fn(async () => spawnResult)
  };
  const app = buildApp({
    enableFileWatcher: false,
    projectOnboarding: {
      nativeTerminal
    }
  });
  try {
    const response = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/main-terminal/spawn`,
      payload: {}
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), spawnResult);
    assert.deepEqual(nativeTerminal.spawn.mock.calls[0]?.[0], {
      anchorPath: projectRoot
    });
  } finally {
    await app.close();
  }
});

test("POST /api/projects/:projectId/main-terminal/spawn returns 404 for missing project", async () => {
  const nativeTerminal = {
    spawn: vi.fn()
  };
  const app = buildApp({
    enableFileWatcher: false,
    projectOnboarding: {
      nativeTerminal
    }
  });

  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/projects/missing-project/main-terminal/spawn",
      payload: {}
    });

    assert.equal(response.statusCode, 404);
    assert.equal(nativeTerminal.spawn.mock.calls.length, 0);
  } finally {
    await app.close();
  }
});

test("POST /api/projects/:projectId/main-terminal/spawn returns 409 when main tmux socket is missing", async () => {
  const nativeTerminal = {
    spawn: vi.fn()
  };
  const app = buildApp({
    enableFileWatcher: false,
    projectOnboarding: {
      nativeTerminal
    }
  });
  const projectRoot = await createProjectRoot();
  const project = await createProject(projectRoot);

  try {
    const response = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/main-terminal/spawn`,
      payload: {}
    });

    assert.equal(response.statusCode, 409);
    assert.equal(response.json().code, "ccb_runtime_missing");
    assert.equal(nativeTerminal.spawn.mock.calls.length, 0);
  } finally {
    await app.close();
  }
});

test("POST /api/projects/:projectId/main-terminal/spawn returns spawn failure details", async () => {
  const projectRoot = await createProjectRoot();
  const project = await createProject(projectRoot);
  await writeMainTmuxSocket(projectRoot);
  const spawnResult = {
    spawned: false,
    attempted: ["gnome-terminal (not found)", "konsole (not found)", "xterm (not found)"],
    reason: "no supported terminal emulator found",
    fallbackCommand: `tmux -S ${join(projectRoot, ".ccb", "ccbd", "tmux.sock")} attach -t ccb-main`,
    sessionName: "ccb-main",
    socketPath: join(projectRoot, ".ccb", "ccbd", "tmux.sock"),
    anchorPath: projectRoot
  };
  const nativeTerminal = {
    spawn: vi.fn(async () => spawnResult)
  };
  const app = buildApp({
    enableFileWatcher: false,
    projectOnboarding: {
      nativeTerminal
    }
  });
  try {
    const response = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/main-terminal/spawn`,
      payload: {}
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().spawned, false);
    assert.deepEqual(response.json().attempted, spawnResult.attempted);
    assert.equal(response.json().reason, "no supported terminal emulator found");
  } finally {
    await app.close();
  }
});

test("POST /api/projects/:projectId/main-terminal/spawn rejects non-local requests", async () => {
  const nativeTerminal = {
    spawn: vi.fn()
  };
  const app = buildApp({
    enableFileWatcher: false,
    projectOnboarding: {
      nativeTerminal
    }
  });

  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/projects/project-1/main-terminal/spawn",
      remoteAddress: "10.0.0.20",
      payload: {}
    });

    assert.equal(response.statusCode, 403);
    assert.equal(nativeTerminal.spawn.mock.calls.length, 0);
  } finally {
    await app.close();
  }
});
