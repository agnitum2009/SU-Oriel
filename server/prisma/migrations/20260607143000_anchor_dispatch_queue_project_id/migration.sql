-- Add an explicit project scope to AnchorDispatchQueue. The column stays
-- nullable so older binaries can roll back without rolling the schema back;
-- runtime code enforces non-null projectId for all new queue rows.
ALTER TABLE "AnchorDispatchQueue" ADD COLUMN "projectId" TEXT;

-- Best-effort backfill from the canonical subject owner.
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
  );

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
  );

-- Terminal dirty rows are projection leftovers and may be rebuilt from the
-- canonical docs/DB source. Active dirty rows are retained but marked so the
-- runtime can skip them through projectId-scoped queries while operators see
-- the unresolved scope in errorMessage.
DELETE FROM "AnchorDispatchQueue"
WHERE
  "projectId" IS NULL
  AND "status" NOT IN ('pending', 'submitted');

UPDATE "AnchorDispatchQueue"
SET "errorMessage" = CASE
  WHEN "errorMessage" IS NULL OR "errorMessage" = ''
    THEN 'project scope unresolved after projectId migration'
  WHEN instr("errorMessage", 'project scope unresolved after projectId migration') = 0
    THEN "errorMessage" || '; project scope unresolved after projectId migration'
  ELSE "errorMessage"
END
WHERE
  "projectId" IS NULL
  AND "status" IN ('pending', 'submitted');

CREATE INDEX "AnchorDispatchQueue_projectId_status_anchorId_queuedAt_idx"
ON "AnchorDispatchQueue"("projectId", "status", "anchorId", "queuedAt");
