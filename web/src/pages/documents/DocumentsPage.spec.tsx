import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeEach, expect, test, vi } from "vitest";

import { DocumentsPage } from "./DocumentsPage.js";
import type { DocumentDetailView, DocumentGovernanceView, DocumentView } from "../../types/document.js";
import { useDetailStore } from "../../stores/detail-store.js";
import { useProjectStore } from "../../stores/project-store.js";

const navigateMock = vi.fn();
let paramsMock: Record<string, string | undefined> = {};

vi.mock("react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router")>();
  return { ...actual, useNavigate: () => navigateMock, useParams: () => paramsMock };
});

function doc(
  over: Pick<DocumentView, "id" | "path" | "kind"> &
    Partial<Omit<DocumentView, "governance">> & { governance?: Partial<DocumentGovernanceView> }
): DocumentView {
  return {
    id: over.id,
    projectId: "p",
    taskKey: over.taskKey ?? null,
    path: over.path,
    kind: over.kind,
    title: over.title ?? over.path,
    status: null,
    summary: null,
    parseStatus: over.parseStatus ?? "success",
    mtime: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
    governance: {
      tier: "生效中",
      requirementId: null,
      entityStatus: null,
      taskId: null,
      healthFlags: { parseError: false },
      ...over.governance
    }
  };
}

const documents = [
  doc({
    id: "d-td",
    path: "docs/03_开发计划/td-技术设计.md",
    kind: "technical_design",
    title: "技术设计 A",
    governance: { requirementId: "req-1" }
  }),
  doc({
    id: "d-history",
    path: "docs/03_开发计划/history-开发任务.md",
    kind: "dev_task",
    title: "历史任务",
    governance: { requirementId: "req-1", taskId: "subtask-history", tier: "历史" }
  }),
  doc({
    id: "d-broken",
    path: "docs/03_开发计划/broken-开发任务.md",
    kind: "dev_task",
    title: "解析异常任务",
    parseStatus: "parse_error",
    governance: { requirementId: "req-1", healthFlags: { parseError: true } }
  }),
  doc({
    id: "d-arch",
    path: "docs/01_架构设计/arch-架构.md",
    kind: "architecture",
    title: "系统架构",
    governance: { requirementId: null }
  }),
  doc({
    id: "d-archive",
    path: "docs/99_归档/old-需求.md",
    kind: "requirement",
    title: "归档需求",
    governance: { tier: "归档" }
  })
];

function detailFrom(document: DocumentView): DocumentDetailView {
  return {
    id: document.id,
    projectId: document.projectId,
    taskKey: document.taskKey,
    path: document.path,
    kind: document.kind,
    title: document.title,
    status: document.status,
    summary: document.summary,
    parseStatus: document.parseStatus,
    mtime: document.mtime,
    updatedAt: document.updatedAt,
    frontmatter: { doc_type: document.kind },
    content: `---\ndoc_type: ${document.kind}\n---\n\n# ${document.title}\n\n正文内容`
  };
}

beforeEach(() => {
  paramsMock = {};
  navigateMock.mockReset();
  useDetailStore.setState({
    documentDetail: null,
    loadingDocumentDetail: false,
    loadDocumentDetail: vi.fn(async () => {}),
    clearDocumentDetail: vi.fn(() => useDetailStore.setState({ documentDetail: null }))
  });
  useProjectStore.setState({
    selectedProjectId: "project-1",
    loadingData: false,
    documents
  });
});

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/projects/project-1/documents"]}>
      <DocumentsPage />
    </MemoryRouter>
  );
}

test("两栏浏览器不渲染治理聚合内容", () => {
  const { container } = renderPage();
  const text = container.textContent ?? "";
  expect(container.querySelector(`[class*="${"governance" + "Pane"}"]`)).toBeNull();
  for (const forbidden of ["文档" + "覆盖", "健" + "康度", "未绑定" + "文档", "覆盖" + "缺口", "中栏" + "覆盖卡"]) {
    expect(text.includes(forbidden)).toBe(false);
  }
});

