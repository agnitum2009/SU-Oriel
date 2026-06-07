import { useEffect, useMemo } from "react";
import { useNavigate } from "react-router";

import { Button } from "../../components/ui/Button.js";
import { EmbeddedTerminal } from "../../components/ai-cli/EmbeddedTerminal.js";
import { AiCliApiError, useAiCliStore } from "../../stores/ai-cli-store.js";
import { useProjectPathBuilder } from "../../lib/project-paths.js";
import type { EmbeddedLayout } from "../../stores/ai-cli-store.js";
import { useProjectStore } from "../../stores/project-store.js";
import { useUIStore } from "../../stores/ui-store.js";
import type {
  AiCliLaunchMode,
  AiCliToolId,
  PtySessionDescriptorView,
  RecordingMetaView
} from "../../types/ai-cli.js";
import styles from "./AiCliPage.module.css";

const LAYOUT_OPTIONS: Array<{ value: EmbeddedLayout; label: string }> = [
  { value: "tabs", label: "单窗口（Tabs）" },
  { value: "cols-2", label: "双列网格" },
  { value: "cols-3", label: "三列网格" }
];

const TOOL_LABEL: Record<AiCliToolId, string> = {
  claude: "Claude Code",
  codex: "Codex CLI",
  gemini: "Gemini CLI"
};

function formatBytes(value: number): string {
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  return `${(value / 1024 / 1024).toFixed(2)} MB`;
}

