import type { Prisma, PrismaClient } from "@prisma/client";

const ACTIVE_QUEUE_STATUSES = ["pending", "submitted"] as const;
const UNRESOLVED_SCOPE_MESSAGE = "project scope unresolved after projectId migration";

type ScopeRepairClient = PrismaClient | Prisma.TransactionClient;

export type AnchorDispatchQueueProjectScopeReport = {
  backfilledRequirementRows: number;
  backfilledSubtaskRows: number;
  deletedTerminalDirtyRows: number;
  markedActiveDirtyRows: number;
  remainingActiveDirtyRows: number;
};

export async function repairAnchorDispatchQueueProjectScope(
  client: ScopeRepairClient
): Promise<AnchorDispatchQueueProjectScopeReport> {
  const backfilledRequirementRows = await client.$executeRaw`
    UPDATE "AnchorDispatchQueue"
    SET "projectId" = (
      SELECT "Requirement"."projectId"
      FROM "Requirement"
      WHERE "Requirement"."id" = "AnchorDispatchQueue"."subjectId"
    )
    WHERE
      "projectId" IS NULL
      AND "subjectType" = 'requirement'
      AND EXISTS (
        SELECT 1
        FROM "Requirement"
        WHERE "Requirement"."id" = "AnchorDispatchQueue"."subjectId"
      )
  `;
  const backfilledSubtaskRows = await client.$executeRaw`
    UPDATE "AnchorDispatchQueue"
    SET "projectId" = (
      SELECT "Task"."projectId"
      FROM "Task"
      WHERE "Task"."id" = "AnchorDispatchQueue"."subjectId"
    )
    WHERE
      "projectId" IS NULL
      AND "subjectType" = 'subtask'
      AND EXISTS (
        SELECT 1
        FROM "Task"
        WHERE "Task"."id" = "AnchorDispatchQueue"."subjectId"
      )
  `;
  const deletedTerminal = await client.anchorDispatchQueue.deleteMany({
    where: {
      projectId: null,
      status: {
        notIn: [...ACTIVE_QUEUE_STATUSES]
      }
    }
  });
  const markedActive = await client.anchorDispatchQueue.updateMany({
    where: {
      projectId: null,
      status: {
        in: [...ACTIVE_QUEUE_STATUSES]
      },
      OR: [
        { errorMessage: null },
        { errorMessage: "" },
        {
          NOT: {
            errorMessage: {
              contains: UNRESOLVED_SCOPE_MESSAGE
            }
          }
        }
      ]
    },
    data: {
      errorMessage: UNRESOLVED_SCOPE_MESSAGE
    }
  });
  const remainingActiveDirtyRows = await client.anchorDispatchQueue.count({
    where: {
      projectId: null,
      status: {
        in: [...ACTIVE_QUEUE_STATUSES]
      }
    }
  });
  return {
    backfilledRequirementRows,
    backfilledSubtaskRows,
    deletedTerminalDirtyRows: deletedTerminal.count,
    markedActiveDirtyRows: markedActive.count,
    remainingActiveDirtyRows
  };
}
