import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { FastifyInstance } from "fastify";

import { prisma } from "../../db/prisma.js";
import { assertLocalRequest } from "../ai-cli/ai-cli.guard.js";
import {
  NativeAnchorTerminalService,
  type NativeAnchorTerminalSpawnResult
} from "../anchor-terminal/native-terminal.service.js";
import { CcbdClientService } from "../ccbd-client/ccbd-client.service.js";
import {
  buildManagedCcbConfig,
  parseSlotAgentOverridesJson,
  projectSlotTopology
} from "../project-ccbd/managed-config.service.js";
import { ProjectCcbdManager } from "../project-ccbd/project-ccbd-manager.js";

type InitJobStatus = "queued" | "running" | "completed" | "failed";
type MainProjectTerminal = {
  spawn(anchor: { anchorPath: string }): Promise<NativeAnchorTerminalSpawnResult>;
};

const CCB_CONFIG_RELATIVE_PATH = join(".ccb", "ccb.config");
const CCBD_SOCKET_RELATIVE_PATH = join(".ccb", "ccbd", "ccbd.sock");
const TMUX_SOCKET_RELATIVE_PATH = join(".ccb", "ccbd", "tmux.sock");
const KNOWLEDGE_BASE_ROOT_RELATIVE_PATH = "docs";
const DOCS_STRUCTURE_CONTRACT_RELATIVE_PATH = join("docs", ".ccb", "docs-structure-contract.yaml");
const DOC_MAP_RELATIVE_PATH = join("docs", "00_文档地图.md");
const DOC_MAP_CACHE_RELATIVE_PATH = join("docs", ".ccb", "index", "document-map.json");

type ProjectLookup = {
  id: string;
  localPath: string;
  slotCount: number;
  slotAgentOverridesJson: string | null;
};

function buildManualSetupCommand(project: ProjectLookup): string {
  const topology = projectSlotTopology(project.slotCount);
  const configTemplate = buildManagedCcbConfig(
    topology,
    {},
    { slotAgentOverrides: parseSlotAgentOverridesJson(project.slotAgentOverridesJson, topology) }
  );
  return [
    `cd ${project.localPath} && mkdir -p .ccb && cat > .ccb/ccb.config <<'EOF' && ccb`,
    configTemplate.trimEnd(),
    `EOF`
  ].join("\n");
}

export interface ProjectOnboardingRouteDependencies {
  nativeTerminal?: MainProjectTerminal;
  projectCcbdManager?: Pick<ProjectCcbdManager, "getStatus" | "confirmRestore"> & Partial<Pick<ProjectCcbdManager, "dispose">>;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function findProject(projectId: string): Promise<ProjectLookup | null> {
  return await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, localPath: true, slotCount: true, slotAgentOverridesJson: true }
  });
}

function buildOnboardingPaths(localPath: string): {
  ccbConfigPath: string;
  ccbdSocketPath: string;
  tmuxSocketPath: string;
  knowledgeBaseRootPath: string;
  docsStructureContractPath: string;
  docMapPath: string;
  docMapCachePath: string;
} {
  return {
    ccbConfigPath: join(localPath, CCB_CONFIG_RELATIVE_PATH),
    ccbdSocketPath: join(localPath, CCBD_SOCKET_RELATIVE_PATH),
    tmuxSocketPath: join(localPath, TMUX_SOCKET_RELATIVE_PATH),
    knowledgeBaseRootPath: join(localPath, KNOWLEDGE_BASE_ROOT_RELATIVE_PATH),
    docsStructureContractPath: join(localPath, DOCS_STRUCTURE_CONTRACT_RELATIVE_PATH),
    docMapPath: join(localPath, DOC_MAP_RELATIVE_PATH),
    docMapCachePath: join(localPath, DOC_MAP_CACHE_RELATIVE_PATH)
  };
}

async function isKnowledgeBaseReady(paths: {
  docsStructureContractPath: string;
  docMapPath: string;
  docMapCachePath: string;
}): Promise<boolean> {
  const [contractReady, docMapReady, docMapCacheReady] = await Promise.all([
    fileExists(paths.docsStructureContractPath),
    fileExists(paths.docMapPath),
    fileExists(paths.docMapCachePath)
  ]);
  return contractReady && (docMapReady || docMapCacheReady);
}

