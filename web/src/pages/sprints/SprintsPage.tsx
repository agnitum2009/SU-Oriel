/**
 * Phase C-C2: Sprints / 迭代列表页（路由 /sprints）+ 详情页（/sprints/:id）
 */

import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router";

import styles from "./SprintsPage.module.css";
import { BurndownChart } from "../../components/sprint/BurndownChart.js";
import { Badge } from "../../components/ui/Badge.js";
import { Button } from "../../components/ui/Button.js";
import { EmptyState } from "../../components/ui/EmptyState.js";
import {
  createSprint,
  fetchSprintBurndown,
  fetchSprintDetail,
  fetchSprints
} from "../../lib/console-api.js";
import { useProjectPathBuilder } from "../../lib/project-paths.js";
import { useProjectStore } from "../../stores/project-store.js";
import { useUIStore } from "../../stores/ui-store.js";
import type { BurndownView, SprintDetailView, SprintView } from "../../types/sprint.js";

const STATUS_LABEL: Record<string, string> = {
  planning: "规划中",
  active: "进行中",
  closed: "已完成",
  cancelled: "已取消"
};

const STATUS_COLOR: Record<string, "gray" | "blue" | "green" | "red"> = {
  planning: "gray",
  active: "blue",
  closed: "green",
  cancelled: "red"
};

export function SprintsPage() {
  const { sprintId } = useParams<{ sprintId?: string }>();
  return sprintId ? <SprintDetail sprintId={sprintId} /> : <SprintList />;
}

