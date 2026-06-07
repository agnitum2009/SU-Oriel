export interface TemplateConformanceSectionRule {
  label: string;
  aliases: string[];
}

export interface TemplateConformanceRule {
  requiredSections: TemplateConformanceSectionRule[];
}

export interface TemplateConformanceInput {
  path: string;
  docType: string;
  content: string;
}

export interface TemplateConformanceWarning {
  path: string;
  docType: string;
  missingSections: string[];
  expressionIssues: string[];
}

export const TEMPLATE_CONFORMANCE_RULES: Record<string, TemplateConformanceRule> = {
  requirement: {
    requiredSections: [
      { label: "需求描述", aliases: ["需求描述"] },
      { label: "原话（verbatim）", aliases: ["原话（verbatim）", "原话", "verbatim"] },
      { label: "Claude 解读", aliases: ["Claude 解读", "Claude 解读（可选）"] },
      { label: "歧义点", aliases: ["歧义点", "歧义点（可选）"] },
      { label: "保真差异", aliases: ["保真差异", "保真差异（可选）"] }
    ]
  },
  technical_design: {
    requiredSections: [
      { label: "一、设计概述", aliases: ["一、设计概述", "设计概述"] },
      { label: "二、方案与架构", aliases: ["二、方案与架构", "方案与架构"] },
      { label: "四、核心流程 / 逻辑", aliases: ["四、核心流程 / 逻辑", "核心流程 / 逻辑"] },
      { label: "五、测试策略", aliases: ["五、测试策略", "测试策略"] }
    ]
  },
  dev_task: {
    requiredSections: [
      { label: "一、任务概述", aliases: ["一、任务概述", "任务概述"] },
      { label: "二、任务分解", aliases: ["二、任务分解", "任务分解"] },
      { label: "五、验收标准", aliases: ["五、验收标准", "验收标准"] }
    ]
  }
};

function extractMarkdownBody(content: string): string {
  const matched = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/);
  return matched ? matched[1] : content;
}

function extractFrontmatter(content: string): Record<string, string> {
  const matched = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!matched) return {};

  const frontmatter: Record<string, string> = {};
  for (const line of matched[1].split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const colonIndex = trimmed.indexOf(":");
    if (colonIndex === -1) continue;
    const key = trimmed.slice(0, colonIndex).trim();
    const value = trimmed.slice(colonIndex + 1).trim().replace(/^['"]|['"]$/g, "");
    frontmatter[key] = value;
  }
  return frontmatter;
}

function normalizeHeading(value: string): string {
  return value
    .trim()
    .replace(/^([一二三四五六七八九十]+|\d+)[、.．]\s*/, "")
    .replace(/\s+/g, " ");
}

function extractSecondLevelHeadings(content: string): Set<string> {
  const headings = new Set<string>();
  for (const line of extractMarkdownBody(content).split(/\r?\n/)) {
    const matched = line.match(/^##\s+(.+?)\s*$/);
    if (!matched) continue;
    headings.add(matched[1].trim());
    headings.add(normalizeHeading(matched[1]));
  }
  return headings;
}

function isTemplateMarkdownPath(path: string): boolean {
  const fileName = path.split(/[\\/]/).pop() ?? path;
  return fileName.startsWith("_模板_");
}

function shouldCheckExpression(input: TemplateConformanceInput): boolean {
  if (!["requirement", "technical_design"].includes(input.docType)) {
    return false;
  }
  return extractFrontmatter(input.content).expression_spec === "v1";
}

function evaluateExpressionIssues(input: TemplateConformanceInput): string[] {
  if (!shouldCheckExpression(input)) {
    return [];
  }

  const body = extractMarkdownBody(input.content);
  const issues: string[] = [];
  if (!body.includes("目标对齐")) {
    issues.push("缺少「目标对齐」表达块");
  }
  if (!body.includes("模拟示例") && !body.includes("无需示例")) {
    issues.push("缺少「模拟示例」或「无需示例」说明");
  }
  if (!isTemplateMarkdownPath(input.path)) {
    const placeholders = ["[占位]", "<由系统生成>"].filter((marker) => body.includes(marker));
    if (placeholders.length > 0) {
      issues.push(`残留模板占位符：${placeholders.join("、")}`);
    }
  }
  return issues;
}

export function evaluateTemplateConformance(input: TemplateConformanceInput): TemplateConformanceWarning | null {
  const rule = TEMPLATE_CONFORMANCE_RULES[input.docType];
  if (!rule) {
    return null;
  }

  const headings = extractSecondLevelHeadings(input.content);
  const missingSections = rule.requiredSections
    .filter((section) => !section.aliases.some((alias) => headings.has(alias) || headings.has(normalizeHeading(alias))))
    .map((section) => section.label);
  const expressionIssues = evaluateExpressionIssues(input);

  if (missingSections.length === 0 && expressionIssues.length === 0) {
    return null;
  }

  return {
    path: input.path,
    docType: input.docType,
    missingSections,
    expressionIssues
  };
}
