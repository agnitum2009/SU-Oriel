import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const DEFAULT_AUDIT_DIR = resolve(SERVER_ROOT, "data", "slot-terminal", "input-audit");

export type SlotTerminalInputExecFileProcess = (
  command: string,
  args: string[]
) => Promise<{ stdout: string | Buffer; stderr: string | Buffer }>;

export type SlotTerminalInputWrite = {
  target: string;
  socketPath?: string;
  data: string;
};

export type SlotTerminalInputWriteResult = {
  commandCount: number;
  bytes: number;
};

type SlotTerminalInputAuditContext =
  | {
      contextKind: "requirement";
      contextId: string;
      requirementId: string;
    }
  | {
      contextKind: "agent-group";
      contextId: string;
      requirementId?: never;
    };

export type SlotTerminalInputAuditEvent = SlotTerminalInputAuditContext & {
  projectId: string;
  slotId: string;
  pane: string;
  target: string;
  remoteAddr: string;
  data: string;
  commandCount: number;
  outcome: "accepted" | "forbidden" | "rejected";
  rejectionCode?: string;
  rejectionReason?: string;
};

export interface SlotTerminalInputWriterBackend {
  sendInput(input: SlotTerminalInputWrite): Promise<SlotTerminalInputWriteResult>;
  sendPaste(input: SlotTerminalInputWrite): Promise<SlotTerminalInputWriteResult>;
}

export interface SlotTerminalInputAuditSink {
  recordInput(input: SlotTerminalInputAuditEvent): Promise<void> | void;
}

export class TmuxSlotTerminalInputWriter implements SlotTerminalInputWriterBackend {
  private readonly tmuxCommand: string;
  private readonly execFileProcess: SlotTerminalInputExecFileProcess;

  constructor(options: { tmuxCommand?: string; execFileProcess?: SlotTerminalInputExecFileProcess } = {}) {
    this.tmuxCommand = options.tmuxCommand ?? "tmux";
    this.execFileProcess =
      options.execFileProcess ??
      (async (command, args) => {
        const result = await execFileAsync(command, args);
        return {
          stdout: result.stdout,
          stderr: result.stderr
        };
      });
  }

  async sendInput(input: SlotTerminalInputWrite): Promise<SlotTerminalInputWriteResult> {
    if (!input.data) {
      return { commandCount: 0, bytes: 0 };
    }
    const commands = inputToTmuxSendArgsList(input.data);
    for (const command of commands) {
      await this.execFileProcess(this.tmuxCommand, [
        ...(input.socketPath ? ["-S", input.socketPath] : []),
        ...tmuxSendKeysArgsForTarget(input.target, command)
      ]);
    }
    return {
      commandCount: commands.length,
      bytes: Buffer.byteLength(input.data, "utf8")
    };
  }

  // 粘贴走 tmux buffer：set-buffer 装载原始文本（含换行），paste-buffer -p 以括号粘贴原子投递到 pane。
  // -p：程序若开启 bracketed paste（claude/codex CLI 会），多行作为单次粘贴内容、不逐行执行；-d：用后即删，不污染 tmux buffer 栈。
  async sendPaste(input: SlotTerminalInputWrite): Promise<SlotTerminalInputWriteResult> {
    if (!input.data) {
      return { commandCount: 0, bytes: 0 };
    }
    const socketArgs = input.socketPath ? ["-S", input.socketPath] : [];
    const bufferName = `slotterm-paste-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    await this.execFileProcess(this.tmuxCommand, [...socketArgs, "set-buffer", "-b", bufferName, "--", input.data]);
    await this.execFileProcess(this.tmuxCommand, [
      ...socketArgs,
      "paste-buffer",
      "-p",
      "-d",
      "-b",
      bufferName,
      "-t",
      input.target
    ]);
    return {
      commandCount: 1,
      bytes: Buffer.byteLength(input.data, "utf8")
    };
  }
}

export class SlotTerminalInputAuditWriter implements SlotTerminalInputAuditSink {
  private readonly auditDir: string;

  constructor(options: { auditDir?: string } = {}) {
    this.auditDir = options.auditDir ?? DEFAULT_AUDIT_DIR;
  }

  async recordInput(input: SlotTerminalInputAuditEvent): Promise<void> {
    if (!input.data) {
      return;
    }
    const row = {
      projectId: input.projectId,
      contextKind: input.contextKind,
      contextId: input.contextId,
      requirementId: input.requirementId,
      slotId: input.slotId,
      pane: input.pane,
      target: input.target,
      remoteAddr: input.remoteAddr,
      outcome: input.outcome,
      rejection_code: input.rejectionCode,
      rejection_reason: input.rejectionReason,
      command_count: input.commandCount,
      bytes: Buffer.byteLength(input.data, "utf8"),
      sha256: createHash("sha256").update(input.data).digest("hex"),
      created_at: new Date().toISOString()
    };
    const path = resolve(this.auditDir, auditFileName(input));
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(row)}\n`, "utf8");
  }
}

