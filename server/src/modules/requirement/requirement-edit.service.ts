import { createHash } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

import type { PrismaClient, Requirement } from "@prisma/client";

import { parseDocument, parseRequirementSections } from "../../indexer/document-parser.js";
import { getDocsStructureResolverForProject } from "../../indexer/docs-structure-resolver.js";
import { syncRequirementsFromMarkdown } from "../../indexer/project-indexer.js";
import { extractMarkdownBody } from "../../lib/markdown.js";
import { primitiveExecutor } from "../primitive/primitive-wrapper.js";
import { hashRequirementAnalysisInput } from "./requirement-analysis-hash.js";

export { extractMarkdownBody } from "../../lib/markdown.js";

const EDITABLE_REQUIREMENT_STATUSES = new Set(["drafting", "planning", "delivering", "deferred"]);

export class RequirementEditNotFoundError extends Error {
  constructor(message = "需求不存在") {
    super(message);
  }
}

export class RequirementEditStatusConflictError extends Error {
  constructor(status: string) {
    super(`当前状态不允许编辑: ${status}`);
  }
}

export class RequirementEditHashConflictError extends Error {
  constructor(
    public readonly expectedMdHash: string,
    public readonly currentMdHash: string
  ) {
    super("mdHash 冲突，请刷新后重试");
  }
}

export interface EditRequirementInput {
  title?: string;
  description?: string;
  changeReason?: string;
  expectedMdHash: string;
  editor: string;
}

export interface RequirementMarkdownRecord {
  absolutePath: string;
  relativePath: string;
  content: string;
}

export interface RequirementMarkdownBody {
  path: string;
  content: string;
}

export function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

async function collectMarkdownFiles(rootPath: string): Promise<string[]> {
  const entries = await readdir(rootPath, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const entryPath = join(rootPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectMarkdownFiles(entryPath)));
      continue;
    }
    if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      files.push(entryPath);
    }
  }

  return files;
}

export async function findRequirementMarkdown(projectRoot: string, requirementId: string): Promise<RequirementMarkdownRecord> {
  const requirementDirectory = getDocsStructureResolverForProject(projectRoot).resolveDocType("requirement").directory;
  const root = join(projectRoot, requirementDirectory);
  let files: string[];
  try {
    files = await collectMarkdownFiles(root);
  } catch {
    files = [];
  }

  for (const absolutePath of files) {
    const content = await readFile(absolutePath, "utf8");
    const relativePath = relative(projectRoot, absolutePath).replace(/\\/g, "/");
    const parsed = parseDocument({
      relativePath,
      content,
      mtime: (await stat(absolutePath)).mtime
    });
    if (parsed.frontmatter.id === requirementId) {
      return { absolutePath, relativePath, content };
    }
  }

  throw new RequirementEditNotFoundError("需求 md 文件不存在");
}