function parseQuotedValue(raw: string): string {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function stripInlineComment(rawLine: string): string {
  return rawLine.replace(/#.*/, "");
}

function parseYamlClaudeAgentName(configText: string): string | null {
  const lines = configText.split(/\r?\n/);
  let inAgents = false;
  let agentsIndent = 0;
  let currentAgent: { name: string; indent: number } | null = null;

  for (const rawLine of lines) {
    const withoutComment = stripInlineComment(rawLine);
    const trimmed = withoutComment.trim();
    if (!trimmed) {
      continue;
    }

    const indent = withoutComment.length - withoutComment.trimStart().length;
    if (!inAgents) {
      if (/^agents\s*:\s*$/.test(trimmed)) {
        inAgents = true;
        agentsIndent = indent;
      }
      continue;
    }

    if (indent <= agentsIndent) {
      break;
    }

    const agentSection = trimmed.match(/^([A-Za-z0-9_-]+)\s*:\s*$/);
    if (agentSection?.[1] && indent > agentsIndent) {
      currentAgent = { name: agentSection[1], indent };
      continue;
    }

    const provider = trimmed.match(/^provider\s*:\s*(.+)$/);
    if (currentAgent && indent > currentAgent.indent && provider?.[1]) {
      if (parseQuotedValue(provider[1]).toLowerCase() === "claude") {
        return currentAgent.name;
      }
    }
  }

  return null;
}

function parseClaudeAgentName(configText: string): string | null {
  const tomlAgents: Array<{ name: string; provider: string | null }> = [];
  let currentTomlAgent: { name: string; provider: string | null } | null = null;

  for (const rawLine of configText.split(/\r?\n/)) {
    const line = stripInlineComment(rawLine).trim();
    if (!line) {
      continue;
    }

    const tomlSection = line.match(/^\[agents\.([A-Za-z0-9_-]+)]$/);
    if (tomlSection?.[1]) {
      currentTomlAgent = { name: tomlSection[1], provider: null };
      tomlAgents.push(currentTomlAgent);
      continue;
    }

    if (currentTomlAgent) {
      const provider = line.match(/^provider\s*=\s*(.+)$/);
      if (provider?.[1]) {
        currentTomlAgent.provider = parseQuotedValue(provider[1]).toLowerCase();
      }
    }
  }

  const tomlClaudeAgent = tomlAgents.find((agent) => agent.provider === "claude");
  if (tomlClaudeAgent) {
    return tomlClaudeAgent.name;
  }

  const yamlClaudeAgent = parseYamlClaudeAgentName(configText);
  if (yamlClaudeAgent) {
    return yamlClaudeAgent;
  }

  try {
    const parsed = JSON.parse(configText) as Record<string, unknown>;
    const agents = parsed.agents && typeof parsed.agents === "object" ? parsed.agents as Record<string, unknown> : {};
    for (const [name, value] of Object.entries(agents)) {
      const provider = value && typeof value === "object" ? (value as Record<string, unknown>).provider : null;
      if (typeof provider === "string" && provider.toLowerCase() === "claude") {
        return name;
      }
    }
  } catch {
    // Non-JSON configs are expected; TOML-ish parsing above handles the common runtime file.
  }

  const yamlAgentBlocks = [...configText.matchAll(/^\s*([A-Za-z0-9_-]+)\s*:\s*\n(?:^[ \t]+.+\n?)*/gm)];
  for (const block of yamlAgentBlocks) {
    const name = block[1];
    if (name === "agents") {
      continue;
    }
    const body = block[0];
    const provider = body.match(/^\s+provider\s*:\s*["']?([A-Za-z0-9_-]+)["']?\s*$/m);
    if (name && provider?.[1]?.toLowerCase() === "claude") {
      return name;
    }
  }

  return null;
}

function normalizeInitJobStatus(raw: Record<string, unknown>): { status: InitJobStatus; reason?: string } {
  const rawStatus = String(raw.status ?? raw.state ?? "").trim().toLowerCase();
  const status: InitJobStatus =
    ["queued", "pending", "submitted", "created"].includes(rawStatus) ? "queued" :
    ["running", "started", "in_progress", "processing", "active"].includes(rawStatus) ? "running" :
    ["completed", "complete", "succeeded", "success", "done"].includes(rawStatus) ? "completed" :
    ["failed", "error", "cancelled", "canceled", "timeout", "timed_out"].includes(rawStatus) ? "failed" :
    "running";
  const reason = [raw.reason, raw.message, raw.error]
    .find((value): value is string => typeof value === "string" && value.trim().length > 0)
    ?.trim();
  return reason ? { status, reason } : { status };
}

export async function registerProjectOnboardingRoutes(
  app: FastifyInstance,
  dependencies: ProjectOnboardingRouteDependencies = {}
): Promise<void> {
  const nativeTerminal = dependencies.nativeTerminal ?? createMainProjectTerminal();
  const projectCcbdManager = dependencies.projectCcbdManager ?? new ProjectCcbdManager(prisma);

  app.addHook("onClose", async () => {
    projectCcbdManager.dispose?.();
  });

  app.get("/api/projects/:projectId/onboarding-status", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const project = await findProject(projectId);
    if (!project) {
      reply.status(404);
      return { message: "项目不存在" };
    }

    const paths = buildOnboardingPaths(project.localPath);
    const [ccbRuntimeReady, knowledgeBaseReady] = await Promise.all([
      fileExists(paths.ccbConfigPath),
      isKnowledgeBaseReady(paths)
    ]);

    return {
      projectId: project.id,
      localPath: project.localPath,
      ccbRuntimeReady,
      knowledgeBaseReady,
      ccbConfigPath: paths.ccbConfigPath,
      knowledgeBaseRootPath: paths.knowledgeBaseRootPath,
      manualCommand: buildManualSetupCommand(project),
      checkedAt: new Date().toISOString()
    };
  });

  app.get("/api/projects/:projectId/project-ccbd/status", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const project = await findProject(projectId);
    if (!project) {
      reply.status(404);
      return { message: "项目不存在" };
    }

    return await projectCcbdManager.getStatus(project.id);
  });

  app.post("/api/projects/:projectId/project-ccbd/confirm-restore", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const project = await findProject(projectId);
    if (!project) {
      reply.status(404);
      return { message: "项目不存在" };
    }

    return await projectCcbdManager.confirmRestore(project.id);
  });

  app.post("/api/projects/:projectId/main-terminal/spawn", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    try {
      assertLocalRequest(request);
    } catch (error) {
      reply.status((error as { statusCode?: number }).statusCode ?? 403);
      return { message: "仅本机可用" };
    }

    const project = await findProject(projectId);
    if (!project) {
      reply.status(404);
      return { message: "项目不存在" };
    }

    const paths = buildOnboardingPaths(project.localPath);
    if (!(await fileExists(paths.tmuxSocketPath))) {
      reply.status(409);
      return {
        code: "ccb_runtime_missing",
        message: "项目 ccb runtime 未运行，请先在项目根目录执行 ccb"
      };
    }

    return await nativeTerminal.spawn({ anchorPath: project.localPath });
  });

  app.post("/api/projects/:projectId/init-knowledge-base", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const project = await findProject(projectId);
    if (!project) {
      reply.status(404);
      return { message: "项目不存在" };
    }

    const paths = buildOnboardingPaths(project.localPath);
    if (!(await fileExists(paths.ccbdSocketPath))) {
      reply.status(409);
      return {
        code: "ccb_runtime_missing",
        message: "项目 ccb runtime 未运行，请先在项目根目录执行 ccb"
      };
    }

    let configText = "";
    try {
      configText = await readFile(paths.ccbConfigPath, "utf8");
    } catch {
      reply.status(409);
      return {
        code: "claude_agent_missing",
        message: "项目未配置 claude provider agent"
      };
    }

    const claudeAgentName = parseClaudeAgentName(configText);
    if (!claudeAgentName) {
      reply.status(409);
      return {
        code: "claude_agent_missing",
        message: "项目未配置 claude provider agent"
      };
    }

    const client = new CcbdClientService({
      projectRoot: project.localPath,
      socketPath: paths.ccbdSocketPath
    });
    try {
      const result = await client.submit({
        toAgent: claudeAgentName,
        taskId: project.id,
        body: "/ccb:su-init",
        fromActor: "system",
        messageType: "ask"
      });
      reply.status(202);
      return {
        jobId: result.jobId,
        claudeAgentName,
        submittedAt: new Date().toISOString()
      };
    } catch (error) {
      reply.status(503);
      return {
        code: "ccbd_submit_failed",
        message: error instanceof Error ? error.message : "ccbd submit failed"
      };
    }
  });

  app.get("/api/projects/:projectId/init-job-status", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const { jobId } = request.query as { jobId?: string };
    if (!jobId?.trim()) {
      reply.status(400);
      return { message: "jobId 不能为空" };
    }

    const project = await findProject(projectId);
    if (!project) {
      reply.status(404);
      return { message: "项目不存在" };
    }

    const paths = buildOnboardingPaths(project.localPath);
    if (!(await fileExists(paths.ccbdSocketPath))) {
      reply.status(409);
      return {
        code: "ccb_runtime_missing",
        message: "项目 ccb runtime 未运行，请先在项目根目录执行 ccb"
      };
    }

    const client = new CcbdClientService({
      projectRoot: project.localPath,
      socketPath: paths.ccbdSocketPath
    });
    try {
      const raw = await client.get(jobId.trim());
      const normalized = normalizeInitJobStatus(raw);
      return {
        jobId: jobId.trim(),
        ...normalized,
        updatedAt: new Date().toISOString()
      };
    } catch (error) {
      reply.status(503);
      return {
        code: "ccbd_get_failed",
        message: error instanceof Error ? error.message : "ccbd get failed"
      };
    }
  });
}

function createMainProjectTerminal(): MainProjectTerminal {
  const service = new NativeAnchorTerminalService();
  return {
    spawn: async ({ anchorPath }) =>
      await service.spawn({
        anchorId: "main-project",
        projectId: null,
        anchorPath,
        socketPath: null
      })
  };
}
