import type { ReactNode } from "react";
import { Link } from "react-router";

import { useProjectPathBuilder } from "../../lib/project-paths.js";
import styles from "./AppShell.module.css";

interface AppShellProps {
  sidebarCollapsed: boolean;
  sidebar: ReactNode;
  header: ReactNode;
  progress?: ReactNode;
  projectStrip?: ReactNode;
  children: ReactNode;
}

const primaryNavContract = ["项目", "任务", "文档", "需求", "设置"];

export function AppShell(props: AppShellProps) {
  const toProjectPath = useProjectPathBuilder();
  return (
    <div
      className={styles.appShell}
      data-aside-visible="false"
      data-sidebar-collapsed={String(props.sidebarCollapsed)}
    >
      <aside
        aria-label={`主导航：${primaryNavContract.join(" / ")}`}
        className={styles.sidebar}
        data-layout-region="sidebar"
      >
        {props.sidebar}
      </aside>
      <div className={styles.workspace}>
        {props.projectStrip}
        <div aria-label="顶栏" className={styles.topbar} data-layout-region="topbar" role="banner">
          <div className={styles.headerSlot}>{props.header}</div>
          <div aria-label="顶栏工具" className={styles.topbarTools}>
            <input aria-label="全局搜索" className={styles.globalSearch} placeholder="全局搜索" readOnly />
            <button aria-label="最近活动" className={styles.topbarButton} disabled type="button">
              最近活动
            </button>
            <Link aria-label="设置入口" className={styles.topbarButton} to={toProjectPath("/settings")}>
              设置
            </Link>
          </div>
        </div>
        {props.progress}
        <div className={styles.contentFrame}>
          <main aria-label="页面主体" className={styles.pageContent} data-layout-region="main">
            {props.children}
          </main>
        </div>
      </div>
    </div>
  );
}