function escapeYamlScalar(value: string): string {
  if (/[:#\-{}[\]&*!|>'"%@`?,]/.test(value) || /^\s|\s$/.test(value)) {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return value;
}

function replaceFrontmatterTitle(content: string, title: string): string {
  const matched = content.match(/^(---\r?\n)([\s\S]*?)(\r?\n---\r?\n?)([\s\S]*)$/);
  if (!matched) {
    throw new RequirementEditNotFoundError("需求 md frontmatter 不合法");
  }

  const lines = matched[2].split(/\r?\n/);
  let replaced = false;
  const nextLines = lines.map((line) => {
    if (/^\s*title\s*:/.test(line)) {
      replaced = true;
      return `title: ${escapeYamlScalar(title)}`;
    }
    return line;
  });
  if (!replaced) {
    nextLines.push(`title: ${escapeYamlScalar(title)}`);
  }

  return `${matched[1]}${nextLines.join("\n")}${matched[3]}${matched[4]}`;
}

function replaceDescriptionSection(content: string, description: string): string {
  const lines = content.split(/\r?\n/);
  const headingIndex = lines.findIndex((line) => /^##\s+需求描述\s*$/.test(line));
  const sectionLines = ["## 需求描述", "", description.trim() || "（待补充）"];

  if (headingIndex === -1) {
    return `${content.trimEnd()}\n\n${sectionLines.join("\n")}\n`;
  }

  let nextHeadingIndex = lines.findIndex((line, index) => index > headingIndex && /^##\s+/.test(line));
  if (nextHeadingIndex === -1) {
    nextHeadingIndex = lines.length;
  }

  return [
    ...lines.slice(0, headingIndex),
    ...sectionLines,
    ...lines.slice(nextHeadingIndex)
  ].join("\n");
}

function applyRequirementMarkdownEdit(content: string, input: Pick<EditRequirementInput, "title" | "description">): string {
  let next = content;
  if (input.title !== undefined) {
    next = replaceFrontmatterTitle(next, input.title);
  }
  if (input.description !== undefined) {
    next = replaceDescriptionSection(next, input.description);
  }
  return next.endsWith("\n") ? next : `${next}\n`;
}

function buildDiffJson(input: {
  beforeTitle: string;
  afterTitle: string;
  beforeDescription: string;
  afterDescription: string;
  beforeMdHash: string;
  afterMdHash: string;
}): string {
  return JSON.stringify({
    title: {
      before: input.beforeTitle,
      after: input.afterTitle,
      changed: input.beforeTitle !== input.afterTitle
    },
    description: {
      before: input.beforeDescription,
      after: input.afterDescription,
      changed: input.beforeDescription !== input.afterDescription
    },
    mdHash: {
      before: input.beforeMdHash,
      after: input.afterMdHash
    }
  });
}

export async function loadRequirementMdHash(
  prisma: PrismaClient,
  projectId: string,
  requirementId: string
): Promise<string> {
  const requirement = await prisma.requirement.findFirst({
    where: { id: requirementId, projectId },
    include: { project: true }
  });
  if (!requirement) {
    throw new RequirementEditNotFoundError();
  }
  const md = await findRequirementMarkdown(requirement.project.localPath, requirement.id);
  return sha256(md.content);
}

export async function loadRequirementMarkdownBody(
  prisma: PrismaClient,
  projectId: string,
  requirementId: string
): Promise<RequirementMarkdownBody> {
  const requirement = await prisma.requirement.findFirst({
    where: { id: requirementId, projectId },
    include: { project: true }
  });
  if (!requirement) {
    throw new RequirementEditNotFoundError();
  }
  const md = await findRequirementMarkdown(requirement.project.localPath, requirement.id);
  return {
    path: md.relativePath,
    content: extractMarkdownBody(md.content)
  };
}

export async function editRequirement(
  prisma: PrismaClient,
  projectId: string,
  requirementId: string,
  input: EditRequirementInput
): Promise<Requirement> {
  return await primitiveExecutor.run({
    primitive: "requirement.edit",
    mutationType: "fs.writeFile + prisma.requirement.upsert + prisma.requirementEditAudit.create",
    run: async () => {
      const requirement = await prisma.requirement.findFirst({
        where: {
          id: requirementId,
          projectId
        },
        include: {
          project: true
        }
      });

      if (!requirement) {
        throw new RequirementEditNotFoundError();
      }
      if (!EDITABLE_REQUIREMENT_STATUSES.has(requirement.status)) {
        throw new RequirementEditStatusConflictError(requirement.status);
      }

      const md = await findRequirementMarkdown(requirement.project.localPath, requirement.id);
      const currentMdHash = sha256(md.content);
      if (currentMdHash !== input.expectedMdHash) {
        throw new RequirementEditHashConflictError(input.expectedMdHash, currentMdHash);
      }

      const beforeParsed = parseDocument({
        relativePath: md.relativePath,
        content: md.content,
        mtime: (await stat(md.absolutePath)).mtime
      });
      const beforeSections = parseRequirementSections(extractMarkdownBody(md.content));
      const beforeTitle = beforeParsed.title;
      const beforeDescription = beforeSections.description;
      const previousAnalysisInputHash =
        requirement.analysisInputHash ?? hashRequirementAnalysisInput(beforeTitle, beforeDescription);
      const nextContent = applyRequirementMarkdownEdit(md.content, input);
      const afterMdHash = sha256(nextContent);

      await writeFile(md.absolutePath, nextContent, "utf8");

      try {
        return await prisma.$transaction(async (tx) => {
          const afterStat = await stat(md.absolutePath);
          const afterParsed = parseDocument({
            relativePath: md.relativePath,
            content: nextContent,
            mtime: afterStat.mtime
          });
          await syncRequirementsFromMarkdown(tx, projectId, requirement.project.localPath, [afterParsed], [md.absolutePath]);

          const updated = await tx.requirement.findUnique({
            where: {
              id: requirement.id
            }
          });
          if (!updated) {
            throw new RequirementEditNotFoundError();
          }

          const nextAnalysisInputHash = hashRequirementAnalysisInput(updated.title, updated.description);
          const staleAt = previousAnalysisInputHash !== nextAnalysisInputHash ? new Date() : null;
          const shouldBackfillAnalysisHash = requirement.analysisInputHash === null;
          const returned = staleAt || shouldBackfillAnalysisHash
            ? await tx.requirement.update({
                where: {
                  id: requirement.id
                },
                data: {
                  ...(shouldBackfillAnalysisHash ? { analysisInputHash: previousAnalysisInputHash } : {}),
                  ...(staleAt ? { analysisStaleAt: staleAt } : {})
                }
              })
            : updated;

          await tx.requirementEditAudit.create({
            data: {
              projectId,
              requirementId: requirement.id,
              editor: input.editor.trim() || "system",
              changeReason: input.changeReason ?? null,
              beforeTitle,
              afterTitle: updated.title,
              beforeDescription,
              afterDescription: updated.description,
              beforeMdHash: currentMdHash,
              afterMdHash,
              diffJson: buildDiffJson({
                beforeTitle,
                afterTitle: returned.title,
                beforeDescription,
                afterDescription: returned.description,
                beforeMdHash: currentMdHash,
                afterMdHash
              })
            }
          });

          return returned;
        });
      } catch (error) {
        await writeFile(md.absolutePath, md.content, "utf8").catch(() => undefined);
        throw error;
      }
    }
  });
}
