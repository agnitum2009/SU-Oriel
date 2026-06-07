import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type CcbReloadOperation = {
  raw: string;
  op: string | null;
  window?: string;
  agent?: string;
  agents?: string[];
  reason?: string;
  fields: Record<string, string>;
};

export type CcbReloadResult = {
  ok: boolean;
  status: string | null;
  dryRun: boolean | null;
  mutationEnabled: boolean | null;
  planClass: string | null;
  safeToApply: boolean | null;
  futureSafeToApply: boolean | null;
  operations: CcbReloadOperation[];
  blocked: string[];
  reasons: string[];
  diagnostics: string[];
  rawStdout: string;
  rawStderr: string;
  exitCode: number | null;
  errorMessage: string | null;
};

export type RunCcbReloadOptions = {
  projectRoot: string;
  dryRun?: boolean;
  timeoutMs?: number;
  ccbBinary?: string;
};

export async function runCcbReload(options: RunCcbReloadOptions): Promise<CcbReloadResult> {
  const args = ["reload", ...(options.dryRun ? ["--dry-run"] : [])];
  try {
    const result = await execFileAsync(options.ccbBinary ?? "ccb", args, {
      cwd: options.projectRoot,
      timeout: options.timeoutMs ?? 30_000,
      maxBuffer: 1024 * 1024
    });
    return parseCcbReloadOutput({
      stdout: String(result.stdout),
      stderr: String(result.stderr),
      exitCode: 0
    });
  } catch (error) {
    const output = error as {
      stdout?: string | Buffer;
      stderr?: string | Buffer;
      code?: number;
      signal?: string;
      killed?: boolean;
      message?: string;
    };
    const parsed = parseCcbReloadOutput({
      stdout: output.stdout ? String(output.stdout) : "",
      stderr: output.stderr ? String(output.stderr) : "",
      exitCode: typeof output.code === "number" ? output.code : null
    });
    return {
      ...parsed,
      ok: false,
      errorMessage: output.killed
        ? `ccb reload timed out${output.signal ? ` (${output.signal})` : ""}`
        : parsed.errorMessage ?? output.message ?? "ccb reload failed"
    };
  }
}

export function parseCcbReloadOutput(input: {
  stdout: string;
  stderr?: string;
  exitCode?: number | null;
}): CcbReloadResult {
  const operations: CcbReloadOperation[] = [];
  const blocked: string[] = [];
  const reasons: string[] = [];
  const diagnostics: string[] = [];
  let status: string | null = null;
  let dryRun: boolean | null = null;
  let mutationEnabled: boolean | null = null;
  let planClass: string | null = null;
  let safeToApply: boolean | null = null;
  let futureSafeToApply: boolean | null = null;
  let sawKnownLine = false;

  for (const rawLine of input.stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith("reload_status:")) {
      sawKnownLine = true;
      status = valueAfterColon(line);
      continue;
    }
    if (line.startsWith("dry_run:")) {
      sawKnownLine = true;
      dryRun = parseBoolean(valueAfterColon(line));
      continue;
    }
    if (line.startsWith("mutation_enabled:")) {
      sawKnownLine = true;
      mutationEnabled = parseBoolean(valueAfterColon(line));
      continue;
    }
    if (line.startsWith("plan_class:")) {
      sawKnownLine = true;
      planClass = valueAfterColon(line);
      continue;
    }
    if (line.startsWith("safe_to_apply:")) {
      sawKnownLine = true;
      safeToApply = parseBoolean(valueAfterColon(line));
      continue;
    }
    if (line.startsWith("future_safe_to_apply:")) {
      sawKnownLine = true;
      futureSafeToApply = parseBoolean(valueAfterColon(line));
      continue;
    }
    if (line.startsWith("reload_operation:")) {
      sawKnownLine = true;
      operations.push(parseReloadOperation(valueAfterColon(line)));
      continue;
    }
    if (line.startsWith("blocked:") || line.startsWith("reload_blocked:")) {
      sawKnownLine = true;
      blocked.push(valueAfterColon(line));
      continue;
    }
    if (line.startsWith("reload_reason:")) {
      sawKnownLine = true;
      reasons.push(valueAfterColon(line));
      continue;
    }
    if (line.startsWith("reload_diagnostic:")) {
      sawKnownLine = true;
      diagnostics.push(valueAfterColon(line));
    }
  }

  if (!sawKnownLine || !status) {
    return {
      ok: false,
      status,
      dryRun,
      mutationEnabled,
      planClass,
      safeToApply,
      futureSafeToApply,
      operations,
      blocked,
      reasons,
      diagnostics,
      rawStdout: input.stdout,
      rawStderr: input.stderr ?? "",
      exitCode: input.exitCode ?? null,
      errorMessage: "unable to parse ccb reload output"
    };
  }

  const exitCode = input.exitCode ?? 0;
  const ok = exitCode === 0 && blocked.length === 0 && (status === "ok" || status === "published");
  return {
    ok,
    status,
    dryRun,
    mutationEnabled,
    planClass,
    safeToApply,
    futureSafeToApply,
    operations,
    blocked,
    reasons,
    diagnostics,
    rawStdout: input.stdout,
    rawStderr: input.stderr ?? "",
    exitCode,
    errorMessage: ok ? null : `ccb reload status=${status} exitCode=${exitCode}`
  };
}

function valueAfterColon(line: string): string {
  return line.slice(line.indexOf(":") + 1).trim();
}

function parseBoolean(value: string): boolean | null {
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

function parseReloadOperation(raw: string): CcbReloadOperation {
  const fields = parseKeyValueFields(raw);
  return {
    raw,
    op: fields.op ?? null,
    window: fields.window,
    agent: fields.agent,
    agents: fields.agents ? fields.agents.split(",").filter(Boolean) : undefined,
    reason: fields.reason,
    fields
  };
}

function parseKeyValueFields(raw: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const reasonIndex = raw.indexOf(" reason=");
  const head = reasonIndex >= 0 ? raw.slice(0, reasonIndex) : raw;
  if (reasonIndex >= 0) {
    fields.reason = raw.slice(reasonIndex + " reason=".length);
  }
  for (const token of head.split(/\s+/)) {
    if (!token) continue;
    const separator = token.indexOf("=");
    if (separator <= 0) continue;
    fields[token.slice(0, separator)] = token.slice(separator + 1);
  }
  return fields;
}
