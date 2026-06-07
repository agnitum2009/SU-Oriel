import { useEffect, useMemo } from "react";
import { useNavigate } from "react-router";

import { AiCliApiError, useAiCliStore } from "../../stores/ai-cli-store.js";
import { useProjectPathBuilder } from "../../lib/project-paths.js";
import { useProjectStore } from "../../stores/project-store.js";
import { useUIStore } from "../../stores/ui-store.js";
import type { AiCliLaunchMode, AiCliToolView } from "../../types/ai-cli.js";
import styles from "./AiCliPanel.module.css";

interface AiCliPanelProps {
  collapsed: boolean;
}

const TOOL_BADGE: Record<string, string> = {
  claude: "C",
  codex: "X",
  gemini: "G"
};

export function AiCliPanel(props: AiCliPanelProps) {
  const navigate = useNavigate();
  const toProjectPath = useProjectPathBuilder();
  const projects = useProjectStore((state) => state.projects);
  const selectedProjectId = useProjectStore((state) => state.selectedProjectId);
  const tools = useAiCliStore((state) => state.tools);
  const mode = useAiCliStore((state) => state.mode);
  const setMode = useAiCliStore((state) => state.setMode);
  const launchingToolId = useAiCliStore((state) => state.launchingToolId);
  const loadTools = useAiCliStore((state) => state.loadTools);
  const launchExternal = useAiCliStore((state) => state.launchExternal);
  const openModal = useUIStore((state) => state.openModal);
  const addToast = useUIStore((state) => state.addToast);

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId) ?? null,
    [projects, selectedProjectId]
  );
  const cwdHint = selectedProject?.localPath ?? null;

  useEffect(() => {
    void loadTools(selectedProjectId);
  }, [loadTools, selectedProjectId]);

  const createSession = useAiCliStore((state) => state.createSession);

  const handleClickTool = async (tool: AiCliToolView) => {
    if (!tool.available) {
      addToast(
        "error",
        `未检测到 ${tool.command}，请先安装或在设置中指定可执行路径。安装文档：${tool.installHint}`
      );
      return;
    }

    if (mode === "embedded") {
      try {
        const result = await createSession({ toolId: tool.id, projectId: selectedProjectId });
        navigate(toProjectPath("/ai-cli"));
        addToast("success", `已创建嵌入式会话（${result.descriptor.cwd}）`);
      } catch (error) {
        if (error instanceof AiCliApiError) {
          addToast("error", error.message);
          return;
        }
        addToast("error", error instanceof Error ? error.message : "创建嵌入式会话失败");
      }
      return;
    }

    try {
      const result = await launchExternal(tool.id, selectedProjectId);
      addToast("success", `已在 ${result.terminalKind} 启动 ${tool.name}（cwd: ${result.cwd}）`);
    } catch (error) {
      if (error instanceof AiCliApiError) {
        addToast("error", error.message);
        return;
      }
      addToast("error", error instanceof Error ? error.message : "启动 AI CLI 失败");
    }
  };

  if (props.collapsed) {
    return (
      <div className={styles.collapsed}>
        {tools.map((tool) => (
          <button
            className={styles.collapsedTool}
            disabled={launchingToolId === tool.id}
            key={tool.id}
            onClick={() => void handleClickTool(tool)}
            title={tool.available ? `${tool.name} (${mode})` : `${tool.name}：未检测到 ${tool.command}`}
            type="button"
          >
            {TOOL_BADGE[tool.id] ?? tool.id.charAt(0).toUpperCase()}
          </button>
        ))}
      </div>
    );
  }

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <span>AI CLI</span>
        <div className={styles.headerActions}>
          <button
            className={styles.iconButton}
            onClick={() => openModal("ai-cli-settings")}
            title="AI CLI 设置"
            type="button"
          >
            ⚙
          </button>
          <button
            className={styles.iconButton}
            onClick={() => navigate(toProjectPath("/ai-cli"))}
            title="打开 AI CLI 全屏页"
            type="button"
          >
            ↗
          </button>
        </div>
      </div>

      <div className={styles.modeRow}>
        {(["external", "embedded"] as AiCliLaunchMode[]).map((value) => (
          <button
            className={styles.modeItem}
            data-active={String(mode === value)}
            key={value}
            onClick={() => setMode(value)}
            type="button"
          >
            {value === "external" ? "外部窗口" : "页内嵌入"}
          </button>
        ))}
      </div>

      <div className={styles.tools}>
        {tools.length === 0 ? (
          <div className={styles.toolStatus}>正在加载工具列表...</div>
        ) : null}
        {tools.map((tool) => (
          <button
            className={styles.toolButton}
            disabled={launchingToolId === tool.id}
            key={tool.id}
            onClick={() => void handleClickTool(tool)}
            type="button"
          >
            <span className={styles.toolBadge}>{TOOL_BADGE[tool.id] ?? "?"}</span>
            <span className={styles.toolName}>{tool.name}</span>
            <span className={tool.available ? styles.toolStatus : `${styles.toolStatus} ${styles.toolUnavailable}`}>
              {launchingToolId === tool.id ? "启动中..." : tool.available ? "就绪" : "未安装"}
            </span>
          </button>
        ))}
      </div>

      <div className={cwdHint ? styles.cwdHint : `${styles.cwdHint} ${styles.cwdEmpty}`}>
        {cwdHint ? `cwd: ${cwdHint}` : "未选项目，将使用 server 当前目录"}
      </div>
    </div>
  );
}
