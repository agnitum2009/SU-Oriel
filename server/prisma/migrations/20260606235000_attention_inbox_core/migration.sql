CREATE TABLE "AttentionAck" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "ackedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AttentionAck_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "ProjectAttentionSettings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "dndUntil" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ProjectAttentionSettings_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "AttentionAck_projectId_ref_key" ON "AttentionAck"("projectId", "ref");
CREATE INDEX "AttentionAck_projectId_ackedAt_idx" ON "AttentionAck"("projectId", "ackedAt");
CREATE UNIQUE INDEX "ProjectAttentionSettings_projectId_key" ON "ProjectAttentionSettings"("projectId");
