import { useNavigate } from "react-router";

import styles from "./ActivityFeed.module.css";
import { EmptyState } from "../../components/ui/EmptyState.js";
import { projectPath } from "../../lib/project-paths.js";
import { useActivityRecent, type ActivityEvent } from "../../lib/use-activity-recent.js";

type ActivityTone = "success" | "warn" | "danger" | "info";

interface ActivityFeedProps {
  enabled?: boolean;
  events?: ActivityEvent[];
  loading?: boolean;
  error?: string | null;
  onRefresh?: () => void | Promise<unknown>;
}

interface ActivityFeedItem {
  tone: ActivityTone;
  icon: string;
  label: string;
  target: string | null;
  ariaLabel: string | null;
}

export function ActivityFeed({ enabled = true, events, loading, error, onRefresh }: ActivityFeedProps) {
  const navigate = useNavigate();
  const activity = useActivityRecent({ enabled: enabled && events === undefined, limit: 10 });
  const visibleEvents = events ?? activity.events;
  const visibleLoading = loading ?? activity.loading;
  const visibleError = error ?? activity.error;
  const refresh = onRefresh ?? activity.refresh;

  return (
    <section className={styles.card} aria-label="Activity Feed">
      <div className={styles.header}>
        <div>
          <h2 className={styles.title}>Activity Feed</h2>
          <p className={styles.description}>最近 10 条跨任务事件。</p>
        </div>
        <button className={styles.linkButton} onClick={() => void refresh()} type="button">
          Refresh
        </button>
      </div>

      {visibleLoading && visibleEvents.length === 0 ? (
        <div className={styles.placeholder}>Loading activity...</div>
      ) : visibleError && visibleEvents.length === 0 ? (
        <div className={styles.error}>{visibleError}</div>
      ) : visibleEvents.length > 0 ? (
        <div className={styles.list}>
          {visibleEvents.map((event) => {
            const item = mapActivityEvent(event);
            const content = (
              <>
                <span className={styles.icon} aria-hidden="true">
                  {item.icon}
                </span>
                <span className={styles.main}>
                  <span className={styles.label}>{item.label}</span>
                  <time className={styles.time} dateTime={event.at} title={event.at}>
                    {formatActivityTime(event.at)}
                  </time>
                </span>
              </>
            );

            if (item.target) {
              const target = item.target;
              return (
                <button
                  aria-label={item.ariaLabel ?? `Open ${event.taskId ?? event.eventType} activity`}
                  className={styles.row}
                  data-testid={`activity-event-${event.eventId}`}
                  data-tone={item.tone}
                  key={event.eventId}
                  onClick={() => navigate(target)}
                  type="button"
                >
                  {content}
                </button>
              );
            }

            return (
              <div
                className={styles.row}
                data-testid={`activity-event-${event.eventId}`}
                data-tone={item.tone}
                key={event.eventId}
              >
                {content}
              </div>
            );
          })}
        </div>
      ) : (
        <EmptyState
          description="EventJournal 产生事件后，这里会显示最新活动。"
          icon="ACT"
          title="No recent activity"
        />
      )}
    </section>
  );
}

export function mapActivityEvent(event: ActivityEvent): ActivityFeedItem {
  const taskLabel = event.taskId ?? event.projectId ?? "unknown-task";

  if (event.eventType === "codex_receipt_ready") {
    return {
      tone: "success",
      icon: "🟢",
      label: `${taskLabel} receipt ready (codex)`,
      target:
        event.taskId && event.projectId
          ? projectPath(event.projectId, `/tasks/${encodeURIComponent(event.taskId)}?tab=consultation`)
          : null,
      ariaLabel: event.taskId ? `Open ${event.taskId} consultation activity` : null
    };
  }

  if (event.eventType === "transition.applied") {
    const source = readString(event.payload.source) ?? readString(event.payload.source_node);
    const target = readString(event.payload.target) ?? readString(event.payload.target_node);
    const route = source && target ? ` (${source}→${target})` : "";
    return {
      tone: "success",
      icon: "🟢",
      label: `${taskLabel} transition apply${route}`,
      target:
        event.taskId && event.projectId
          ? projectPath(event.projectId, `/tasks/${encodeURIComponent(event.taskId)}?tab=node-flow`)
          : null,
      ariaLabel: event.taskId ? `Open ${event.taskId} node flow activity` : null
    };
  }

  if (event.eventType === "capability.fallback") {
    const capability =
      readString(event.payload.cap_id) ??
      readString(event.payload.capability) ??
      readString(event.payload.capability_requested) ??
      "unknown";
    const provider = readString(event.payload.provider) ?? readString(event.payload.resolved_binding) ?? "fallback";
    return {
      tone: "warn",
      icon: "🟡",
      label: `${taskLabel} capability fallback (${capability} → ${provider})`,
      target:
        event.taskId && event.projectId
          ? projectPath(event.projectId, `/tasks/${encodeURIComponent(event.taskId)}?tab=consultation`)
          : null,
      ariaLabel: event.taskId ? `Open ${event.taskId} consultation activity` : null
    };
  }

  if (event.eventType === "capability.missing") {
    const capability =
      readString(event.payload.cap_id) ??
      readString(event.payload.capability) ??
      readString(event.payload.capability_requested) ??
      "unknown";
    return {
      tone: "danger",
      icon: "🔴",
      label: `${taskLabel} capability missing (${capability})`,
      target:
        event.taskId && event.projectId
          ? projectPath(event.projectId, `/tasks/${encodeURIComponent(event.taskId)}?tab=consultation`)
          : null,
      ariaLabel: event.taskId ? `Open ${event.taskId} consultation activity` : null
    };
  }

  return {
    tone: "info",
    icon: "⚪",
    label: event.summary ?? `${taskLabel} ${event.eventType}`,
    target: null,
    ariaLabel: null
  };
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function formatActivityTime(value: string): string {
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) {
    return value;
  }

  const diffSeconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (diffSeconds < 60) return "just now";
  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 30) return `${diffDays}d ago`;
  return new Date(value).toLocaleString();
}
