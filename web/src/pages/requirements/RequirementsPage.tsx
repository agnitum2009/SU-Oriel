import { useMemo, useState } from "react";
import { useNavigate } from "react-router";

import styles from "./RequirementsPage.module.css";
import { Badge } from "../../components/ui/Badge.js";
import { Card } from "../../components/ui/Card.js";
import { EmptyState } from "../../components/ui/EmptyState.js";
import { SkeletonCard } from "../../components/ui/Skeleton.js";
import {
  refreshProjectRequirementStatus,
  refreshRequirementStatus
} from "../../lib/console-api.js";
import { formatDateTime } from "../../lib/format.js";
import { useProjectPathBuilder } from "../../lib/project-paths.js";
import { createRequirementBoardProjection } from "../../lib/requirement-board-config.js";
import { getRequirementAction, getRequirementStatusBadge } from "../../lib/ui-mapping.js";
import { useProjectStore } from "../../stores/project-store.js";
import { useUIStore } from "../../stores/ui-store.js";

export function RequirementsPage() {
  const navigate = useNavigate();
  const toProjectPath = useProjectPathBuilder();
  const selectedProjectId = useProjectStore((state) => state.selectedProjectId);
  const requirements = useProjectStore((state) => state.requirements);
  const loadingData = useProjectStore((state) => state.loadingData);
  const openModal = useUIStore((state) => state.openModal);
  const addToast = useUIStore((state) => state.addToast);
  const loadProjectData = useProjectStore((state) => state.loadProjectData);

  const [refreshing, setRefreshing] = useState(false);

  const handleRefreshAll = async () => {
    if (!selectedProjectId) return;
    setRefreshing(true);
    try {
      const result = await refreshProjectRequirementStatus(selectedProjectId);
      if (result.updated > 0) {
        addToast("success", `已刷新 ${result.updated} 条需求状态（共检查 ${result.checked} 条）`);
        await loadProjectData(selectedProjectId);
      } else {
        addToast("info", `检查 ${result.checked} 条需求，无需更新`);
      }
    } catch (error) {
      addToast("error", error instanceof Error ? error.message : "刷新失败");
    } finally {
      setRefreshing(false);
    }
  };

  const handleRefreshOne = async (requirementId: string) => {
    if (!selectedProjectId) return;
    try {
      const result = await refreshRequirementStatus(requirementId);
      if (result.updated) {
        addToast("success", `状态已更新：${result.oldStatus ?? "?"} → ${result.newStatus ?? "?"}`);
        await loadProjectData(selectedProjectId);
      } else {
        addToast("info", "已是最新状态");
      }
    } catch (error) {
      addToast("error", error instanceof Error ? error.message : "刷新失败");
    }
  };

  const board = useMemo(() => createRequirementBoardProjection(requirements), [requirements]);

  if (!selectedProjectId) {
    return (
      <EmptyState
        description="先创建或选择一个项目，再用需求管理来登记和派生骨架。"
        icon="◇"
        title="还没有选中的项目"
      />
    );
  }

  if (loadingData) {
    return (
      <div className={styles.page}>
        <div className={styles.kanban}>
          {board.columns.map((column) => (
            <section className={styles.column} key={column.key}>
              <div className={styles.columnHeader}>
                <span className={styles.columnTitle}>{column.label}</span>
              </div>
              <div className={styles.columnBody}>
                <SkeletonCard />
                <SkeletonCard />
              </div>
            </section>
          ))}
        </div>
      </div>
    );
  }

  if (requirements.length === 0) {
    return (
      <EmptyState
        action={{ label: "新建需求", onClick: () => openModal("create-requirement") }}
        description="需求是文档驱动流程的起点：分析 → 设计 → 拆分为开发任务。"
        icon="◇"
        title="还没有需求"
      />
    );
  }

  const navigateToDetail = (requirementId: string) => navigate(toProjectPath(`/requirements/${requirementId}`));

  return (
    <div className={styles.page}>
      <div className={styles.boardHintRow}>
        <span className={styles.boardHint}>共 {board.totalCount} 条需求</span>
        <button
          className={styles.refreshAllButton}
          disabled={refreshing}
          onClick={() => void handleRefreshAll()}
          title="按 task 真实状态重算所有需求 status"
          type="button"
        >
          ⟳ {refreshing ? "刷新中…" : "刷新状态"}
        </button>
      </div>

      <div className={styles.kanban}>
        {board.columns.map((column) => (
          <section
            className={styles.column}
            data-archived={column.muted ? "true" : undefined}
            data-column={column.key}
            key={column.key}
          >
            <div className={styles.columnHeader}>
              <span className={styles.columnTitle}>{column.label}</span>
              <Badge color="gray" label={String(column.requirements.length)} />
            </div>

            <div className={styles.columnBody}>
              {column.requirements.length === 0 ? (
                <div className={styles.emptyColumn}>暂无需求</div>
              ) : null}
              {column.requirements.map((requirement) => {
                const badge = getRequirementStatusBadge(requirement.status);
                const action = getRequirementAction(requirement.status, requirement.generatedTaskId);
                const isArchived = action.kind === "archived";
                return (
                  <Card
                    className={styles.boardCard}
                    key={requirement.id}
                    onClick={() => navigateToDetail(requirement.id)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        navigateToDetail(requirement.id);
                      }
                    }}
                    role="link"
                    style={{ cursor: "pointer" }}
                    tabIndex={0}
                  >
                    <div className={styles.cardTop}>
                      <span className={styles.cardTitle}>{requirement.title}</span>
                      <button
                        aria-label="刷新此需求状态"
                        className={styles.refreshOneButton}
                        onClick={(event) => {
                          event.stopPropagation();
                          void handleRefreshOne(requirement.id);
                        }}
                        title="按子任务真实状态重算此需求"
                        type="button"
                      >
                        ⟳
                      </button>
                    </div>
                    <div className={styles.cardBadges}>
                      <Badge color={badge.color} label={badge.label} />
                    </div>
                    {requirement.description ? (
                      <p className={styles.cardDescription}>{requirement.description}</p>
                    ) : null}
                    <div className={styles.cardFooter}>
                      <span className={styles.cardDate}>{formatDateTime(requirement.createdAt)}</span>
                      {isArchived ? null : (
                        <span className={styles.cardAction}>{action.label} →</span>
                      )}
                    </div>
                  </Card>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
