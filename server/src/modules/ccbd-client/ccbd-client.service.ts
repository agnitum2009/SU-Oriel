import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import net from "node:net";
import { basename, dirname, join, resolve } from "node:path";
import posix from "node:path/posix";

import {
  AgentNotFoundError,
  AnchorSocketNotReadyError,
  CcbdUnavailableError,
  ProtocolError,
  QueueRejectedError
} from "./ccbd-client.errors.js";
import type {
  CcbdAnchorRequestOptions,
  CcbdAnchorSocketResolver,
  CcbdClientServiceLike,
  CcbdProjectView,
  CcbdStartOptions,
  CcbdStartResponse,
  CcbdSubmitInput,
  CcbdSubmitResponse
} from "./ccbd-client.types.js";

const API_VERSION = 2;
const AGENT_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]{0,31}$/;
const RESERVED_AGENT_NAMES = new Set([
  "cmd",
  "ask",
  "cancel",
  "pend",
  "ping",
  "watch",
  "kill",
  "ps",
  "logs",
  "doctor",
  "config",
  "version",
  "update",
  "help"
]);

type CcbdClientScopeOptions =
  | { projectRoot: string; socketPath?: string; anchorSocketResolver?: CcbdAnchorSocketResolver }
  | { socketPath: string; projectRoot?: string; anchorSocketResolver?: CcbdAnchorSocketResolver }
  | { anchorSocketResolver: CcbdAnchorSocketResolver; projectRoot?: string; socketPath?: string };

export type CcbdClientServiceOptions = CcbdClientScopeOptions & {
  timeoutMs?: number;
};

function normalizeAgentName(agentName: string): string {
  const normalized = agentName.trim().toLowerCase();
  if (!AGENT_NAME_PATTERN.test(normalized) || RESERVED_AGENT_NAMES.has(normalized)) {
    throw new AgentNotFoundError(agentName);
  }
  return normalized;
}

function readSocketPathFromJson(filePath: string): string | null {
  if (!existsSync(filePath)) {
    return null;
  }
  try {
    const payload = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
    const direct = typeof payload.socket_path === "string" ? payload.socket_path.trim() : "";
    if (direct) {
      return direct;
    }
    const inspection = payload.inspection && typeof payload.inspection === "object" ? payload.inspection as Record<string, unknown> : null;
    const lease = inspection?.lease && typeof inspection.lease === "object" ? inspection.lease as Record<string, unknown> : null;
    const leaseSocket = typeof lease?.socket_path === "string" ? lease.socket_path.trim() : "";
    if (leaseSocket) {
      return leaseSocket;
    }
    const placement = payload.socket_placement && typeof payload.socket_placement === "object" ? payload.socket_placement as Record<string, unknown> : null;
    const effective = typeof placement?.effective_socket_path === "string" ? placement.effective_socket_path.trim() : "";
    return effective || null;
  } catch {
    return null;
  }
}

import { resolveCcbProjectRoot } from "../../lib/project-root.js";
export { resolveCcbProjectRoot };

export function resolveCcbdSocketPath(projectRoot: string): string {
  const explicit = process.env.CCB_CCBD_SOCKET_PATH?.trim();
  if (explicit) {
    return explicit;
  }

  const ccbdDir = join(projectRoot, ".ccb", "ccbd");
  for (const filename of ["lifecycle.json", "lease.json", "startup-report.json", "keeper.json"]) {
    const socketPath = readSocketPathFromJson(join(ccbdDir, filename));
    if (socketPath) {
      return socketPath;
    }
  }

  return join(ccbdDir, "ccbd.sock");
}

