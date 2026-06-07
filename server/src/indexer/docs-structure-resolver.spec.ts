import assert from "node:assert/strict";
import { test } from "vitest";

import { loadDocsStructureResolver } from "./docs-structure-resolver.js";

test("default docs structure contract exposes document templates", () => {
  const resolver = loadDocsStructureResolver();

  assert.equal(resolver.resolveDocType("project_overview").template, "_模板_项目总览.md");
  assert.equal(resolver.resolveDocType("doc_map").template, "_模板_文档地图.md");
  assert.equal(resolver.resolveDocType("architecture").template, "_模板_架构.md");
  assert.equal(resolver.resolveDocType("requirement").template, "_模板_需求.md");
  assert.equal(resolver.resolveDocType("technical_design").template, "_模板_技术设计.md");
  assert.equal(resolver.resolveDocType("dev_task").template, "_模板_开发任务.md");
  assert.equal(resolver.resolveDocType("module_spec").template, "_模板_模块规格.md");
  assert.equal(resolver.resolveDocType("lessons").template, "_模板_经验沉淀.md");
  assert.equal(resolver.resolveDocType("adr").template, "_模板_ADR.md");
});
