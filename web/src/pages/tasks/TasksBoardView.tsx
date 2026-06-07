import { useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";

import styles from "./TasksPage.module.css";
import { TasksListView } from "./TasksListView.js";
import { HealthPanel } from "../../components/task-board/HealthPanel.js";
import { UnstartedRequirementStrip } from "../../components/task-board/UnstartedRequirementStrip.js";
import {
  TasksFilterBar,
  applyTaskFilter,
  emptyFilter,
  isFilterActive,
  parseFilter,
  serializeFilter,
  type TaskFilter
} from "../../components/task-board/TasksFilterBar.js";
import { Badge } from "../../components/ui/Badge.js";
import { Card } from "../../components/ui/Card.js";
import { EmptyState } from "../../components/ui/EmptyState.js";
import { SkeletonCard } from "../../components/ui/Skeleton.js";
import {
  NODE_BOARD_COLUMNS,
  createTaskBoardProjection,
  isTaskAttentionNeeded
} from "../../lib/node-board-config.js";
import { useProjectPathBuilder } from "../../lib/project-paths.js";
import { getNodeBadge, getPriorityBadge } from "../../lib/ui-mapping.js";
import { useProjectStore } from "../../stores/project-store.js";
import type { RequirementView } from "../../types/requirement.js";
import type { TaskView } from "../../types/task.js";

interface TasksBoardViewProps {
  selectedProjectId: string | null;
  tasks: TaskView[];
  requirements: RequirementView[];
  loadingData: boolean;
  includeArchived: boolean;
  viewMode?: "board" | "list";  // Phase A1
  taskFilter?: TaskFilter;  // Phase A4
  onIncludeArchivedChange: (includeArchived: boolean) => void;
  onTaskSelect: (taskId: string) => void;
  onRequirementSelect?: (requirementId: string) => void;
  onViewChange?: (view: "board" | "list") => void;  // Phase A1
  onFilterChange?: (filter: TaskFilter) => void;  // Phase A4
}

export function TasksBoardRoute() {
  const navigate = useNavigate();
  const toProjectPath = useProjectPathBuilder();
  const [searchParams] = useSearchParams();
  const selectedProjectId = useProjectStore((state) => state.selectedProjectId);
  const tasks = useProjectStore((state) => state.tasks);
  const requirements = useProjectStore((state) => state.requirements);
  const loadingData = useProjectStore((state) => state.loadingData);
  const [includeArchived, setIncludeArchived] = useState(false);
  const viewMode = (searchParams.get("view") === "list" ? "list" : "board") as "board" | "list";  // Phase A1
  const taskFilter = useMemo(() => parseFilter(searchParams.get("filter")), [searchParams]);  // Phase A4

  const handleViewChange = (next: "board" | "list") => {
    const params = new URLSearchParams(searchParams);
    if (next === "list") {
      params.set("view", "list");
    } else {
      params.delete("view");
    }
    navigate(toProjectPath(`/tasks${params.toString() ? `?${params}` : ""}`), { replace: true });
  };

  const handleFilterChange = (next: TaskFilter) => {
    const params = new URLSearchParams(searchParams);
    if (isFilterActive(next)) {
      params.set("filter", serializeFilter(next));
    } else {
      params.delete("filter");
    }
    navigate(toProjectPath(`/tasks${params.toString() ? `?${params}` : ""}`), { replace: true });
  };

  return (
    <TasksBoardView
      includeArchived={includeArchived}
      loadingData={loadingData}
      onFilterChange={handleFilterChange}
      onIncludeArchivedChange={setIncludeArchived}
      onRequirementSelect={(requirementId) => navigate(toProjectPath(`/requirements/${requirementId}`))}
      onTaskSelect={(taskId) => navigate(toProjectPath(`/tasks/${taskId}`))}
      onViewChange={handleViewChange}
      requirements={requirements}
      selectedProjectId={selectedProjectId}
      taskFilter={taskFilter}
      tasks={tasks}
      viewMode={viewMode}
    />
  );
}

export function TasksBoardView({
  selectedProjectId,
  tasks,
  requirements,
  loadingData,
  includeArchived,
  viewMode = "board",
  taskFilter,
  onIncludeArchivedChange,
  onTaskSelect,
  onRequirementSelect,
  onViewChange,
  onFilterChange
}: TasksBoardViewProps) {
  const effectiveFilter = taskFilter ?? emptyFilter();

  const filteredTasks = useMemo(() => {
    if (taskFilter && isFilterActive(taskFilter)) {
      return applyTaskFilter(tasks, taskFilter);
    }
    return tasks;
  }, [tasks, taskFilter]);

  const boardTasks = useMemo(
    () => filteredTasks.filter((task) => task.currentNode !== "backlog"),
    [filteredTasks]
  );

  const boardProjection = useMemo(
    () => createTaskBoardProjection(boardTasks, {
      includeArchived,
      includeEpics: false
    }),
    [boardTasks, includeArchived]
  );

  if (!selectedProjectId) {
    return <EmptyState description="先创建或选择一个项目，任务看板才会展示任务派生结果。" icon="☰" title="还没有选中的项目" />;
  }

  if (loadingData) {
    return (
      <div className={styles.page}>
        <div className={styles.kanban}>
          {NODE_BOARD_COLUMNS.map((column) => (
            <section className={styles.column} data-node={column.key} key={column.key}>
              <div className={styles.columnHeader}>{column.label}</div>
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

  if (tasks.length === 0) {
    return <EmptyState description="执行文档扫描后任务会自动派生。" icon="☰" title="当前项目还没有任务" />;
  }

  return (
    <div className={styles.page}>
      {selectedProjectId ? (
        <HealthPanel onTaskSelect={onTaskSelect} projectId={selectedProjectId} />
      ) : null}

      {onRequirementSelect ? (
        <UnstartedRequirementStrip
          onRequirementSelect={onRequirementSelect}
          requirements={requirements}
        />
      ) : null}

      {/* Phase A4: Filter bar + Saved Views */}
      {onFilterChange ? (
        <TasksFilterBar filter={effectiveFilter} onFilterChange={onFilterChange} />
      ) : null}

      <div className={styles.boardHintRow}>
        <div className={styles.boardHint}>
          共 {boardProjection.visibleTaskCount} 个任务
          {boardProjection.hiddenArchivedCount > 0 ? `（已隐藏 ${boardProjection.hiddenArchivedCount} 个归档）` : ""}
        </div>

        {/* Phase A1: View switcher (Board / List) */}
        {onViewChange ? (
          <div aria-label="视图切换" className={styles.viewSwitcher} role="tablist">
            <button
              aria-selected={viewMode === "board"}
              className={styles.viewTab}
              data-active={viewMode === "board"}
              onClick={() => onViewChange("board")}
              role="tab"
              type="button"
            >
              ◫ 看板
            </button>
            <button
              aria-selected={viewMode === "list"}
              className={styles.viewTab}
              data-active={viewMode === "list"}
              onClick={() => onViewChange("list")}
              role="tab"
              type="button"
            >
              ☰ 列表
            </button>
          </div>
        ) : null}

        {boardProjection.archivedCount > 0 ? (
          <label className={styles.archiveToggle}>
            <input checked={includeArchived} onChange={(event) => onIncludeArchivedChange(event.target.checked)} type="checkbox" />
            <span>显示已归档</span>
          </label>
        ) : null}
      </div>

      {/* Phase A1: List 视图 */}
      {viewMode === "list" ? (
        <TasksListView onTaskSelect={onTaskSelect} tasks={boardProjection.visibleTasks} />
      ) : (
      <>
      <div className={styles.kanban}>
        {boardProjection.columns.map((column) => (
          <section className={styles.column} data-node={column.key} key={column.key}>
            <div className={styles.columnHeader}>
              <span className={styles.columnTitle}>
                <span>{column.label}</span>
                {column.gate ? <span className={styles.columnGate} title={column.gate.title}>{column.gate.marker}</span> : null}
              </span>
              <Badge color="gray" label={String(column.tasks.length)} />
            </div>

            <div className={styles.columnBody}>
              {column.tasks.length === 0 ? <div className={styles.emptyColumn}>暂无任务</div> : null}
              {column.tasks.map((task) => {
                const nodeBadge = getNodeBadge(task.currentNode, task.nodeSubstate);
                return (
                  <Card className={styles.taskCard} key={task.id} onClick={() => onTaskSelect(task.id)} selected={false}>
                    <div className={styles.priorityBar} data-priority={task.priority} />
                    <div className={styles.taskTitle}>
                      <span className={styles.taskTitleText}>{task.title}</span>
                      <span className={styles.taskKey}>{task.taskKey}</span>
                    </div>
                    <div className={styles.taskNodeLine}>
                      {nodeBadge ? <Badge color={nodeBadge.color} label={nodeBadge.label} /> : <Badge color="gray" label="节点未知" />}
                      <Badge color="gray" label="子任务" />
                    </div>
                    <div className={styles.taskMeta}>
                      <span>{getPriorityBadge(task.priority).label}</span>
                      <span>·</span>
                      <span>{task.progress}%</span>
                      {task.step !== null ? (
                        <>
                          <span>·</span>
                          <span>Step {task.step}</span>
                        </>
                      ) : null}
                    </div>
                    <div className={styles.progressTrack}><div className={styles.progressBar} style={{ width: `${task.progress}%` }} /></div>
                    {isTaskAttentionNeeded(task) && task.blockedReason ? (
                      <div className={styles.blockedCallout} title={task.blockedReason}>
                        <span className={styles.blockedIcon}>⚠</span>
                        <span className={styles.blockedText}>{task.blockedReason}</span>
                      </div>
                    ) : null}
                  </Card>
                );
              })}
            </div>
          </section>
        ))}
      </div>
      </>
      )}
    </div>
  );
}
