import { useEffect, useMemo, useRef, useState } from "react";
import {
  Navigate,
  Outlet,
  RouterProvider,
  createBrowserRouter,
  useLocation,
  useNavigate
} from "react-router";

import styles from "./App.module.css";
import { AiCliSettingsModal } from "./components/ai-cli/AiCliSettingsModal.js";
import { CommandPalette, type CommandPaletteItem } from "./components/command-palette/CommandPalette.js";
import { HotkeysHelp } from "./components/keyboard/HotkeysHelp.js";
import { AppShell } from "./components/layout/AppShell.js";
import { MainTerminalLauncher } from "./components/main-terminal/MainTerminalLauncher.js";
import { NotificationBell } from "./components/notifications/NotificationBell.js";
import { NotificationManager } from "./components/notifications/NotificationManager.js";
import { PageHeader } from "./components/layout/PageHeader.js";
import { Sidebar } from "./components/layout/Sidebar.js";
import { ProjectScanProgressBar } from "./components/projects/ProjectScanProgressBar.js";
import { RequirementMarkdownEditor } from "./components/requirements/RequirementMarkdownEditor.js";
import { Button } from "./components/ui/Button.js";
import { Input, Textarea } from "./components/ui/Input.js";
import { Modal } from "./components/ui/Modal.js";
import { ToastViewport } from "./components/ui/Toast.js";
import { SlotRequirementsFab } from "./components/slot-requirements-fab/SlotRequirementsFab.js";
import { AiCliPage } from "./pages/ai-cli/AiCliPage.js";
import { RecordingPlayPage } from "./pages/ai-cli/RecordingPlayPage.js";
import { BreakdownReviewPage } from "./pages/breakdown-review/BreakdownReviewPage.js";
import { DocumentsPage } from "./pages/documents/DocumentsPage.js";
import { OverviewPage } from "./pages/overview/OverviewPage.js";
import { MyWorkPage } from "./pages/my-work/MyWorkPage.js";
import { SlotsPage } from "./pages/slots/SlotsPage.js";
import { SprintsPage } from "./pages/sprints/SprintsPage.js";
import { RequirementDetailPage } from "./pages/requirements/RequirementDetailPage.js";
import { RequirementsPage } from "./pages/requirements/RequirementsPage.js";
import { ReconcileReportsPage } from "./pages/reconcile/ReconcileReportsPage.js";
import { RunsPage } from "./pages/runs/RunsPage.js";
import { SettingsPage } from "./pages/settings/SettingsPage.js";
import { TasksPage } from "./pages/tasks/TasksPage.js";
import { uploadRequirementAsset } from "./lib/console-api.js";
import { createRequirementPreviewItems } from "./lib/ui-mapping.js";
import { useProjectStore } from "./stores/project-store.js";
import { useUIStore } from "./stores/ui-store.js";
import type { CreateProjectFormValue } from "./types/project.js";
import type { RequirementFormValue } from "./types/requirement.js";

const initialProjectForm: CreateProjectFormValue = {
  name: "",
  localPath: "",
  summary: ""
};

// outputMode 字段保留供后端兼容；UI 已移除选择器（v0.4 起仅暴露 requirement_only）。
const initialRequirementForm: RequirementFormValue = {
  title: "",
  description: "",
  outputMode: "requirement_only",
  verbatimSource: "",
  claudeInterpretation: "",
  ambiguities: "",
  fidelityDiff: ""
};

type RequirementStep = "edit" | "confirm";

