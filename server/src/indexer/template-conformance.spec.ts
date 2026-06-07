import assert from "node:assert/strict";
import { describe, test } from "vitest";

import { evaluateTemplateConformance } from "./template-conformance.js";

describe("template conformance", () => {
  test("accepts adaptive technical_design docs with core sections only", () => {
    const warning = evaluateTemplateConformance({
      path: "docs/03_开发计划/example-技术设计.md",
      docType: "technical_design",
      content: [
        "---",
        "doc_type: technical_design",
        "---",
        "",
        "## 一、设计概述",
        "",
        "概述。",
        "",
        "## 二、方案与架构",
        "",
        "方案。",
        "",
        "## 四、核心流程 / 逻辑",
        "",
        "流程。",
        "",
        "## 五、测试策略",
        "",
        "测试。"
      ].join("\n")
    });

    assert.equal(warning, null);
  });

  test("reports missing core sections without requiring optional sections", () => {
    const warning = evaluateTemplateConformance({
      path: "docs/03_开发计划/example-技术设计.md",
      docType: "technical_design",
      content: [
        "## 一、设计概述",
        "",
        "概述。",
        "",
        "## 五、测试策略",
        "",
        "测试。"
      ].join("\n")
    });

    assert.deepEqual(warning, {
      path: "docs/03_开发计划/example-技术设计.md",
      docType: "technical_design",
      missingSections: ["二、方案与架构", "四、核心流程 / 逻辑"],
      expressionIssues: []
    });
  });

  test("accepts dev_task core headings and ignores deleted optional sections", () => {
    const warning = evaluateTemplateConformance({
      path: "docs/03_开发计划/example-开发任务.md",
      docType: "dev_task",
      content: [
        "## 一、任务概述",
        "",
        "概述。",
        "",
        "## 二、任务分解",
        "",
        "- [ ] 实现。",
        "",
        "## 五、验收标准",
        "",
        "- [ ] 验收。"
      ].join("\n")
    });

    assert.equal(warning, null);
  });

  test("accepts requirement projection anchor variants", () => {
    const warning = evaluateTemplateConformance({
      path: "docs/02_需求设计/example-需求.md",
      docType: "requirement",
      content: [
        "## 需求描述",
        "",
        "描述。",
        "",
        "## 原话",
        "",
        "原话。",
        "",
        "## Claude 解读（可选）",
        "",
        "解读。",
        "",
        "## 歧义点（可选）",
        "",
        "无。",
        "",
        "## 保真差异（可选）",
        "",
        "一致。"
      ].join("\n")
    });

    assert.equal(warning, null);
  });

  test("keeps expression checks gated by expression_spec v1", () => {
    const warning = evaluateTemplateConformance({
      path: "docs/03_开发计划/legacy-技术设计.md",
      docType: "technical_design",
      content: [
        "---",
        "doc_type: technical_design",
        "---",
        "",
        "## 一、设计概述",
        "",
        "概述。",
        "",
        "## 二、方案与架构",
        "",
        "方案。",
        "",
        "## 四、核心流程 / 逻辑",
        "",
        "流程。",
        "",
        "## 五、测试策略",
        "",
        "测试。"
      ].join("\n")
    });

    assert.equal(warning, null);
  });

  test("reports expression issues for marked requirement docs", () => {
    const warning = evaluateTemplateConformance({
      path: "docs/02_需求设计/example-需求.md",
      docType: "requirement",
      content: [
        "---",
        "doc_type: requirement",
        "expression_spec: v1",
        "---",
        "",
        "## 需求描述",
        "",
        "描述。",
        "",
        "## 原话（verbatim）",
        "",
        "原话。",
        "",
        "## Claude 解读",
        "",
        "解读。",
        "",
        "## 歧义点",
        "",
        "无。",
        "",
        "## 保真差异",
        "",
        "一致。"
      ].join("\n")
    });

    assert.deepEqual(warning, {
      path: "docs/02_需求设计/example-需求.md",
      docType: "requirement",
      missingSections: [],
      expressionIssues: ["缺少「目标对齐」表达块", "缺少「模拟示例」或「无需示例」说明"]
    });
  });

  test("accepts expression exemption markers for marked technical designs", () => {
    const warning = evaluateTemplateConformance({
      path: "docs/03_开发计划/example-技术设计.md",
      docType: "technical_design",
      content: [
        "---",
        "doc_type: technical_design",
        "expression_spec: v1",
        "---",
        "",
        "## 一、设计概述",
        "",
        "**目标对齐（白话）**：这次只做单点文案修正。",
        "",
        "## 二、方案与架构",
        "",
        "沿用现有结构。",
        "",
        "## 四、核心流程 / 逻辑",
        "",
        "无需示例，因为没有多角色、状态机或跨模块流程。",
        "",
        "## 五、测试策略",
        "",
        "单测覆盖。"
      ].join("\n")
    });

    assert.equal(warning, null);
  });

  test("reports placeholder residue only for marked non-template documents", () => {
    const content = [
      "---",
      "doc_type: technical_design",
      "expression_spec: v1",
      "---",
      "",
      "## 一、设计概述",
      "",
      "**目标对齐**：[占位]",
      "",
      "## 二、方案与架构",
      "",
      "方案。",
      "",
      "## 四、核心流程 / 逻辑",
      "",
      "模拟示例：<由系统生成>",
      "",
      "## 五、测试策略",
      "",
      "测试。"
    ].join("\n");

    const warning = evaluateTemplateConformance({
      path: "docs/03_开发计划/example-技术设计.md",
      docType: "technical_design",
      content
    });
    const templateWarning = evaluateTemplateConformance({
      path: "docs/03_开发计划/_模板_技术设计.md",
      docType: "technical_design",
      content
    });

    assert.deepEqual(warning, {
      path: "docs/03_开发计划/example-技术设计.md",
      docType: "technical_design",
      missingSections: [],
      expressionIssues: ["残留模板占位符：[占位]、<由系统生成>"]
    });
    assert.equal(templateWarning, null);
  });

  test("does not expression-check dev_task in this rollout", () => {
    const warning = evaluateTemplateConformance({
      path: "docs/03_开发计划/example-开发任务.md",
      docType: "dev_task",
      content: [
        "---",
        "doc_type: dev_task",
        "expression_spec: v1",
        "---",
        "",
        "## 一、任务概述",
        "",
        "[占位]",
        "",
        "## 二、任务分解",
        "",
        "<由系统生成>",
        "",
        "## 五、验收标准",
        "",
        "- [ ] 验收。"
      ].join("\n")
    });

    assert.equal(warning, null);
  });
});