export function computeCcbProjectId(projectRoot: string): string {
  let normalized = projectRoot;
  try {
    normalized = realpathSync(projectRoot);
  } catch {
    normalized = resolve(projectRoot);
  }
  normalized = posix.normalize(normalized.replace(/\\/g, "/"));
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

function inferProjectRootFromExplicitSocket(socketPath: string): string {
  const socketDir = dirname(resolve(socketPath));
  if (basename(socketDir) === "ccbd" && basename(dirname(socketDir)) === ".ccb") {
    return dirname(dirname(socketDir));
  }
  return socketDir;
}

export class CcbdClientService implements CcbdClientServiceLike {
  readonly projectRoot: string | null;
  readonly projectId: string | null;
  private readonly socketPath: string | null;
  private readonly timeoutMs: number;
  private readonly anchorSocketResolver?: CcbdAnchorSocketResolver;

  constructor(options: CcbdClientServiceOptions) {
    this.projectRoot = options.projectRoot ? resolve(options.projectRoot) : null;
    this.projectId = this.projectRoot
      ? computeCcbProjectId(this.projectRoot)
      : options.socketPath
        ? computeCcbProjectId(inferProjectRootFromExplicitSocket(options.socketPath))
        : null;
    this.socketPath = options.socketPath ?? (this.projectRoot ? resolveCcbdSocketPath(this.projectRoot) : null);
    this.timeoutMs = options.timeoutMs ?? 3000;
    this.anchorSocketResolver = options.anchorSocketResolver;
  }

  async start(agentNames: string[], opts: CcbdStartOptions = {}): Promise<CcbdStartResponse> {
    const terminalSize = opts.terminalSize;
    const payload: Record<string, unknown> = {
      agent_names: agentNames.map((agentName) => normalizeAgentName(agentName)),
      restore: Boolean(opts.restore),
      auto_permission: Boolean(opts.autoPermission)
    };
    if (terminalSize) {
      payload.terminal_width = terminalSize.width;
      payload.terminal_height = terminalSize.height;
    }
    const route = this.resolveDefaultRoute();
    const response = await this.request("start", payload, route.socketPath);
    return {
      started: Array.isArray(response.started) ? response.started.map(String) : undefined,
      socketPath: typeof response.socket_path === "string" ? response.socket_path : undefined,
      raw: response
    };
  }

  async submit(input: CcbdSubmitInput): Promise<CcbdSubmitResponse> {
    const route = await this.resolveRequestRoute(input.anchorId);
    const response = await this.request("submit", {
      project_id: route.projectId,
      to_agent: normalizeAgentName(input.toAgent),
      from_actor: input.fromActor ?? "user",
      body: input.body,
      task_id: input.taskId,
      reply_to: null,
      message_type: input.messageType ?? "ask",
      delivery_scope: "single",
      silence_on_success: false
    }, route.socketPath);
    const jobId = typeof response.job_id === "string" ? response.job_id : "";
    if (!jobId) {
      throw new ProtocolError("ccbd submit response missing job_id");
    }
    return {
      jobId,
      submissionId: typeof response.submission_id === "string" ? response.submission_id : null,
      traceRef: typeof response.trace_ref === "string" ? response.trace_ref : typeof response.traceRef === "string" ? response.traceRef : null,
      raw: response
    };
  }

  async cancel(jobId: string, opts: CcbdAnchorRequestOptions = {}): Promise<Record<string, unknown>> {
    const route = await this.resolveRequestRoute(opts.anchorId);
    return await this.request("cancel", { job_id: jobId }, route.socketPath);
  }

  async get(jobId: string, opts: CcbdAnchorRequestOptions = {}): Promise<Record<string, unknown>> {
    const route = await this.resolveRequestRoute(opts.anchorId);
    return await this.request("get", { job_id: jobId }, route.socketPath);
  }

  async queue(target = "all", opts: CcbdAnchorRequestOptions = {}): Promise<Record<string, unknown>> {
    const route = await this.resolveRequestRoute(opts.anchorId);
    return await this.request("queue", { target }, route.socketPath);
  }

  async trace(target: string, opts: CcbdAnchorRequestOptions = {}): Promise<Record<string, unknown>> {
    const route = await this.resolveRequestRoute(opts.anchorId);
    return await this.request("trace", { target }, route.socketPath);
  }

  async ping(target = "ccbd"): Promise<Record<string, unknown>> {
    const route = this.resolveDefaultRoute();
    return await this.request("ping", { target }, route.socketPath);
  }

  async projectView(): Promise<CcbdProjectView> {
    const route = this.resolveDefaultRoute();
    const response = await this.request("project_view", { schema_version: 1 }, route.socketPath);
    const view = response.view;
    if (!view || typeof view !== "object" || Array.isArray(view)) {
      throw new ProtocolError("ccbd project_view response missing view");
    }
    return view as CcbdProjectView;
  }

  private resolveDefaultRoute(): { socketPath: string; projectId: string } {
    if (!this.socketPath) {
      throw new CcbdUnavailableError("ccbd default socket unavailable; construct with projectRoot or socketPath");
    }
    if (!this.projectId) {
      throw new ProtocolError("ccbd project_id unavailable; construct with projectRoot or use anchorSocketResolver with anchor project metadata");
    }
    return {
      socketPath: this.socketPath,
      projectId: this.projectId
    };
  }

  private async resolveRequestRoute(anchorId?: string): Promise<{ socketPath: string; projectId: string }> {
    if (!anchorId) {
      return this.resolveDefaultRoute();
    }

    const anchor = await this.anchorSocketResolver?.(anchorId);
    const socketPath = anchor?.socketPath?.trim();
    if (!socketPath) {
      throw new AnchorSocketNotReadyError(anchorId);
    }
    const projectId = anchor?.anchorPath
      ? computeCcbProjectId(anchor.anchorPath)
      : anchor?.projectId ?? this.projectId;
    if (!projectId) {
      throw new ProtocolError("ccbd anchor route missing project_id");
    }
    return {
      socketPath,
      projectId
    };
  }

  private async request(op: string, payload: Record<string, unknown>, socketPath: string): Promise<Record<string, unknown>> {
    const request = JSON.stringify({
      api_version: API_VERSION,
      op,
      request: payload
    }) + "\n";

    return await new Promise<Record<string, unknown>>((resolvePromise, rejectPromise) => {
      let settled = false;
      let buffer = "";
      const settle = (error: Error | null, value?: Record<string, unknown>) => {
        if (settled) {
          return;
        }
        settled = true;
        socket.destroy();
        if (error) {
          rejectPromise(error);
        } else {
          resolvePromise(value ?? {});
        }
      };

      const socket = net.createConnection({ path: socketPath }, () => {
        socket.write(request);
      });
      socket.setTimeout(this.timeoutMs);
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        if (!buffer.includes("\n")) {
          return;
        }
        const line = buffer.split("\n", 1)[0];
        try {
          const decoded = JSON.parse(line) as Record<string, unknown>;
          if (decoded.api_version !== API_VERSION) {
            settle(new ProtocolError(`unsupported ccbd api_version: ${String(decoded.api_version)}`));
            return;
          }
          if (!decoded.ok) {
            settle(mapCcbdError(String(decoded.error || "ccbd request failed"), payload));
            return;
          }
          const response = { ...decoded };
          delete response.api_version;
          delete response.ok;
          settle(null, response);
        } catch (error) {
          settle(new ProtocolError(error instanceof Error ? error.message : "invalid ccbd response"));
        }
      });
      socket.on("timeout", () => {
        settle(new CcbdUnavailableError("ccbd request timed out"));
      });
      socket.on("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT" || error.code === "ECONNREFUSED" || error.code === "EAGAIN") {
          settle(new CcbdUnavailableError(error.message));
          return;
        }
        settle(new ProtocolError(error.message));
      });
      socket.on("end", () => {
        if (!settled && !buffer.trim()) {
          settle(new CcbdUnavailableError("empty response from ccbd"));
        }
      });
    });
  }
}

function mapCcbdError(message: string, requestPayload: Record<string, unknown>): Error {
  const lower = message.toLowerCase();
  if (lower.includes("unknown agent") || lower.includes("agent not found")) {
    const agent = typeof requestPayload.to_agent === "string" ? requestPayload.to_agent : "unknown";
    return new AgentNotFoundError(agent);
  }
  if (lower.includes("reject") || lower.includes("queue") || lower.includes("busy")) {
    return new QueueRejectedError(message);
  }
  return new ProtocolError(message);
}
