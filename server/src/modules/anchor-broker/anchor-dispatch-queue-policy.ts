import type { Prisma, PrismaClient } from "@prisma/client";

const ACTIVE_CANCEL_STATUSES = ["pending", "submitted"] as const;
const CANCEL_COMMAND = "su-cancel";
const CANCELLED_REQUIREMENT_ALLOWLIST = new Set([CANCEL_COMMAND, "su-reactivate"]);

type QueuePolicyClient = PrismaClient | Prisma.TransactionClient;

export class AnchorDispatchQueuePolicyError extends Error {
  readonly statusCode = 409;

  constructor(
    readonly code: "cancel_in_progress" | "requirement_cancelled",
    message: string
  ) {
    super(message);
    this.name = "AnchorDispatchQueuePolicyError";
  }
}

export function extractCcbCommandName(command: string): string | null {
  const trimmed = command.trim();
  const structured = trimmed.match(/^\/ccb:([a-z][a-z0-9-]*)\b/);
  if (structured) return structured[1];
  return /^[a-z][a-z0-9-]*$/.test(trimmed) ? trimmed : null;
}

export function isCancelDispatchCommand(command: string): boolean {
  return extractCcbCommandName(command) === CANCEL_COMMAND;
}

export async function enforceRequirementDispatchQueuePolicy(
  client: QueuePolicyClient,
  input: {
    projectId: string;
    requirementId: string;
    command: string;
    ignoreJobId?: string;
  }
): Promise<void> {
  const commandName = extractCcbCommandName(input.command);
  const [requirement, taskIds] = await Promise.all([
    client.requirement.findFirst({
      where: {
        id: input.requirementId,
        projectId: input.projectId
      },
      select: {
        status: true
      }
    }),
    listRequirementTaskIds(client, input.projectId, input.requirementId)
  ]);

  if (
    requirement?.status === "cancelled" &&
    (!commandName || !CANCELLED_REQUIREMENT_ALLOWLIST.has(commandName))
  ) {
    throw new AnchorDispatchQueuePolicyError(
      "requirement_cancelled",
      "需求已取消，仅允许重试取消清理或复活"
    );
  }
  if (requirement?.status === "cancelled" && commandName && CANCELLED_REQUIREMENT_ALLOWLIST.has(commandName)) {
    return;
  }

  const activeCancel = await client.anchorDispatchQueue.findFirst({
    where: {
      projectId: input.projectId,
      ...(input.ignoreJobId ? { jobId: { not: input.ignoreJobId } } : {}),
      status: {
        in: [...ACTIVE_CANCEL_STATUSES]
      },
      AND: [
        buildRequirementDispatchScopeWhere(input.requirementId, taskIds),
        { OR: buildCancelDispatchCommandWhere() }
      ]
    },
    select: {
      jobId: true
    }
  });

  if (activeCancel) {
    throw new AnchorDispatchQueuePolicyError(
      "cancel_in_progress",
      "需求取消已在排队或执行中，请等待当前取消完成"
    );
  }
}

export async function supersedePendingRequirementDispatches(
  client: QueuePolicyClient,
  input: {
    projectId: string;
    requirementId: string;
    ignoreJobId?: string;
  }
): Promise<number> {
  const taskIds = await listRequirementTaskIds(client, input.projectId, input.requirementId);
  const result = await client.anchorDispatchQueue.updateMany({
    where: {
      projectId: input.projectId,
      ...buildRequirementDispatchScopeWhere(input.requirementId, taskIds),
      ...(input.ignoreJobId ? { jobId: { not: input.ignoreJobId } } : {}),
      status: "pending",
      NOT: {
        OR: buildCancelDispatchCommandWhere()
      }
    },
    data: {
      status: "superseded",
      errorMessage: "superseded by su-cancel"
    }
  });
  return result.count;
}

async function listRequirementTaskIds(
  client: QueuePolicyClient,
  projectId: string,
  requirementId: string
): Promise<string[]> {
  const tasks = await client.task.findMany({
    where: {
      projectId,
      requirementId
    },
    select: {
      id: true
    }
  });
  return tasks.map((task) => task.id);
}

function buildRequirementDispatchScopeWhere(
  requirementId: string,
  taskIds: string[]
): Prisma.AnchorDispatchQueueWhereInput {
  const scope: Prisma.AnchorDispatchQueueWhereInput[] = [
    {
      subjectType: "requirement",
      subjectId: requirementId
    }
  ];
  if (taskIds.length > 0) {
    scope.push({
      subjectType: "subtask",
      subjectId: {
        in: taskIds
      }
    });
  }
  return {
    OR: scope
  };
}

function buildCancelDispatchCommandWhere(): Prisma.AnchorDispatchQueueWhereInput[] {
  return [
    { command: CANCEL_COMMAND },
    { command: { startsWith: `${CANCEL_COMMAND} ` } },
    { command: `/ccb:${CANCEL_COMMAND}` },
    { command: { startsWith: `/ccb:${CANCEL_COMMAND} ` } }
  ];
}