function createTmpUuid(): string {
  return globalThis.crypto?.randomUUID?.() ?? `asset-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function ConsoleLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  const projects = useProjectStore((state) => state.projects);
  const selectedProjectId = useProjectStore((state) => state.selectedProjectId);
  const loadingProjects = useProjectStore((state) => state.loadingProjects);
  const loadProjects = useProjectStore((state) => state.loadProjects);
  const silentRefreshProjects = useProjectStore((state) => state.silentRefreshProjects);
  const loadProjectData = useProjectStore((state) => state.loadProjectData);
  const selectProject = useProjectStore((state) => state.selectProject);
  const createProject = useProjectStore((state) => state.createProject);
  const scanProject = useProjectStore((state) => state.scanProject);
  const createRequirement = useProjectStore((state) => state.createRequirement);
  // Phase A2: Cmd+K 任务/Epic/Requirement 搜索
  const tasksForCommand = useProjectStore((state) => state.tasks);
  const requirementsForCommand = useProjectStore((state) => state.requirements);
  const sidebarCollapsed = useUIStore((state) => state.sidebarCollapsed);
  const modalOpen = useUIStore((state) => state.modalOpen);
  const modalType = useUIStore((state) => state.modalType);
  const openModal = useUIStore((state) => state.openModal);
  const closeModal = useUIStore((state) => state.closeModal);
  const addToast = useUIStore((state) => state.addToast);
  const selectedProject = projects.find((project) => project.id === selectedProjectId) ?? null;
  const hasSelectedProject = Boolean(selectedProject);

  const [projectForm, setProjectForm] = useState<CreateProjectFormValue>(initialProjectForm);
  const [creatingProject, setCreatingProject] = useState(false);
  const [requirementForm, setRequirementForm] = useState<RequirementFormValue>(initialRequirementForm);
  const [requirementAssetTmpUuid, setRequirementAssetTmpUuid] = useState(createTmpUuid);
  const [requirementStep, setRequirementStep] = useState<RequirementStep>("edit");
  const [creatingRequirement, setCreatingRequirement] = useState(false);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  useEffect(() => {
    if (!selectedProjectId || !hasSelectedProject) {
      return;
    }

    void loadProjectData(selectedProjectId);
  }, [hasSelectedProject, loadProjectData, selectedProjectId]);

  // ADR-0012 §R3：后端 file-watcher 改 DB 时前端无 push 通道，30s silent refresh
  // 比对 lastScanAt；变化时再触发 loadProjectData 拉全量。visibilitychange 立即拉一次。
  const lastSeenScanAtRef = useRef<string | null>(null);
  useEffect(() => {
    if (!selectedProjectId || !hasSelectedProject) return;
    const tick = async () => {
      await silentRefreshProjects();
      const next = useProjectStore.getState().projects.find((p) => p.id === selectedProjectId);
      if (!next) return;
      const nextScan = next.lastScanAt ?? null;
      if (nextScan !== lastSeenScanAtRef.current) {
        lastSeenScanAtRef.current = nextScan;
        void loadProjectData(selectedProjectId);
      }
    };
    // 进入这个项目时记一次基线
    const cur = useProjectStore.getState().projects.find((p) => p.id === selectedProjectId);
    lastSeenScanAtRef.current = cur?.lastScanAt ?? null;

    const onVisible = () => {
      if (!document.hidden) void tick();
    };
    const intervalId = window.setInterval(tick, 30_000);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(intervalId);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [hasSelectedProject, selectedProjectId, silentRefreshProjects, loadProjectData]);

  const pageTitle = getPageTitle(location.pathname);
  const pageHeaderActions = getHeaderActions({
    pathname: location.pathname,
    hasProject: hasSelectedProject,
    onScan: async () => {
      try {
        await scanProject();
        addToast("success", "项目扫描已开始");
      } catch (error) {
        addToast("error", error instanceof Error ? error.message : "项目扫描失败");
      }
    },
    onCreateRequirement: () => openModal("create-requirement")
  });
  const headerActions = hasSelectedProject ? (
    <>
      <NotificationBell projectId={selectedProjectId} />
      {pageHeaderActions}
    </>
  ) : pageHeaderActions;

  const projectFormValid =
    projectForm.name.trim().length > 0 &&
    projectForm.localPath.trim().length > 0 &&
    projectForm.summary.trim().length <= 500;
  const requirementFormValid =
    requirementForm.title.trim().length > 0 &&
    requirementForm.title.trim().length <= 120 &&
    requirementForm.description.trim().length > 0 &&
    requirementForm.description.trim().length <= 4000 &&
    requirementForm.verbatimSource.length <= 12000 &&
    requirementForm.claudeInterpretation.length <= 12000 &&
    requirementForm.ambiguities.length <= 12000 &&
    requirementForm.fidelityDiff.length <= 12000;

  const resetProjectForm = () => {
    setProjectForm(initialProjectForm);
  };

  const resetRequirementForm = () => {
    setRequirementForm(initialRequirementForm);
    setRequirementAssetTmpUuid(createTmpUuid());
    setRequirementStep("edit");
  };

  const handleCloseProjectModal = () => {
    resetProjectForm();
    closeModal();
  };

  const handleCloseRequirementModal = () => {
    resetRequirementForm();
    closeModal();
  };

  const handleSelectProject = (projectId: string) => {
    selectProject(projectId);
    if (location.pathname === "/" || location.pathname === "/overview") {
      return;
    }
    if (location.pathname.startsWith("/documents/")) {
      navigate("/documents");
      return;
    }
    if (location.pathname.startsWith("/tasks/")) {
      navigate("/tasks");
    }
  };

  const handleCreateProject = async () => {
    if (!projectFormValid) {
      addToast("error", "项目名称和本地路径不能为空，项目简介最多 500 字");
      return;
    }

    setCreatingProject(true);
    try {
      await createProject({
        ...projectForm,
        summary: projectForm.summary.trim()
      });
      resetProjectForm();
      closeModal();
      addToast("success", "项目创建成功");
      navigate("/overview");
    } catch (error) {
      addToast("error", error instanceof Error ? error.message : "创建项目失败");
    } finally {
      setCreatingProject(false);
    }
  };

  const handleRequirementNext = () => {
    if (!requirementFormValid) {
      addToast("error", "请填写完整需求标题和描述");
      return;
    }

    setRequirementStep("confirm");
  };

  const handleCreateRequirement = async () => {
    if (!requirementFormValid) {
      addToast("error", "需求表单内容不完整");
      setRequirementStep("edit");
      return;
    }

    setCreatingRequirement(true);
    try {
      const assetOwner = `tmp-${requirementAssetTmpUuid}`;
      // 提交前把 description 内的 web URL 还原为 md-first 相对路径
      // /api/projects/<pid>/requirements/<owner>/assets/<filename>
      //   → ./assets/requirements/<owner>/<filename>
      const escapeRegExp = (str: string) => str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const webAssetPrefixRe = selectedProjectId
        ? new RegExp(
            `${escapeRegExp(`/api/projects/${selectedProjectId}/requirements/`)}([^/]+)/assets/`,
            "g"
          )
        : null;
      const normalizedDescription = (webAssetPrefixRe
        ? requirementForm.description.replace(webAssetPrefixRe, "./assets/requirements/$1/")
        : requirementForm.description
      ).trim();
      const hasTmpAssets = normalizedDescription.includes(`./assets/requirements/${assetOwner}/`);
      await createRequirement({
        ...requirementForm,
        title: requirementForm.title.trim(),
        description: normalizedDescription,
        assetTmpUuid: hasTmpAssets ? requirementAssetTmpUuid : undefined,
        claudeInterpretation: requirementForm.claudeInterpretation,
        ambiguities: requirementForm.ambiguities,
        fidelityDiff: requirementForm.fidelityDiff
      });
      handleCloseRequirementModal();
      addToast("success", "需求创建成功");
      navigate("/requirements");
    } catch (error) {
      addToast("error", error instanceof Error ? error.message : "创建需求失败");
    } finally {
      setCreatingRequirement(false);
    }
  };

  const handleUploadRequirementImage = async (file: File): Promise<string> => {
    if (!selectedProjectId) {
      throw new Error("当前没有选中的项目");
    }
    if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.type)) {
      const message = "仅支持 png / jpeg / webp / gif 图片";
      addToast("error", message);
      throw new Error(message);
    }
    if (file.size > 5 * 1024 * 1024) {
      const message = "图片不能超过 5MB";
      addToast("error", message);
      throw new Error(message);
    }
    try {
      const result = await uploadRequirementAsset(selectedProjectId, `tmp-${requirementAssetTmpUuid}`, file);
      addToast("success", "图片已上传");
      // 把后端返回的相对路径 ./assets/requirements/:owner/:filename
      // 转成 web 可访问 URL /api/projects/:pid/requirements/:owner/assets/:filename
      // 让 EasyMDE 的 previewImagesInEditor 能直接加载图片显示在编辑器内
      const match = result.path.match(/^\.\/assets\/requirements\/([^/]+)\/(.+)$/);
      if (match) {
        return `/api/projects/${selectedProjectId}/requirements/${match[1]}/assets/${match[2]}`;
      }
      return result.path;
    } catch (error) {
      const message = error instanceof Error ? error.message : "图片上传失败";
      addToast("error", message);
      throw error;
    }
  };

  const requirementPreviewItems = createRequirementPreviewItems(requirementForm.outputMode);
  const commandPaletteItems: CommandPaletteItem[] = useMemo(
    () => [
      {
        id: "open-overview",
        label: "打开概览",
        hint: "进入项目概览页",
        keywords: ["overview", "project"],
        run: () => navigate("/overview")
      },
      {
        id: "open-documents",
        label: "打开文档中心",
        hint: "查看项目文档索引",
        keywords: ["documents", "docs"],
        run: () => navigate("/documents")
      },
      {
        id: "open-tasks",
        label: "打开任务看板",
        hint: "查看任务阶段和详情",
        keywords: ["tasks", "kanban"],
        run: () => navigate("/tasks")
      },
      {
        id: "open-my-work",
        label: "打开我的工作",
        hint: "需要处理 / 关注 / 最近活跃",
        keywords: ["my work", "inbox", "我的"],
        run: () => navigate("/my-work")
      },
      {
        id: "open-sprints",
        label: "打开迭代",
        hint: "Sprint / 燃尽图",
        keywords: ["sprint", "迭代", "burndown"],
        run: () => navigate("/sprints")
      },
      {
        id: "open-requirements",
        label: "打开需求管理",
        hint: "查看需求列表",
        keywords: ["requirements"],
        run: () => navigate("/requirements")
      },
      {
        id: "open-runs",
        label: "打开运行记录",
        hint: "查看扫描和生成记录",
        keywords: ["runs"],
        run: () => navigate("/runs")
      },
      {
        id: "open-reconcile",
        label: "打开 Reconcile",
        hint: "查看 AI 自检与修复报告",
        keywords: ["reconcile", "drift", "repair"],
        run: () => navigate("/reconcile")
      },
      {
        id: "open-ai-cli",
        label: "打开 AI CLI",
        hint: "进入 AI CLI 工作区",
        keywords: ["ai", "cli"],
        run: () => navigate("/ai-cli")
      },
      {
        id: "open-settings",
        label: "打开设置",
        hint: "配置当前项目扫描与解析规则",
        keywords: ["settings"],
        run: () => navigate("/settings")
      },
      {
        id: "scan-documents",
        label: "扫描文档",
        hint: "等价于概览/文档页扫描按钮",
        keywords: ["scan"],
        disabled: !hasSelectedProject,
        run: async () => {
          try {
            await scanProject();
            addToast("success", "项目扫描已开始");
          } catch (error) {
            addToast("error", error instanceof Error ? error.message : "项目扫描失败");
          }
        }
      },
      {
        id: "create-requirement",
        label: "新建需求",
        hint: "打开需求创建弹窗",
        keywords: ["create requirement"],
        disabled: !hasSelectedProject,
        run: () => {
          navigate("/requirements");
          openModal("create-requirement");
        }
      },
      // Phase A2: 动态注入子任务 / Requirement quick-jump (限 50 条避免长列表)
      ...tasksForCommand.slice(0, 30).map((task) => ({
        id: `jump-task-${task.id}`,
        label: `📄 ${task.title}`,
        hint: `${task.taskKey} · ${task.currentNode ?? "?"} · ${task.progress}%`,
        keywords: [task.taskKey, task.title, task.kind ?? "subtask"],
        run: () => navigate(`/tasks/${task.id}`)
      })),
      ...requirementsForCommand.slice(0, 20).map((req) => ({
        id: `jump-requirement-${req.id}`,
        label: `📋 ${req.title}`,
        hint: `需求 · ${req.status}`,
        keywords: [req.title, "requirement", "需求"],
        run: () => navigate(`/requirements/${req.id}`)
      }))
    ],
    [addToast, hasSelectedProject, navigate, openModal, scanProject, selectedProjectId, tasksForCommand, requirementsForCommand]
  );

  return (
    <AppShell
      header={<PageHeader actions={headerActions} projectName={selectedProject?.name ?? null} title={pageTitle} />}
      progress={<ProjectScanProgressBar project={selectedProject} />}
      sidebar={
        <Sidebar
          loading={loadingProjects}
          onCreateProject={() => openModal("create-project")}
          onSelectProject={handleSelectProject}
          projects={projects}
          selectedProjectId={selectedProjectId}
        />
      }
      sidebarCollapsed={sidebarCollapsed}
    >
      <NotificationManager projectId={selectedProjectId} />
      <Outlet />

      <Modal
        footer={
          <>
            <Button onClick={handleCloseProjectModal} variant="secondary">
              取消
            </Button>
            <Button disabled={!projectFormValid} loading={creatingProject} onClick={handleCreateProject}>
              {creatingProject ? "正在创建..." : "创建项目"}
            </Button>
          </>
        }
        onClose={handleCloseProjectModal}
        open={modalOpen && modalType === "create-project"}
        title="创建项目"
      >
        <div className={styles.formGrid}>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>项目名称 *</span>
            <Input
              maxLength={120}
              onChange={(event) => setProjectForm((state) => ({ ...state, name: event.target.value }))}
              placeholder="例如：CCB Console"
              value={projectForm.name}
            />
          </label>

          <label className={styles.field}>
            <span className={styles.fieldLabel}>本地路径 *</span>
            <Input
              onChange={(event) => setProjectForm((state) => ({ ...state, localPath: event.target.value }))}
              placeholder="例如：/home/user/dev/myproject"
              value={projectForm.localPath}
            />
          </label>

          <label className={styles.field}>
            <span className={styles.fieldLabel}>项目简介</span>
            <Textarea
              maxLength={500}
              onChange={(event) => setProjectForm((state) => ({ ...state, summary: event.target.value }))}
              placeholder="补充项目背景、目标和当前阶段"
              rows={4}
              value={projectForm.summary}
            />
            <span className={styles.fieldHint}>最多 500 字</span>
          </label>
        </div>
      </Modal>

      <Modal
        footer={
          requirementStep === "edit" ? (
            <>
              <Button onClick={handleCloseRequirementModal} variant="secondary">
                取消
              </Button>
              <Button disabled={!requirementFormValid} onClick={handleRequirementNext}>
                下一步
              </Button>
            </>
          ) : (
            <>
              <Button onClick={() => setRequirementStep("edit")} variant="secondary">
                返回修改
              </Button>
              <Button loading={creatingRequirement} onClick={handleCreateRequirement}>
                {creatingRequirement ? "正在创建..." : "确认创建"}
              </Button>
            </>
          )
        }
        onClose={handleCloseRequirementModal}
        open={modalOpen && modalType === "create-requirement"}
        size="xl"
        title={requirementStep === "edit" ? "新建需求" : "确认创建"}
      >
        {requirementStep === "edit" ? (
          <div className={styles.formGrid}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>需求标题 *</span>
              <Input
                maxLength={120}
                onChange={(event) => setRequirementForm((state) => ({ ...state, title: event.target.value }))}
                placeholder="例如：增加通知中心"
                value={requirementForm.title}
              />
            </label>

            <div className={styles.field}>
              <span className={styles.fieldLabel}>需求描述 *</span>
              <RequirementMarkdownEditor
                onChange={(description) => setRequirementForm((state) => ({ ...state, description }))}
                onUploadImage={handleUploadRequirementImage}
                projectId={selectedProjectId ?? ""}
                value={requirementForm.description}
              />
              <span className={styles.fieldHint}>Markdown 内容最多 4000 字；图片会保存到项目 docs/.ccb/assets/requirements。</span>
            </div>

            <label className={styles.field}>
              <span className={styles.fieldLabel}>用户原话（verbatim_source）</span>
              <Textarea
                maxLength={12000}
                onChange={(event) =>
                  setRequirementForm((state) => ({ ...state, verbatimSource: event.target.value }))
                }
                placeholder="不填写时自动使用需求描述"
                rows={5}
                value={requirementForm.verbatimSource}
              />
              <span className={styles.fieldHint}>原样保存换行和空白，用于后续 consult brief。</span>
            </label>

            <div className={styles.fidelityGrid}>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>Claude 解读（claude_interpretation）</span>
                <Textarea
                  maxLength={12000}
                  onChange={(event) =>
                    setRequirementForm((state) => ({ ...state, claudeInterpretation: event.target.value }))
                  }
                  placeholder="可留空，后续由 requirement_analysis 补齐"
                  rows={4}
                  value={requirementForm.claudeInterpretation}
                />
              </label>

              <label className={styles.field}>
                <span className={styles.fieldLabel}>歧义点（ambiguities）</span>
                <Textarea
                  maxLength={12000}
                  onChange={(event) => setRequirementForm((state) => ({ ...state, ambiguities: event.target.value }))}
                  placeholder="可留空"
                  rows={4}
                  value={requirementForm.ambiguities}
                />
              </label>

              <label className={styles.field}>
                <span className={styles.fieldLabel}>保真差异（fidelity_diff）</span>
                <Textarea
                  maxLength={12000}
                  onChange={(event) => setRequirementForm((state) => ({ ...state, fidelityDiff: event.target.value }))}
                  placeholder="可留空"
                  rows={4}
                  value={requirementForm.fidelityDiff}
                />
              </label>
            </div>

          </div>
        ) : (
          <div className={styles.previewGrid}>
            <div className={styles.previewBlock}>
              <div className={styles.previewTitle}>即将创建以下产物</div>
              <div className={styles.previewList}>
                {requirementPreviewItems.map((item) => (
                  <div className={styles.previewItem} key={item}>
                    <span className={styles.previewTick}>✓</span>
                    <span>{item}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className={styles.previewBlock}>
              <div className={styles.previewTitle}>需求信息</div>
              {/* 第二步只做前端回显，不额外请求接口。 */}
              <div className={styles.previewMeta}>
                <span className={styles.previewMetaLabel}>需求</span>
                <span>{requirementForm.title.trim()}</span>
              </div>
              <div className={styles.previewMeta}>
                <span className={styles.previewMetaLabel}>描述</span>
                <span className={styles.previewDescription}>{requirementForm.description.trim()}</span>
              </div>
              <div className={styles.previewMeta}>
                <span className={styles.previewMetaLabel}>用户原话</span>
                <span className={styles.previewDescription}>
                  {requirementForm.verbatimSource.length > 0
                    ? requirementForm.verbatimSource
                    : requirementForm.description.trim()}
                </span>
              </div>
            </div>
          </div>
        )}
      </Modal>

      <AiCliSettingsModal />
      <CommandPalette commands={commandPaletteItems} />
      <HotkeysHelp />

      <ToastViewport reservedBottomPx={selectedProjectId ? 60 : 0} />
      <MainTerminalLauncher />
      <SlotRequirementsFab />
    </AppShell>
  );
}

function getPageTitle(pathname: string): string {
  if (pathname.startsWith("/documents")) {
    return "文档中心";
  }
  if (pathname.startsWith("/tasks")) {
    return "任务看板";
  }
  if (pathname.startsWith("/requirements")) {
    return "需求管理";
  }
  if (pathname.startsWith("/runs")) {
    return "运行记录";
  }
  if (pathname.startsWith("/reconcile")) {
    return "Reconcile";
  }
  if (pathname.startsWith("/anchors")) {
    return "Slot 拓扑";
  }
  if (pathname.startsWith("/ai-cli/recordings")) {
    return "会话回放";
  }
  if (pathname.startsWith("/ai-cli")) {
    return "AI CLI";
  }
  if (pathname.startsWith("/settings")) {
    return "项目设置";
  }
  return "项目概览";
}

function getHeaderActions(input: {
  pathname: string;
  hasProject: boolean;
  onScan: () => Promise<void>;
  onCreateRequirement: () => void;
}) {
  if (!input.hasProject) {
    return null;
  }

  if (input.pathname.startsWith("/requirements")) {
    return <Button onClick={input.onCreateRequirement}>新建需求</Button>;
  }

  if (input.pathname.startsWith("/overview") || input.pathname.startsWith("/documents")) {
    return <Button onClick={() => void input.onScan()}>扫描文档</Button>;
  }

  return null;
}

export default function App() {
  const router = useMemo(
    () =>
      createBrowserRouter([
        {
          path: "/",
          element: <ConsoleLayout />,
          children: [
            {
              index: true,
              element: <Navigate replace to="/overview" />
            },
            {
              path: "overview",
              element: <OverviewPage />
            },
            {
              path: "documents",
              element: <DocumentsPage />
            },
            {
              path: "documents/:documentId",
              element: <DocumentsPage />
            },
            {
              path: "my-work",
              element: <MyWorkPage />
            },
            {
              path: "tasks",
              element: <TasksPage />
            },
            {
              path: "tasks/:taskId",
              element: <TasksPage />
            },
            {
              path: "requirements/:requirementId/breakdown-review",
              element: <BreakdownReviewPage />
            },
            {
              path: "requirements",
              element: <RequirementsPage />
            },
            {
              path: "requirements/:requirementId",
              element: <RequirementDetailPage />
            },
            {
              path: "sprints",
              element: <SprintsPage />
            },
            {
              path: "sprints/:sprintId",
              element: <SprintsPage />
            },
            {
              path: "runs",
              element: <RunsPage />
            },
            {
              path: "reconcile",
              element: <ReconcileReportsPage />
            },
            {
              path: "settings",
              element: <SettingsPage />
            },
            {
              path: "anchors",
              element: <SlotsPage />
            },
            {
              path: "ai-cli",
              element: <AiCliPage />
            },
            {
              path: "ai-cli/recordings/:recordingId",
              element: <RecordingPlayPage />
            }
          ]
        }
      ]),
    []
  );

  return <RouterProvider router={router} />;
}
