import { useMemo } from "react";

import styles from "./NodeActivityFeed.module.css";
import type { NodeId } from "./types.js";
import { useTaskEventStream, type SseEvent } from "./hooks/useTaskEventStream.js";

interface NodeActivityFeedProps {
  taskId: string;
  nodeId: NodeId;
  onOpenFullTimeline?: () => void;
}

const EVENT_KIND_LABEL: Record<string, string> = {
  codex_receipt_ready: "Codex 回执就绪",
  codex_picked_up: "Codex 已 pickup",
  codex_rejected: "Codex 拒绝",
  user_arbitration_submitted: "用户决策提交",
  session_resumed: "Session 恢复",
  state_write_conflict: "State 写冲突",
  verification_finished: "验证完成",
  batch_cancelled: "Batch 取消",
  tool_call_denied: "Tool 调用拒绝",
  intent_pending: "Intent pending",
  intent_consumed: "Intent consumed",
  consult: "Consult 协商",
  consult_round_added: "Consult 新一轮",
  transition: "Transition",
  approval: "审批"
};

function relativeTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "?";
  const diff = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (diff < 60) return "刚刚";
  if (diff < 3600) return `${Math.floor(diff / 60)}m 前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h 前`;
  return `${Math.floor(diff / 86400)}d 前`;
}

function eventKindColor(kind: string): string {
  if (kind.startsWith("codex_receipt") || kind.includes("verification")) return "green";
  if (kind.includes("rejected") || kind.includes("conflict") || kind.includes("denied")) return "red";
  if (kind.includes("consult")) return "blue";
  if (kind.includes("transition")) return "purple";
  return "gray";
}

function eventNodeId(event: SseEvent): string | undefined {
  const payload = event.payload as Record<string, unknown> | undefined;
  if (!payload) return undefined;
  const node = (payload.node_id ?? payload.nodeId ?? payload.target_node ?? payload.targetNode) as string | undefined;
  return node;
}

function eventSummary(event: SseEvent): string {
  const payload = event.payload as Record<string, unknown> | undefined;
  if (!payload) return "";
  const label = payload.label;
  if (typeof label === "string") return label;
  return Object.entries(payload)
    .filter(([, v]) => typeof v === "string" || typeof v === "number")
    .slice(0, 2)
    .map(([k, v]) => `${k}: ${v}`)
    .join(" · ");
}

export function NodeActivityFeed({ taskId, nodeId, onOpenFullTimeline }: NodeActivityFeedProps) {
  const { events } = useTaskEventStream(taskId);

  const filtered = useMemo(() => {
    return events
      .filter((event) => {
        if (event.event_type.startsWith("workspace_")) return false;
        const en = eventNodeId(event);
        return !en || en === nodeId;
      })
      .slice(-15)
      .reverse();
  }, [events, nodeId]);

  if (filtered.length === 0) {
    return (
      <div className={styles.empty}>
        <p className={styles.emptyTitle}>暂无活动</p>
        <p className={styles.emptyHint}>该节点的 events 会实时流式追加</p>
      </div>
    );
  }

  return (
    <div className={styles.feed}>
      <ol className={styles.list}>
        {filtered.map((event) => (
          <li className={styles.item} key={event.event_id}>
            <span className={styles.dot} data-color={eventKindColor(event.event_type)} aria-hidden="true" />
            <div className={styles.content}>
              <div className={styles.header}>
                <span className={styles.kind}>
                  {EVENT_KIND_LABEL[event.event_type] ?? event.event_type}
                </span>
                <time className={styles.time}>{relativeTime(event.emitted_at)}</time>
              </div>
              {eventSummary(event) ? <div className={styles.summary}>{eventSummary(event)}</div> : null}
            </div>
          </li>
        ))}
      </ol>
      {onOpenFullTimeline ? (
        <button className={styles.viewAll} onClick={onOpenFullTimeline} type="button">
          查看完整时间线 →
        </button>
      ) : null}
    </div>
  );
}
