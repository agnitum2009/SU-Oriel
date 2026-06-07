import { useEffect } from "react";
import { useNavigate } from "react-router";

import styles from "./TasksPage.module.css";
import { TaskDetailPage } from "./TaskDetailPage.js";
import { Badge } from "../../components/ui/Badge.js";
import { EmptyState } from "../../components/ui/EmptyState.js";
import { SkeletonCard } from "../../components/ui/Skeleton.js";
import { useProjectPathBuilder } from "../../lib/project-paths.js";
import { useDetailStore } from "../../stores/detail-store.js";
import { useProjectStore } from "../../stores/project-store.js";

interface TaskDetailFullPageProps {
  taskId: string;
}

function syncBadgeColor(status: string | undefined) {
  if (status === "running" || status === "scanning") return "yellow" as const;
  if (status === "failed" || status === "partial") return "red" as const;
  return "gray" as const;
}

export function TaskDetailFullPage({ taskId }: TaskDetailFullPageProps) {
  const navigate = useNavigate();
  const toProjectPath = useProjectPathBuilder();
  const taskDetail = useDetailStore((state) => state.taskDetail);
  const loadingTaskDetail = useDetailStore((state) => state.loadingTaskDetail);
  const loadTaskDetail = useDetailStore((state) => state.loadTaskDetail);
  const clearTaskDetail = useDetailStore((state) => state.clearTaskDetail);
  const projects = useProjectStore((state) => state.projects);
  const selectedProjectId = useProjectStore((state) => state.selectedProjectId);
  const selectedProject = projects.find((project) => project.id === selectedProjectId);

  useEffect(() => {
    void loadTaskDetail(taskId);
    return () => clearTaskDetail();
  }, [clearTaskDetail, loadTaskDetail, taskId]);

  return (
    <main className={styles.fullPage} data-testid="task-detail-full-page">
      <header className={styles.fullPageHeader}>
        <button aria-label="返回看板" className={styles.fullPageBackButton} onClick={() => navigate(toProjectPath("/tasks"))} type="button">
          <span aria-hidden="true">←</span>
          <span>返回看板</span>
        </button>
        <div className={styles.fullPageTitleBlock}>
          {taskDetail?.linkedRequirement ? (
            <nav aria-label="面包屑" className={styles.breadcrumb}>
              <button
                aria-label={`打开父需求 ${taskDetail.linkedRequirement.title}`}
                className={styles.crumbLink}
                onClick={() => navigate(toProjectPath(`/requirements/${taskDetail.linkedRequirement!.id}`))}
                type="button"
              >
                📋 {taskDetail.linkedRequirement.title}
              </button>
            </nav>
          ) : null}
          <h1 className={styles.fullPageTitle}>{taskDetail?.title ?? "任务详情"}</h1>
          <span className={styles.fullPageMeta}>{taskDetail?.taskKey ?? taskId}</span>
        </div>
        <div className={styles.fullPageStatus}>
          <Badge color="gray" label="子任务" />
          <Badge color={syncBadgeColor(selectedProject?.syncStatus)} label={`sync ${selectedProject?.syncStatus ?? "unknown"}`} />
        </div>
      </header>

      <div className={styles.fullPageBody}>
        {loadingTaskDetail && !taskDetail ? (
          <div className={styles.panelLoading}>
            <SkeletonCard className={styles.panelSkeleton} />
          </div>
        ) : taskDetail ? (
          <TaskDetailPage task={taskDetail} />
        ) : (
          <EmptyState description="没有找到对应任务，可能该任务已被更新或移除。" icon="☰" title="任务不存在" />
        )}
      </div>
    </main>
  );
}
