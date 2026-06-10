import { useEffect, useMemo, useState } from "react";
import { NavLink } from "react-router";

import { fetchVersion, type SuOrielVersion } from "../../lib/console-api.js";
import { getTaskAttentionSummary } from "../../lib/node-board-config.js";
import { projectPath } from "../../lib/project-paths.js";
import { useProjectOnboardingGate } from "../../lib/use-project-onboarding-gate.js";
import { useProjectStore } from "../../stores/project-store.js";
import type { ProjectView } from "../../types/project.js";
import { useUIStore } from "../../stores/ui-store.js";
import { AiCliPanel } from "../ai-cli/AiCliPanel.js";
import { Badge } from "../ui/Badge.js";
import { Button } from "../ui/Button.js";
import styles from "./Sidebar.module.css";

interface SidebarProps {
  loading: boolean;
  projects: ProjectView[];
  selectedProjectId: string | null;
  onSelectProject: (projectId: string) => void;
  onCreateProject: () => void;
}

interface NavItem {
  to: string;
  label: string;
  icon: string;
  // 临时隐藏入口（路由仍保留可直达），后续放开时删除此标记即可
  hidden?: boolean;
}

interface NavSection {
  label: string;
  items: NavItem[];
  // 该组业务页需项目初始化(ccb runtime + 知识库)就绪后才可进入;未就绪时锁定并弹引导。
  gated?: boolean;
}

const navSections: NavSection[] = [
  {
    label: "工作",
    items: [
      { to: "/overview", label: "概览", icon: "◎" },
      { to: "/my-work", label: "我的工作", icon: "👤" }
    ]
  },
  {
    label: "项目",
    gated: true,
    items: [
      { to: "/requirements", label: "需求管理", icon: "◇" },
      { to: "/tasks", label: "任务看板", icon: "☰", hidden: true },
      { to: "/documents", label: "文档中心", icon: "◫" },
      { to: "/reconcile", label: "Reconcile", icon: "↻", hidden: true },
      { to: "/anchors", label: "Slot 拓扑", icon: "✦" },
      { to: "/runs", label: "运行记录", icon: "↻" }
    ]
  },
  {
    label: "工具",
    items: [
      { to: "/settings", label: "项目设置", icon: "⚙" },
      { to: "/ai-cli", label: "AI CLI", icon: "▶" }
    ]
  }
];