test("目录按 full parent directory 分组，同目录不同 tier 合并为一个目录组", () => {
  renderPage();
  expect(screen.getAllByText("docs/03_开发计划")).toHaveLength(1);
  // 默认折叠，先展开目录组才能看到文档项。
  fireEvent.click(screen.getByText("docs/03_开发计划"));
  expect(screen.getByText("技术设计 A")).toBeTruthy();
  expect(screen.getByText("历史任务")).toBeTruthy();
});

test("搜索按标题或路径过滤左栏文档", () => {
  renderPage();
  fireEvent.change(screen.getByPlaceholderText("搜索文档..."), { target: { value: "系统" } });
  expect(screen.getByText("系统架构")).toBeTruthy();
  expect(screen.queryByText("技术设计 A")).toBeNull();

  fireEvent.change(screen.getByPlaceholderText("搜索文档..."), { target: { value: "old-需求" } });
  expect(screen.getByText("归档需求")).toBeTruthy();
  expect(screen.queryByText("系统架构")).toBeNull();
});

test("档位筛选生效，默认只给历史和归档文档贴档位小标", () => {
  const { container } = renderPage();
  // 默认折叠，展开含 tier 标记的目录组后再统计。
  fireEvent.click(screen.getByText("docs/03_开发计划"));
  fireEvent.click(screen.getByText("docs/99_归档"));
  expect(container.querySelectorAll('[data-tier="生效中"]')).toHaveLength(0);
  expect(container.querySelectorAll('[data-tier="历史"]')).toHaveLength(1);
  expect(container.querySelectorAll('[data-tier="归档"]')).toHaveLength(1);

  fireEvent.change(screen.getByLabelText("档位筛选"), { target: { value: "历史" } });
  expect(screen.getByText("历史任务")).toBeTruthy();
  expect(screen.queryByText("技术设计 A")).toBeNull();
  expect(screen.queryByText("归档需求")).toBeNull();
});

test("parseError 仅作为对应文档项的小标记出现", () => {
  renderPage();
  // 默认折叠，先展开目录组才能看到文档项及其解析异常标记。
  fireEvent.click(screen.getByText("docs/03_开发计划"));
  expect(screen.getByLabelText("解析异常任务 解析异常")).toBeTruthy();
  expect(screen.queryByLabelText("技术设计 A 解析异常")).toBeNull();
});

test("点击文档导航到 scoped /documents/:id", () => {
  renderPage();
  // 默认折叠，先展开目录组再点击文档项。
  fireEvent.click(screen.getByText("docs/03_开发计划"));
  fireEvent.click(screen.getByRole("button", { name: /技术设计 A/ }));
  expect(navigateMock).toHaveBeenCalledWith("/projects/project-1/documents/d-td");
});

test("未选择文档时右栏展示新空态文案", () => {
  const { container } = renderPage();
  expect(screen.getByText("从左侧目录选择文档后，这里会展示 Markdown 阅读器。")).toBeTruthy();
  expect((container.textContent ?? "").includes("中栏覆盖卡")).toBe(false);
});

test("选中文档后右栏保留 Markdown 阅读器和元数据", () => {
  paramsMock = { documentId: "d-td" };
  useDetailStore.setState({ documentDetail: detailFrom(documents[0]), loadingDocumentDetail: false });

  renderPage();
  expect(screen.getByRole("heading", { level: 2, name: "技术设计 A" })).toBeTruthy();
  expect(screen.getByText("元数据")).toBeTruthy();
  expect(screen.getByText("正文内容")).toBeTruthy();
});

test("文档详情加载中时右栏保留 loading 状态", () => {
  paramsMock = { documentId: "d-td" };
  useDetailStore.setState({ documentDetail: null, loadingDocumentDetail: true });

  const { container } = renderPage();
  expect(container.querySelector('[class*="readerSkeleton"]')).toBeTruthy();
});