function SprintList() {
  const navigate = useNavigate();
  const toProjectPath = useProjectPathBuilder();
  const selectedProjectId = useProjectStore((state) => state.selectedProjectId);
  const addToast = useUIStore((state) => state.addToast);
  const [sprints, setSprints] = useState<SprintView[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [goal, setGoal] = useState("");

  useEffect(() => {
    if (!selectedProjectId) return;
    let cancelled = false;
    setLoading(true);
    fetchSprints(selectedProjectId)
      .then((items) => {
        if (!cancelled) setSprints(items);
      })
      .catch((err) => {
        if (!cancelled) addToast("error", err instanceof Error ? err.message : "加载迭代列表失败");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedProjectId, addToast]);

  const handleCreate = async () => {
    if (!selectedProjectId || !name.trim()) return;
    setCreating(true);
    try {
      const sprint = await createSprint(selectedProjectId, { name: name.trim(), goal: goal.trim() || undefined });
      setSprints((prev) => [sprint, ...prev]);
      setCreateOpen(false);
      setName("");
      setGoal("");
      addToast("success", `迭代「${sprint.name}」已创建`);
    } catch (err) {
      addToast("error", err instanceof Error ? err.message : "创建迭代失败");
    } finally {
      setCreating(false);
    }
  };

  if (!selectedProjectId) {
    return (
      <main className={styles.page}>
        <EmptyState description="先选择项目，迭代会按项目独立维护。" icon="🗓" title="还没有选中的项目" />
      </main>
    );
  }

  return (
    <main aria-label="迭代列表" className={styles.page} data-testid="sprints-page">
      <header className={styles.header}>
        <h1 className={styles.title}>🗓 迭代</h1>
        <Button onClick={() => setCreateOpen(true)} size="sm">新建迭代</Button>
      </header>

      {createOpen ? (
        <section className={styles.createForm}>
          <input
            aria-label="迭代名称"
            className={styles.input}
            onChange={(e) => setName(e.target.value)}
            placeholder="迭代名称（如：Sprint 2026-W19）"
            value={name}
          />
          <input
            aria-label="迭代目标"
            className={styles.input}
            onChange={(e) => setGoal(e.target.value)}
            placeholder="迭代目标（可选）"
            value={goal}
          />
          <div className={styles.createActions}>
            <Button disabled={creating} onClick={() => setCreateOpen(false)} size="sm" variant="secondary">取消</Button>
            <Button disabled={creating || !name.trim()} loading={creating} onClick={handleCreate} size="sm">创建</Button>
          </div>
        </section>
      ) : null}

      {loading ? (
        <p className={styles.placeholder}>加载中…</p>
      ) : sprints.length === 0 ? (
        <EmptyState description="点击「新建迭代」开始规划。" icon="🗓" title="还没有迭代" />
      ) : (
        <ul className={styles.list}>
          {sprints.map((sprint) => (
            <li key={sprint.id}>
              <button
                aria-label={`打开迭代 ${sprint.name}`}
                className={styles.card}
                onClick={() => navigate(toProjectPath(`/sprints/${sprint.id}`))}
                type="button"
              >
                <div className={styles.cardHead}>
                  <span className={styles.cardTitle}>{sprint.name}</span>
                  <Badge color={STATUS_COLOR[sprint.status]} label={STATUS_LABEL[sprint.status]} />
                </div>
                {sprint.goal ? <p className={styles.cardGoal}>{sprint.goal}</p> : null}
                <div className={styles.cardMeta}>
                  <span>📋 {sprint.taskCount} 任务</span>
                  <span>✓ {sprint.completedCount} 完成</span>
                  <span>剩余 {Math.round(sprint.remainingPoints)} 点</span>
                  {sprint.startDate ? (
                    <span className={styles.cardDate}>
                      {sprint.startDate.slice(0, 10)} → {sprint.endDate?.slice(0, 10) ?? "—"}
                    </span>
                  ) : null}
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

function SprintDetail({ sprintId }: { sprintId: string }) {
  const navigate = useNavigate();
  const toProjectPath = useProjectPathBuilder();
  const addToast = useUIStore((state) => state.addToast);
  const [detail, setDetail] = useState<SprintDetailView | null>(null);
  const [burndown, setBurndown] = useState<BurndownView | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([fetchSprintDetail(sprintId), fetchSprintBurndown(sprintId)])
      .then(([d, b]) => {
        if (!cancelled) {
          setDetail(d);
          setBurndown(b);
        }
      })
      .catch((err) => {
        if (!cancelled) addToast("error", err instanceof Error ? err.message : "加载迭代失败");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sprintId, addToast]);

  if (loading && !detail) {
    return <main className={styles.page}><p className={styles.placeholder}>加载中…</p></main>;
  }

  if (!detail) {
    return <main className={styles.page}><EmptyState description="迭代可能已被删除。" icon="🗓" title="迭代不存在" /></main>;
  }

  return (
    <main aria-label="迭代详情" className={styles.page} data-testid="sprint-detail-page">
      <header className={styles.detailHeader}>
        <button aria-label="返回迭代列表" className={styles.backBtn} onClick={() => navigate(toProjectPath("/sprints"))} type="button">
          ← 返回
        </button>
        <div>
          <div className={styles.detailTitleRow}>
            <h1 className={styles.title}>{detail.name}</h1>
            <Badge color={STATUS_COLOR[detail.status]} label={STATUS_LABEL[detail.status]} />
          </div>
          {detail.goal ? <p className={styles.cardGoal}>🎯 {detail.goal}</p> : null}
          <div className={styles.cardMeta}>
            <span>📋 {detail.taskCount} 任务</span>
            <span>✓ {detail.completedCount} 完成</span>
            <span>剩余 {Math.round(detail.remainingPoints)} 点</span>
            {detail.startDate ? <span>{detail.startDate.slice(0, 10)} → {detail.endDate?.slice(0, 10) ?? "—"}</span> : null}
          </div>
        </div>
      </header>

      <section aria-label="燃尽图" className={styles.section}>
        <h2 className={styles.sectionTitle}>📉 燃尽图</h2>
        {burndown ? <BurndownChart points={burndown.points} /> : <p className={styles.placeholder}>加载燃尽数据…</p>}
      </section>

      <section aria-label="迭代任务" className={styles.section}>
        <h2 className={styles.sectionTitle}>📋 迭代任务 ({detail.tasks.length})</h2>
        {detail.tasks.length === 0 ? (
          <p className={styles.placeholder}>该迭代还没有任务。在任务详情里设置 sprintId 即可加入。</p>
        ) : (
          <ul className={styles.taskList}>
            {detail.tasks.map((task) => (
              <li key={task.id}>
                <button
                  aria-label={`打开 ${task.title}`}
                  className={styles.taskRow}
                  onClick={() => navigate(toProjectPath(`/tasks/${task.id}`))}
                  type="button"
                >
                  <span className={styles.taskTitle}>{task.title}</span>
                  <span className={styles.taskMeta}>
                    {task.currentNode} · {task.progress}% {task.storyPoints ? `· ${task.storyPoints}pt` : ""}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