export function Sidebar(props: SidebarProps) {
  const sidebarCollapsed = useUIStore((state) => state.sidebarCollapsed);
  const toggleSidebar = useUIStore((state) => state.toggleSidebar);
  const tasks = useProjectStore((state) => state.tasks);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [keyword, setKeyword] = useState("");
  const [versionInfo, setVersionInfo] = useState<SuOrielVersion | null>(null);
  const selectedProject = props.projects.find((project) => project.id === props.selectedProjectId) ?? null;
  const taskAttention = useMemo(() => getTaskAttentionSummary(tasks), [tasks]);
  // 项目接入门控:未就绪时锁定"项目"组导航项,点击弹引导而非跳转。
  const onboardingGate = useProjectOnboardingGate(props.selectedProjectId);
  const displayVersion = versionInfo
    ? `su-oriel v${versionInfo.version} · ${versionInfo.gitSha || "unknown"}`
    : "su-oriel v0.1.0 · unknown";

  useEffect(() => {
    let active = true;
    void fetchVersion()
      .then((nextVersion) => {
        if (active) {
          setVersionInfo(nextVersion);
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  const filteredProjects = useMemo(() => {
    const normalized = keyword.trim().toLowerCase();
    if (!normalized) {
      return props.projects;
    }

    return props.projects.filter((project) => {
      return project.name.toLowerCase().includes(normalized) || project.localPath.toLowerCase().includes(normalized);
    });
  }, [keyword, props.projects]);

  return (
    <div className={styles.sidebar}>
      <div className={styles.brandRow}>
        <div className={styles.brandMark}>⬡</div>
        {!sidebarCollapsed ? <div className={styles.brandText}>CCB Console</div> : null}
        <button className={styles.collapseButton} onClick={toggleSidebar} type="button">
          {sidebarCollapsed ? "»" : "«"}
        </button>
      </div>

      <div className={styles.projectArea}>
        <button className={styles.projectTrigger} onClick={() => setPickerOpen((value) => !value)} type="button">
          <div className={styles.projectMain}>
            <span className={styles.projectName}>{selectedProject?.name ?? "未选择项目"}</span>
            {!sidebarCollapsed ? (
              <span className={styles.projectPath}>{selectedProject?.localPath ?? "请选择项目"}</span>
            ) : null}
          </div>
          {!sidebarCollapsed ? <span className={styles.projectArrow}>▾</span> : null}
        </button>

        {pickerOpen && !sidebarCollapsed ? (
          <div className={styles.projectPopover}>
            <input
              className={styles.projectSearch}
              onChange={(event) => setKeyword(event.target.value)}
              placeholder="搜索项目..."
              value={keyword}
            />
            <div className={styles.projectList}>
              {props.loading ? <div className={styles.emptyHint}>正在加载项目...</div> : null}
              {!props.loading && filteredProjects.length === 0 ? <div className={styles.emptyHint}>没有匹配项目</div> : null}
              {filteredProjects.map((project) => (
                <button
                  className={styles.projectItem}
                  data-selected={String(project.id === props.selectedProjectId)}
                  key={project.id}
                  onClick={() => {
                    props.onSelectProject(project.id);
                    setPickerOpen(false);
                  }}
                  type="button"
                >
                  <span className={styles.projectItemTitle}>{project.name}</span>
                  <span className={styles.projectItemPath}>{project.localPath}</span>
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>

      <nav className={styles.nav}>
        {navSections.map((section) => {
          const visibleItems = section.items.filter((item) => !item.hidden);
          if (visibleItems.length === 0) {
            return null;
          }
          return (
          <div className={styles.navSection} key={section.label}>
            {!sidebarCollapsed ? (
              <div className={styles.navSectionLabel}>{section.label}</div>
            ) : (
              <div aria-hidden="true" className={styles.navSectionDivider} />
            )}
            {visibleItems.map((item) => {
              // 门控组未就绪:渲染锁定 button(非 disabled、可聚焦、点击弹引导、不导航、不模拟 active)。
              const locked = section.gated === true && props.selectedProjectId !== null && !onboardingGate.ready;
              if (locked) {
                return (
                  <button
                    aria-disabled="true"
                    className={styles.navItem}
                    key={item.to}
                    onClick={() => onboardingGate.requireInit()}
                    style={{ opacity: 0.55, cursor: "pointer" }}
                    title={onboardingGate.loading ? "正在检测项目接入状态…" : "需先完成项目初始化(CCB 运行时 + 知识库)"}
                    type="button"
                  >
                    <span aria-hidden="true" className={styles.navIcon}>
                      {onboardingGate.loading ? "…" : "🔒"}
                    </span>
                    {!sidebarCollapsed ? <span className={styles.navLabel}>{item.label}</span> : null}
                  </button>
                );
              }
              const showTaskBadge = item.to === "/tasks" && taskAttention.total > 0;
              const to = props.selectedProjectId ? projectPath(props.selectedProjectId, item.to) : "/";
              return (
                <NavLink
                  className={({ isActive }) => `${styles.navItem} ${isActive ? styles.navItemActive : ""}`}
                  key={item.to}
                  to={to}
                >
                  <span className={styles.navIcon}>{item.icon}</span>
                  {!sidebarCollapsed ? (
                    <>
                      <span className={styles.navLabel}>{item.label}</span>
                      {showTaskBadge ? (
                        <span className={styles.navBadges}>
                          <span aria-label={`任务总数 ${taskAttention.total}`}>
                            <Badge color="gray" label={String(taskAttention.total)} />
                          </span>
                          {taskAttention.attention > 0 ? (
                            <span aria-label={`关注任务 ${taskAttention.attention}`}>
                              <Badge color="red" label={`●${taskAttention.attention}`} />
                            </span>
                          ) : null}
                        </span>
                      ) : null}
                    </>
                  ) : null}
                </NavLink>
              );
            })}
          </div>
          );
        })}
      </nav>

      <div className={styles.spacer} />

      <AiCliPanel collapsed={sidebarCollapsed} />

      <div className={styles.footer}>
        <div className={styles.versionStamp} title={versionInfo?.buildDate ? `built ${versionInfo.buildDate}` : displayVersion}>
          {sidebarCollapsed ? `v${versionInfo?.version ?? "0.1.0"}` : displayVersion}
        </div>
        <Button onClick={props.onCreateProject} size="sm" variant="ghost">
          {sidebarCollapsed ? "＋" : "新建项目"}
        </Button>
      </div>
    </div>
  );
}