function formatTime(value: string): string {
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

function sessionTitle(session: PtySessionDescriptorView): string {
  return `${session.toolId} · ${session.cwd.split(/[\\/]/).pop() ?? session.cwd}`;
}

export function AiCliPage() {
  const navigate = useNavigate();
  const toProjectPath = useProjectPathBuilder();
  const projects = useProjectStore((state) => state.projects);
  const selectedProjectId = useProjectStore((state) => state.selectedProjectId);
  const tools = useAiCliStore((state) => state.tools);
  const mode = useAiCliStore((state) => state.mode);
  const setMode = useAiCliStore((state) => state.setMode);
  const layout = useAiCliStore((state) => state.layout);
  const setLayout = useAiCliStore((state) => state.setLayout);
  const launchingToolId = useAiCliStore((state) => state.launchingToolId);
  const loadTools = useAiCliStore((state) => state.loadTools);
  const launchExternal = useAiCliStore((state) => state.launchExternal);
  const sessions = useAiCliStore((state) => state.sessions);
  const activeSessionId = useAiCliStore((state) => state.activeSessionId);
  const setActiveSession = useAiCliStore((state) => state.setActiveSession);
  const createSession = useAiCliStore((state) => state.createSession);
  const closeSession = useAiCliStore((state) => state.closeSession);
  const loadSessions = useAiCliStore((state) => state.loadSessions);
  const recordings = useAiCliStore((state) => state.recordings);
  const loadRecordings = useAiCliStore((state) => state.loadRecordings);
  const removeRecording = useAiCliStore((state) => state.removeRecording);
  const openModal = useUIStore((state) => state.openModal);
  const addToast = useUIStore((state) => state.addToast);

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId) ?? null,
    [projects, selectedProjectId]
  );

  useEffect(() => {
    void loadTools(selectedProjectId);
    void loadSessions();
    void loadRecordings();
  }, [loadTools, loadSessions, loadRecordings, selectedProjectId]);

  const liveSessions = sessions.filter((session) => session.status !== "exited");

  const handleLaunchExternal = async (toolId: AiCliToolId, available: boolean, command: string, installHint: string) => {
    if (!available) {
      addToast("error", `未检测到 ${command}，请先安装或在设置中指定可执行路径。安装文档：${installHint}`);
      return;
    }
    try {
      const result = await launchExternal(toolId, selectedProjectId);
      addToast("success", `已在 ${result.terminalKind} 启动（cwd: ${result.cwd}）`);
    } catch (error) {
      if (error instanceof AiCliApiError) {
        addToast("error", error.message);
        return;
      }
      addToast("error", error instanceof Error ? error.message : "启动 AI CLI 失败");
    }
  };

  const handleCreateEmbedded = async (toolId: AiCliToolId, available: boolean, command: string, installHint: string) => {
    if (!available) {
      addToast("error", `未检测到 ${command}，请先安装或在设置中指定可执行路径。安装文档：${installHint}`);
      return;
    }
    try {
      await createSession({ toolId, projectId: selectedProjectId });
      addToast("success", `已创建嵌入式会话`);
    } catch (error) {
      if (error instanceof AiCliApiError) {
        addToast("error", error.message);
        return;
      }
      addToast("error", error instanceof Error ? error.message : "创建嵌入式会话失败");
    }
  };

  const handleCloseSession = async (sessionId: string) => {
    await closeSession(sessionId);
    void loadRecordings();
  };

  const handleDeleteRecording = async (id: string) => {
    try {
      await removeRecording(id);
      addToast("success", "已删除录像");
    } catch (error) {
      addToast("error", error instanceof Error ? error.message : "删除录像失败");
    }
  };

  return (
    <div className={styles.page}>
      <div className={styles.banner}>
        <svg
          aria-hidden
          className={styles.bannerIcon}
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.5"
          viewBox="0 0 16 16"
        >
          <rect height="10" rx="1.5" width="13" x="1.5" y="3" />
          <path d="M4.5 7l1.5 1.5L4.5 10" />
          <path d="M8 10h4" />
        </svg>
        <div className={styles.bannerBody}>
          <div className={styles.bannerTitle}>探索 / 临时终端</div>
          <div className={styles.bannerSubtitle}>
            本入口不参与需求与任务执行。<strong>任务工作流</strong>请通过任务详情页 slot 控制条或 Slots 页操作。
          </div>
        </div>
      </div>
      <div className={styles.header}>
        <div>
          <div className={styles.headerTitle}>AI CLI</div>
          <div className={styles.headerMeta}>
            cwd: {selectedProject?.localPath ?? "未选项目，将使用 server 当前目录"}
          </div>
        </div>
        <div className={styles.headerActions}>
          {(["external", "embedded"] as AiCliLaunchMode[]).map((value) => (
            <Button
              key={value}
              onClick={() => setMode(value)}
              size="sm"
              variant={mode === value ? "primary" : "secondary"}
            >
              {value === "external" ? "外部窗口" : "页内嵌入"}
            </Button>
          ))}
          <Button onClick={() => openModal("ai-cli-settings")} size="sm" variant="ghost">
            设置
          </Button>
        </div>
      </div>

      {mode === "external" ? (
        <div className={styles.toolGrid}>
          {tools.map((tool) => (
            <div className={styles.toolCard} key={tool.id}>
              <div className={styles.toolHead}>
                <div className={styles.toolName}>{tool.name}</div>
                <div className={styles.toolBadge} data-available={String(tool.available)}>
                  {tool.available ? "已检测" : "未检测"}
                </div>
              </div>
              <div className={styles.toolMeta}>命令：{tool.command}</div>
              <div className={styles.toolMeta}>
                路径：{tool.resolvedPath ?? "未在 PATH 中找到，可在设置中指定绝对路径"}
              </div>
              {tool.args.length > 0 ? (
                <div className={styles.toolMeta}>启动参数：{tool.args.join(" ")}</div>
              ) : null}
              <div className={styles.toolActions}>
                <Button
                  disabled={launchingToolId === tool.id}
                  loading={launchingToolId === tool.id}
                  onClick={() => void handleLaunchExternal(tool.id, tool.available, tool.command, tool.installHint)}
                  size="sm"
                >
                  在外部窗口启动
                </Button>
                <Button onClick={() => openModal("ai-cli-settings")} size="sm" variant="secondary">
                  配置
                </Button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className={styles.embeddedLayout}>
          <div className={styles.toolColumn}>
            <div className={styles.toolColumnTitle}>启动嵌入式会话</div>
            {tools.map((tool) => (
              <button
                className={styles.toolColumnButton}
                disabled={!tool.available}
                key={tool.id}
                onClick={() => void handleCreateEmbedded(tool.id, tool.available, tool.command, tool.installHint)}
                type="button"
              >
                <span className={styles.toolColumnLabel}>{tool.name}</span>
                <span className={styles.toolColumnHint}>
                  {tool.available ? "在新 tab 中打开" : `未检测到 ${tool.command}`}
                </span>
              </button>
            ))}
          </div>

          <div className={styles.terminalArea}>
            <div className={styles.tabsRow}>
              {liveSessions.length === 0 ? (
                <div className={styles.tabPlaceholder}>暂无嵌入式会话，左侧选择一个工具开始</div>
              ) : null}
              {layout === "tabs"
                ? liveSessions.map((session) => (
                    <button
                      className={styles.tab}
                      data-active={String(session.id === activeSessionId)}
                      key={session.id}
                      onClick={() => setActiveSession(session.id)}
                      type="button"
                    >
                      <span>{sessionTitle(session)}</span>
                      <span
                        className={styles.tabClose}
                        onClick={(event) => {
                          event.stopPropagation();
                          void handleCloseSession(session.id);
                        }}
                      >
                        ×
                      </span>
                    </button>
                  ))
                : (
                    <div className={styles.tabPlaceholder}>
                      {liveSessions.length} 个会话同时在网格内运行
                    </div>
                  )}
              <div style={{ flex: 1 }} />
              <div className={styles.layoutSwitcher}>
                {LAYOUT_OPTIONS.map((option) => (
                  <button
                    className={styles.layoutItem}
                    data-active={String(layout === option.value)}
                    key={option.value}
                    onClick={() => setLayout(option.value)}
                    type="button"
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
            <div className={styles.terminalHost}>
              {liveSessions.length === 0 ? (
                <div className={styles.terminalEmpty}>
                  <div>当前没有进行中的会话</div>
                  <div className={styles.toolColumnHint}>会话退出后将自动写入下方录像</div>
                </div>
              ) : layout === "tabs" ? (
                liveSessions.map((session) => (
                  <div
                    className={styles.terminalPanel}
                    data-active={String(session.id === activeSessionId)}
                    key={session.id}
                  >
                    <EmbeddedTerminal
                      active={session.id === activeSessionId}
                      onClose={() => void handleCloseSession(session.id)}
                      onError={(code, message) => addToast("error", `[${code}] ${message}`)}
                      onExit={() => void loadRecordings()}
                      sessionId={session.id}
                      title={sessionTitle(session)}
                    />
                  </div>
                ))
              ) : (
                <div
                  className={styles.terminalGrid}
                  data-cols={layout === "cols-3" ? "3" : "2"}
                  data-count={String(liveSessions.length)}
                >
                  {liveSessions.map((session) => (
                    <div
                      className={styles.gridCell}
                      data-active={String(session.id === activeSessionId)}
                      key={session.id}
                      onClick={() => setActiveSession(session.id)}
                    >
                      <EmbeddedTerminal
                        active
                        onClose={() => void handleCloseSession(session.id)}
                        onError={(code, message) => addToast("error", `[${code}] ${message}`)}
                        onExit={() => void loadRecordings()}
                        sessionId={session.id}
                        title={sessionTitle(session)}
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      <section className={styles.recordingsSection}>
        <div className={styles.recordingsTitle}>会话录像</div>
        {recordings.length === 0 ? (
          <div className={styles.recordingEmpty}>嵌入式会话退出后会自动生成 asciinema 录像，可在此回放。</div>
        ) : (
          <div className={styles.recordingsList}>
            {recordings.map((recording) => (
              <RecordingRow
                key={recording.id}
                onDelete={() => void handleDeleteRecording(recording.id)}
                onPlay={() => navigate(toProjectPath(`/ai-cli/recordings/${recording.id}`))}
                recording={recording}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

interface RecordingRowProps {
  recording: RecordingMetaView;
  onPlay: () => void;
  onDelete: () => void;
}

function RecordingRow(props: RecordingRowProps) {
  const { recording } = props;
  return (
    <div className={styles.recordingRow}>
      <div className={styles.recordingMain}>
        <div className={styles.recordingTitle}>{TOOL_LABEL[recording.toolId] ?? recording.toolId}</div>
        <div className={styles.recordingMeta}>
          {formatTime(recording.createdAt)} · cwd: {recording.cwd}
        </div>
      </div>
      <div className={styles.recordingMeta}>{formatBytes(recording.byteSize)}</div>
      <Button onClick={props.onPlay} size="sm" variant="secondary">
        回放
      </Button>
      <Button onClick={props.onDelete} size="sm" variant="ghost">
        删除
      </Button>
    </div>
  );
}
