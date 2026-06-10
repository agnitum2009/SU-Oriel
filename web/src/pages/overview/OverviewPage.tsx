import { useMemo } from "react";
import { useNavigate } from "react-router";

import styles from "./OverviewPage.module.css";
import { MetricCard } from "../../components/metric/MetricCard.js";
import { ProjectOnboardingBanner } from "../../components/projects/ProjectOnboardingBanner.js";
import { EmptyState } from "../../components/ui/EmptyState.js";
import { SkeletonStat } from "../../components/ui/Skeleton.js";
import { formatDayTime } from "../../lib/format.js";
import { createTaskBoardProjection, isTaskAttentionNeeded } from "../../lib/node-board-config.js";
import { useProjectPathBuilder } from "../../lib/project-paths.js";
import { classifyRequirementTab, isActiveRequirementTab } from "../../lib/ui-mapping.js";
import { useProjectStore } from "../../stores/project-store.js";
import { useUIStore } from "../../stores/ui-store.js";

export function OverviewPage() {
  const navigate = useNavigate();
  const toProjectPath = useProjectPathBuilder();
  const selectedProjectId = useProjectStore((state) => state.selectedProjectId);
  const requirements = useProjectStore((state) => state.requirements);
  const tasks = useProjectStore((state) => state.tasks);
  const documents = useProjectStore((state) => state.documents);
  const syncJobs = useProjectStore((state) => state.syncJobs);
  const indexHealth = useProjectStore((state) => state.indexHealth);
  const loadingData = useProjectStore((state) => state.loadingData);
  const openModal = useUIStore((state) => state.openModal);

  // 需求是首页主区，但只做粗粒度聚合：活跃 / 需关注 / 已交付（不展开列表、不做多桶分布）。
  // 复用 classifyRequirementTab 作为 status 归类真相源，避免在首页重复定义状态语义。
  const requirementStats = useMemo(() => {
    let active = 0;
    let delivered = 0;
    let attention = 0;
    for (const requirement of requirements) {
      const tab = classifyRequirementTab(requirement.status);
      if (tab === "delivered") {
        delivered += 1;
      }
      // 活跃 = 仍在生命周期早中段的需求（待处理 + 规划中 + 推进中）；需关注是其中的子集。
      if (isActiveRequirementTab(tab)) {
        active += 1;
        const runtimeState = requirement.planningRuntimeState;
        const analysisStale = Boolean(requirement.analysisStaleAt);
        if (runtimeState === "blocked" || runtimeState === "failed" || analysisStale) {
          attention += 1;
        }
      }
    }
    return { active, delivered, attention };
  }, [requirements]);

  const taskProjection = useMemo(() => createTaskBoardProjection(tasks, { includeArchived: false }), [tasks]);
  const blockedTaskCount = useMemo(
    () => taskProjection.visibleTasks.filter(isTaskAttentionNeeded).length,
    [taskProjection.visibleTasks]
  );
  const failedScanCount = useMemo(() => syncJobs.filter((job) => job.status === "failed").length, [syncJobs]);

  if (!selectedProjectId) {
    return (
      <EmptyState
        action={{ label: "创建项目", onClick: () => openModal("create-project") }}
        description="当前项目不存在或尚未创建。重新创建项目后，项目接入引导会继续检查 ccb runtime 与知识库。"
        icon="⬡"
        title="还没有选中的项目"
      />
    );
  }

  if (loadingData) {
    return (
      <div className={styles.page}>
        <div className={styles.primaryStatsGrid}>
          {Array.from({ length: 3 }).map((_, index) => (
            <SkeletonStat key={`overview-stat-${index}`} />
          ))}
        </div>
      </div>
    );
  }

  const parseFailureCount = indexHealth?.parseFailureCount ?? 0;
  const partialParseCount = indexHealth?.partialParseCount ?? 0;

  return (
    <div className={styles.page}>
      <ProjectOnboardingBanner projectId={selectedProjectId} />

      <section className={styles.sectionCard}>
        <div className={styles.sectionHeader}>
          <div>
            <div className={styles.sectionTitle}>需求</div>
            <div className={styles.sectionDescription}>本项目当前的需求概览。</div>
          </div>
          <button className={styles.linkButton} onClick={() => navigate(toProjectPath("/requirements"))} type="button">
            查看全部 →
          </button>
        </div>
        <div className={styles.primaryStatsGrid}>
          <MetricCard label="活跃需求" size="lg" subStatus="待处理 + 规划中 + 推进中" tone="default" value={requirementStats.active} />
          <MetricCard
            label="需关注"
            size="lg"
            subStatus={requirementStats.attention > 0 ? "阻塞 / 失败 / 分析过期" : "暂无需关注"}
            tone={requirementStats.attention > 0 ? "danger" : "success"}
            value={requirementStats.attention}
          />
          <MetricCard label="已交付" size="lg" subStatus="delivered" tone="success" value={requirementStats.delivered} />
        </div>
      </section>

      <section className={styles.sectionCard}>
        <div className={styles.sectionHeader}>
          <div>
            <div className={styles.sectionTitle}>任务与文档</div>
            <div className={styles.sectionDescription}>次要数据，明细见各自页面。</div>
          </div>
        </div>
        <div className={styles.compactGrid}>
          <button className={styles.compactItem} onClick={() => navigate(toProjectPath("/tasks"))} type="button">
            <span className={styles.compactLabel}>任务</span>
            <strong className={styles.compactValue}>{taskProjection.visibleTaskCount}</strong>
          </button>
          <button className={styles.compactItem} onClick={() => navigate(toProjectPath("/tasks"))} type="button">
            <span className={styles.compactLabel}>阻塞任务</span>
            <strong className={styles.compactValue}>{blockedTaskCount}</strong>
          </button>
          <button className={styles.compactItem} onClick={() => navigate(toProjectPath("/documents"))} type="button">
            <span className={styles.compactLabel}>文档</span>
            <strong className={styles.compactValue}>{documents.length}</strong>
          </button>
        </div>
      </section>

      <section className={styles.indexHealthCard}>
        <div className={styles.sectionHeader}>
          <div>
            <div className={styles.sectionTitle}>系统健康</div>
            <div className={styles.sectionDescription}>
              最近扫描：{indexHealth?.lastScanAt ? formatDayTime(indexHealth.lastScanAt) : "尚未扫描"}
            </div>
          </div>
        </div>
        <div className={styles.compactGrid}>
          <div className={styles.compactItem}>
            <span className={styles.compactLabel}>解析失败</span>
            <strong className={styles.compactValue}>{parseFailureCount}</strong>
          </div>
          <div className={styles.compactItem}>
            <span className={styles.compactLabel}>格式待规范化</span>
            <strong className={styles.compactValue}>{partialParseCount}</strong>
          </div>
          <button className={styles.compactItem} onClick={() => navigate(toProjectPath("/runs"))} type="button">
            <span className={styles.compactLabel}>扫描失败</span>
            <strong className={styles.compactValue}>{failedScanCount}</strong>
          </button>
        </div>
      </section>
    </div>
  );
}