function auditFileName(input: SlotTerminalInputAuditEvent): string {
  if (input.contextKind === "requirement") {
    return `${safeSegment(input.requirementId)}.jsonl`;
  }
  return `agent-group-${safeSegment(input.contextId)}.jsonl`;
}

export type SlotTerminalSendKeysCommand = ["send-keys", ...string[]];

export function keyToTmuxSendArgs(data: string): SlotTerminalSendKeysCommand {
  switch (data) {
    case "\r":
    case "\n":
      return ["send-keys", "Enter"];
    case "\t":
      return ["send-keys", "Tab"];
    case "\u007f":
    case "\b":
      return ["send-keys", "BSpace"];
    case "\u001b[A":
      return ["send-keys", "Up"];
    case "\u001b[B":
      return ["send-keys", "Down"];
    case "\u001b[C":
      return ["send-keys", "Right"];
    case "\u001b[D":
      return ["send-keys", "Left"];
    case "\u001b[H":
    case "\u001bOH":
      return ["send-keys", "Home"];
    case "\u001b[F":
    case "\u001bOF":
      return ["send-keys", "End"];
    case "\u001b[3~":
      return ["send-keys", "Delete"];
    case "\u0001":
      return ["send-keys", "C-a"];
    case "\u0003":
      return ["send-keys", "C-c"];
    case "\u0004":
      return ["send-keys", "C-d"];
    case "\u0005":
      return ["send-keys", "C-e"];
    case "\u000b":
      return ["send-keys", "C-k"];
    case "\u000c":
      return ["send-keys", "C-l"];
    case "\u0015":
      return ["send-keys", "C-u"];
    case "\u001a":
      return ["send-keys", "C-z"];
    default:
      return ["send-keys", "-l", "--", data];
  }
}

export function inputToTmuxSendArgsList(data: string): SlotTerminalSendKeysCommand[] {
  const commands: SlotTerminalSendKeysCommand[] = [];
  let literal = "";
  for (let index = 0; index < data.length; ) {
    const escape = readEscapeSequence(data, index);
    const char = escape ?? data[index];
    const charLength = escape ? escape.length : 1;
    const mapped = keyToTmuxSendArgs(char);
    const isLiteral = mapped[1] === "-l";
    if (isLiteral) {
      literal += mapped[3] ?? "";
    } else {
      if (literal) {
        commands.push(["send-keys", "-l", "--", literal]);
        literal = "";
      }
      commands.push(mapped);
    }
    index += charLength;
  }
  if (literal) {
    commands.push(["send-keys", "-l", "--", literal]);
  }
  return commands;
}

export function tmuxSendKeysArgsForTarget(
  target: string,
  sendKeysArgs: SlotTerminalSendKeysCommand
): SlotTerminalSendKeysCommand {
  if (sendKeysArgs[0] !== "send-keys") {
    throw new Error("expected send-keys command");
  }
  return ["send-keys", "-t", target, ...sendKeysArgs.slice(1)];
}

function readEscapeSequence(value: string, index: number): string | null {
  if (value[index] !== "\u001b") {
    return null;
  }
  const known = [
    "\u001b[A",
    "\u001b[B",
    "\u001b[C",
    "\u001b[D",
    "\u001b[H",
    "\u001b[F",
    "\u001bOH",
    "\u001bOF",
    "\u001b[3~"
  ];
  return known.find((sequence) => value.startsWith(sequence, index)) ?? "\u001b";
}

function safeSegment(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9_.-]+/g, "_") || "unknown";
}
