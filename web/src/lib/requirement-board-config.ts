import type { RequirementView } from "../types/requirement.js";
import { REQUIREMENT_TAB_LABELS, classifyRequirementTab } from "./ui-mapping.js";
import type { RequirementTabKey } from "./ui-mapping.js";

export interface RequirementBoardColumnDef {
  key: RequirementTabKey;
  label: string;
  /** 归档列视觉降权（与任务看板 archive 列一致） */
  muted?: boolean;
}

/**
 * 需求看板列定义。
 *
 * 复用列表页已有的 5 个分类桶（{@link classifyRequirementTab}）作为看板 5 列，
 * 按生命周期排序（待处理→规划中→推进中→已交付→已搁置），与需求 status 枚举同序、零额外映射。
 * 这是任务看板 NODE_BOARD_COLUMNS 的对应物，但列是需求生命周期阶段而非任务工作流节点。
 */
export const REQUIREMENT_BOARD_COLUMNS: RequirementBoardColumnDef[] = [
  { key: "pending", label: REQUIREMENT_TAB_LABELS.pending },
  { key: "planning", label: REQUIREMENT_TAB_LABELS.planning },
  { key: "delivering", label: REQUIREMENT_TAB_LABELS.delivering },
  { key: "delivered", label: REQUIREMENT_TAB_LABELS.delivered },
  { key: "archived", label: REQUIREMENT_TAB_LABELS.archived, muted: true }
];

export interface RequirementBoardColumn extends RequirementBoardColumnDef {
  requirements: RequirementView[];
}

export interface RequirementBoardProjection {
  totalCount: number;
  columns: RequirementBoardColumn[];
}

/**
 * 把需求按 status 分组到看板列，列内按创建时间倒序。
 *
 * 对应任务看板的 createTaskBoardProjection；分桶逻辑直接复用 classifyRequirementTab，
 * 保证列表语义与看板语义同源、不漂移。
 */
export function createRequirementBoardProjection(
  requirements: RequirementView[]
): RequirementBoardProjection {
  const buckets: Record<RequirementTabKey, RequirementView[]> = {
    pending: [],
    planning: [],
    delivering: [],
    delivered: [],
    archived: []
  };
  for (const requirement of requirements) {
    buckets[classifyRequirementTab(requirement.status)].push(requirement);
  }
  for (const key of Object.keys(buckets) as RequirementTabKey[]) {
    buckets[key].sort(
      (left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime()
    );
  }

  return {
    totalCount: requirements.length,
    columns: REQUIREMENT_BOARD_COLUMNS.map((column) => ({
      ...column,
      requirements: buckets[column.key]
    }))
  };
}
