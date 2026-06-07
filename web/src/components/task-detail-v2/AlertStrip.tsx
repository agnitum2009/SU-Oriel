import { useNavigate } from "react-router";

import styles from "./AlertStrip.module.css";
import type { NodeId } from "./types.js";
import { usePendingInteractions } from "./hooks/usePendingInteractions.js";
import { useProjectPathBuilder } from "../../lib/project-paths.js";
import type { TaskDetailView } from "../../types/task.js";

interface AlertStripProps {
  task: TaskDetailView;
  onSelectNode: (nodeId: NodeId) => void;
}

const KIND_LABEL: Record<string, string> = {
  consult_reply: "Codex 等你回复",
  review_intent: "等待 review 决策",
  approval: "等待审批",
  approval_record: "等待审批",
  pending_user_decision: "等待用户决策"
};

const NODE_IDS: NodeId[] = [
  "requirement_analysis",
  "technical_design",
  "task_breakdown",
  "dispatch",
  "implementation",
  "review",
  "archive"
];

function isNodeId(value: string): value is NodeId {
  return NODE_IDS.includes(value as NodeId);
}

export function AlertStrip({ task, onSelectNode }: AlertStripProps) {
  const navigate = useNavigate();
  const toProjectPath = useProjectPathBuilder();
  const { data: pendings } = usePendingInteractions(task.id);
  const hasBlocked = Boolean(task.blockedReason?.trim()) || task.runtimeState === "blocked";
  const requirement = task.linkedRequirement;
  const topPending = pendings.length > 0 ? pendings[0] : null;

  const alerts: Array<{ key: string; level: "action" | "warning" | "info"; node: React.ReactNode }> = [];

  if (hasBlocked) {
    alerts.push({
      key: "blocked",
      level: "warning",
      node: (
        <>
          <span className={styles.icon} aria-hidden="true">🚧</span>
          <div className={styles.content}>
            <div className={styles.title}>任务已阻塞</div>
            <div className={styles.summary}>{task.blockedReason ?? "runtime_state=blocked"}</div>
          </div>
        </>
      )
    });
  }

  if (requirement) {
    alerts.push({
      key: "requirement",
      level: "info",
      node: (
        <>
          <span className={styles.icon} aria-hidden="true">📌</span>
          <div className={styles.content}>
            <div className={styles.title}>来自需求：{requirement.title}</div>
            {requirement.verbatimSource ? (
              <div className={styles.summary}>{requirement.verbatimSource}</div>
            ) : null}
          </div>
          <div className={styles.actions}>
            <button
              className={styles.actionButton}
              onClick={() => navigate(toProjectPath(requirement.id ? `/requirements/${requirement.id}` : "/requirements"))}
              type="button"
            >
              查看需求
            </button>
          </div>
        </>
      )
    });
  }

  const pendingNodeId = topPending && isNodeId(topPending.nodeId) ? topPending.nodeId : null;
  const pendingCtaLabel = topPending?.ctaLabel ?? topPending?.cta ?? "打开节点 →";

  return (
    <div className={styles.strip}>
      <section
        aria-label="待处理事项"
        className={styles.alert}
        data-level={topPending ? "action" : "info"}
        role="region"
      >
        {topPending ? (
          <>
            <span className={styles.icon} aria-hidden="true">⚡</span>
            <div className={styles.content}>
              <div className={styles.title}>{KIND_LABEL[topPending.kind] ?? "需要你的操作"}</div>
              <div className={styles.summary}>{topPending.summary}</div>
            </div>
            <div className={styles.actions}>
              {pendings.length > 1 ? <span className={styles.count}>+{pendings.length - 1} 项</span> : null}
              <button
                className={styles.actionButton}
                onClick={() => {
                  if (pendingNodeId) onSelectNode(pendingNodeId);
                }}
                type="button"
              >
                {pendingCtaLabel}
              </button>
            </div>
          </>
        ) : (
          <>
            <span className={styles.icon} aria-hidden="true">✓</span>
            <div className={styles.content}>
              <div className={styles.summary}>暂无需要你处理的事项</div>
            </div>
          </>
        )}
      </section>
      {alerts.map((alert) => (
        <div className={styles.alert} data-level={alert.level} key={alert.key}>
          {alert.node}
        </div>
      ))}
    </div>
  );
}
