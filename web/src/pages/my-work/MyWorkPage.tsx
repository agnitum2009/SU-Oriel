/**
 * Phase A3: My Work 页面 (/my-work)
 *
 * 个人维度入口，三段：
 *   - 需要我处理的：reviewStatus=needs_followup OR runtimeState=blocked OR pending review intent
 *   - 我关注的：localStorage starred set
 *   - 最近活跃：updatedAt 最近 7 天
 */

import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";

import styles from "./MyWorkPage.module.css";
import { EmptyState } from "../../components/ui/EmptyState.js";
import { isTaskArchived, isTaskAttentionNeeded } from "../../lib/node-board-config.js";
import { useProjectPathBuilder } from "../../lib/project-paths.js";
import { Badge } from "../../components/ui/Badge.js";
import { getNodeBadge } from "../../lib/ui-mapping.js";
import { useProjectStore } from "../../stores/project-store.js";
import type { TaskView } from "../../types/task.js";

const STARRED_KEY = "ccb-console:starred-tasks";
const ACTIVE_DAYS = 7;

function loadStarred(): Set<string> {
  try {
    const raw = localStorage.getItem(STARRED_KEY);
    if (!raw) return new Set();
    return new Set(JSON.parse(raw) as string[]);
  } catch {
    return new Set();
  }
}

function saveStarred(set: Set<string>) {
  try {
    localStorage.setItem(STARRED_KEY, JSON.stringify([...set]));
  } catch {
    // ignore
  }
}

function relativeTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "?";
  const diff = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (diff < 60) return "刚刚";
  if (diff < 3600) return `${Math.floor(diff / 60)}m 前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h 前`;
  return `${Math.floor(diff / 86400)}d 前`;
}

interface TaskRowProps {
  task: TaskView;
  starred: boolean;
  onTaskSelect: (id: string) => void;
  onToggleStar: (id: string) => void;
}

function TaskRow({ task, starred, onTaskSelect, onToggleStar }: TaskRowProps) {
  const nodeBadge = getNodeBadge(task.currentNode, task.nodeSubstate);
  return (
    <li className={styles.row}>
      <button
        aria-label={starred ? "取消关注" : "关注"}
        className={styles.starBtn}
        data-active={starred}
        onClick={(e) => {
          e.stopPropagation();
          onToggleStar(task.id);
        }}
        type="button"
      >
        {starred ? "★" : "☆"}
      </button>
      <button
        aria-label={`打开 ${task.title}`}
        className={styles.rowMain}
        onClick={() => onTaskSelect(task.id)}
        type="button"
      >
        <div className={styles.rowTitleLine}>
          <span className={styles.rowTitle}>{task.title}</span>
          <Badge color="gray" label="子任务" />
        </div>
        <div className={styles.rowMeta}>
          {nodeBadge ? <Badge color={nodeBadge.color} label={nodeBadge.label} /> : null}
          <span className={styles.rowKey}>{task.taskKey}</span>
          <span className={styles.rowProgress}>{task.progress}%</span>
          <span className={styles.rowTime}>更新于 {relativeTime(task.updatedAt)}</span>
        </div>
      </button>
    </li>
  );
}

export function MyWorkPage() {
  const navigate = useNavigate();
  const toProjectPath = useProjectPathBuilder();
  const tasks = useProjectStore((state) => state.tasks);
  const loadingData = useProjectStore((state) => state.loadingData);
  const [starred, setStarred] = useState<Set<string>>(() => loadStarred());

  useEffect(() => {
    saveStarred(starred);
  }, [starred]);

  const toggleStar = (id: string) => {
    setStarred((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const { needsAttention, starredTasks, recentlyActive } = useMemo(() => {
    const activeTasks = tasks.filter((t) => !isTaskArchived(t));
    const needs = activeTasks.filter((t) => isTaskAttentionNeeded(t));
    const star = tasks.filter((t) => starred.has(t.id));
    const cutoff = Date.now() - ACTIVE_DAYS * 24 * 3600 * 1000;
    const recent = activeTasks
      .filter((t) => new Date(t.updatedAt).getTime() >= cutoff)
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      .slice(0, 20);
    return { needsAttention: needs, starredTasks: star, recentlyActive: recent };
  }, [tasks, starred]);

  if (loadingData && tasks.length === 0) {
    return (
      <main className={styles.page}>
        <p className={styles.loading}>加载中…</p>
      </main>
    );
  }

  return (
    <main aria-label="我的工作" className={styles.page} data-testid="my-work-page">
      <header className={styles.header}>
        <h1 className={styles.title}>👤 我的工作</h1>
        <p className={styles.subtitle}>个人维度入口 · 关注 / 待处理 / 最近活跃</p>
      </header>

      <section aria-label="需要我处理的" className={styles.section}>
        <h2 className={styles.sectionTitle}>
          🔔 需要处理 <span className={styles.sectionCount}>({needsAttention.length})</span>
        </h2>
        {needsAttention.length === 0 ? (
          <EmptyState description="目前没有需要立即处理的任务。" icon="✅" title="一切顺利" />
        ) : (
          <ul className={styles.list}>
            {needsAttention.map((task) => (
              <TaskRow
                key={task.id}
                onTaskSelect={(id) => navigate(toProjectPath(`/tasks/${id}`))}
                onToggleStar={toggleStar}
                starred={starred.has(task.id)}
                task={task}
              />
            ))}
          </ul>
        )}
      </section>

      <section aria-label="我关注的" className={styles.section}>
        <h2 className={styles.sectionTitle}>
          ⭐ 我关注的 <span className={styles.sectionCount}>({starredTasks.length})</span>
        </h2>
        {starredTasks.length === 0 ? (
          <p className={styles.placeholder}>点任意任务旁的 ☆ 即可加关注，方便后续追踪。</p>
        ) : (
          <ul className={styles.list}>
            {starredTasks.map((task) => (
              <TaskRow
                key={task.id}
                onTaskSelect={(id) => navigate(toProjectPath(`/tasks/${id}`))}
                onToggleStar={toggleStar}
                starred={true}
                task={task}
              />
            ))}
          </ul>
        )}
      </section>

      <section aria-label="最近活跃" className={styles.section}>
        <h2 className={styles.sectionTitle}>
          📈 最近 7 天活跃 <span className={styles.sectionCount}>({recentlyActive.length})</span>
        </h2>
        {recentlyActive.length === 0 ? (
          <p className={styles.placeholder}>最近 7 天没有任务更新。</p>
        ) : (
          <ul className={styles.list}>
            {recentlyActive.map((task) => (
              <TaskRow
                key={task.id}
                onTaskSelect={(id) => navigate(toProjectPath(`/tasks/${id}`))}
                onToggleStar={toggleStar}
                starred={starred.has(task.id)}
                task={task}
              />
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
