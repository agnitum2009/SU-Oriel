import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";

import {
  ackAttention,
  fetchAttentionSettings,
  updateAttentionSettings,
  type AttentionItem,
  type AttentionSettingsResponse
} from "../../lib/console-api.js";
import { buildAttentionNavigatePath } from "../../lib/attention-navigation.js";
import {
  getBrowserNotificationPermission,
  type BrowserNotificationPermission
} from "../../lib/browser-notify.js";
import { useUIStore } from "../../stores/ui-store.js";
import styles from "./NotificationBell.module.css";

interface NotificationBellProps {
  projectId: string | null;
}

export function NotificationBell({ projectId }: NotificationBellProps) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [projectSettings, setProjectSettings] = useState<AttentionSettingsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [markingAll, setMarkingAll] = useState(false);
  const [ackingRefs, setAckingRefs] = useState<Set<string>>(() => new Set());
  const [permission, setPermission] = useState<BrowserNotificationPermission>(() => getBrowserNotificationPermission());
  const notificationSettings = useUIStore((state) => state.notificationSettings);
  const attentionSnapshot = useUIStore((state) => state.attentionSnapshot);
  const updateLocalSettings = useUIStore((state) => state.updateNotificationSettings);
  const setAttentionSnapshot = useUIStore((state) => state.setAttentionSnapshot);
  const removeAttentionRefs = useUIStore((state) => state.removeAttentionRefs);
  const addToast = useUIStore((state) => state.addToast);

  useEffect(() => {
    setOpen(false);
    setProjectSettings(null);
    setMarkingAll(false);
    setAckingRefs(new Set());
  }, [projectId]);

  useEffect(() => {
    if (!open || !projectId) {
      return;
    }

    let cancelled = false;
    setLoading(true);
    setPermission(getBrowserNotificationPermission());
    fetchAttentionSettings(projectId)
      .then((settings) => {
        if (!cancelled) {
          setProjectSettings(settings);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          addToast("error", error instanceof Error ? error.message : "加载通知设置失败");
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [addToast, open, projectId]);

  const dndLabel = useMemo(() => {
    const dndUntil = projectSettings?.dnd_until;
    if (!dndUntil) {
      return "未暂停";
    }
    const until = new Date(dndUntil);
    if (Number.isNaN(until.getTime()) || until.getTime() <= Date.now()) {
      return "未暂停";
    }
    return `暂停到 ${formatLocalDateTime(until)}`;
  }, [projectSettings]);

  const saveDnd = async (dndUntil: string | null) => {
    if (!projectId) {
      return;
    }

    setSaving(true);
    try {
      const next = await updateAttentionSettings(projectId, { dnd_until: dndUntil });
      setProjectSettings(next);
      if (attentionSnapshot?.projectId === projectId) {
        setAttentionSnapshot({
          ...attentionSnapshot,
          dndActive: isDndActive(next.dnd_until),
          dndUntil: next.dnd_until,
          fetchedAt: new Date().toISOString()
        });
      }
      addToast("success", dndUntil ? "已暂停 attention 通知" : "已恢复 attention 通知");
    } catch (error) {
      addToast("error", error instanceof Error ? error.message : "保存通知设置失败");
    } finally {
      setSaving(false);
    }
  };

  const ackItem = async (item: AttentionItem) => {
    if (!projectId || ackingRefs.has(item.ref)) {
      return;
    }

    navigate(buildAttentionNavigatePath(item, projectId));
    setAckingRefs((refs) => new Set(refs).add(item.ref));
    try {
      await ackAttention(projectId, item.ref);
      removeAttentionRefs([item.ref]);
    } catch {
      addToast("error", "标记已读失败");
    } finally {
      setAckingRefs((refs) => {
        const next = new Set(refs);
        next.delete(item.ref);
        return next;
      });
    }
  };

  const markAllRead = async (items: AttentionItem[]) => {
    if (!projectId || items.length === 0 || markingAll) {
      return;
    }

    setMarkingAll(true);
    try {
      const results = await Promise.allSettled(
        items.map(async (item) => {
          await ackAttention(projectId, item.ref);
          return item.ref;
        })
      );
      const successfulRefs = results
        .filter((result): result is PromiseFulfilledResult<string> => result.status === "fulfilled")
        .map((result) => result.value);
      if (successfulRefs.length > 0) {
        removeAttentionRefs(successfulRefs);
      }
      const failedCount = results.length - successfulRefs.length;
      if (failedCount > 0) {
        addToast("error", `${failedCount} 条标记失败`);
      }
    } finally {
      setMarkingAll(false);
    }
  };

  if (!projectId) {
    return null;
  }

  const scopedSnapshot = attentionSnapshot?.projectId === projectId ? attentionSnapshot : null;
  const items = scopedSnapshot?.items ?? [];
  const unreadCount = scopedSnapshot?.count ?? 0;
  const countLabel = unreadCount > 99 ? "99+" : String(unreadCount);
  const dndUntilLabel = scopedSnapshot?.dndUntil ? formatLocalDateTime(new Date(scopedSnapshot.dndUntil)) : null;

  return (
    <div className={styles.root}>
      <button
        aria-expanded={open}
        aria-label="通知"
        className={styles.trigger}
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <span>通知</span>
        {unreadCount > 0 ? <span className={styles.badge}>{countLabel}</span> : null}
      </button>

      {open ? (
        <div aria-label="通知" className={styles.popover} role="dialog">
          <div className={styles.inboxHeader}>
            <div>
              <div className={styles.inboxTitle}>通知</div>
              <div className={styles.meta}>{unreadCount} 条未读</div>
            </div>
            <button
              className={styles.markAllButton}
              disabled={items.length === 0 || markingAll}
              onClick={() => void markAllRead(items)}
              type="button"
            >
              全部已读
            </button>
          </div>

          {items.length > 0 ? (
            <ul className={styles.messageList}>
              {items.map((item) => (
                <li className={styles.messageItem} key={item.ref}>
                  <button
                    className={styles.messageButton}
                    disabled={ackingRefs.has(item.ref)}
                    onClick={() => void ackItem(item)}
                    type="button"
                  >
                    <span className={`${styles.severityDot} ${severityClass(item.severity, styles)}`} />
                    <span className={styles.messageContent}>
                      <span className={styles.messageTopline}>
                        <span className={styles.messageTitle}>{item.title}</span>
                        <span className={styles.messageTime}>{formatRelativeTime(item.createdAt)}</span>
                      </span>
                      <span className={styles.messageSummary}>{item.summary}</span>
                    </span>
                    <span className={styles.severityLabel}>{formatSeverity(item.severity)}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className={styles.emptyState}>暂无未读通知</div>
          )}

          {scopedSnapshot?.dndActive ? (
            <div className={styles.dndBanner}>
              {dndUntilLabel ? `已暂停投递至 ${dndUntilLabel}，消息仍可见` : "已暂停投递，消息仍可见"}
            </div>
          ) : null}

          <details className={styles.settingsDetails}>
            <summary className={styles.settingsSummary}>通知设置</summary>
            <div className={styles.section}>
              <div className={styles.sectionTitle}>投递</div>
              <label className={styles.switchRow}>
                <input
                  checked={notificationSettings.browserEnabled}
                  onChange={(event) => updateLocalSettings({ browserEnabled: event.target.checked })}
                  type="checkbox"
                />
                <span>浏览器通知</span>
              </label>
              <label className={styles.switchRow}>
                <input
                  checked={notificationSettings.soundEnabled}
                  onChange={(event) => updateLocalSettings({ soundEnabled: event.target.checked })}
                  type="checkbox"
                />
                <span>声音</span>
              </label>
              <div className={styles.meta}>权限：{formatPermission(permission)}</div>
            </div>

            <div className={styles.section}>
              <div className={styles.sectionTitle}>项目暂停</div>
              <div className={styles.meta}>{loading ? "读取中..." : dndLabel}</div>
              <div className={styles.buttonRow}>
                <button
                  className={styles.smallButton}
                  disabled={saving}
                  onClick={() => void saveDnd(new Date(Date.now() + 60 * 60 * 1000).toISOString())}
                  type="button"
                >
                  1 小时
                </button>
                <button
                  className={styles.smallButton}
                  disabled={saving}
                  onClick={() => void saveDnd(new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString())}
                  type="button"
                >
                  24 小时
                </button>
                <button
                  className={styles.smallButton}
                  disabled={saving}
                  onClick={() => void saveDnd(null)}
                  type="button"
                >
                  恢复
                </button>
              </div>
            </div>
          </details>
        </div>
      ) : null}
    </div>
  );
}

function formatPermission(permission: BrowserNotificationPermission): string {
  if (permission === "granted") return "已允许";
  if (permission === "denied") return "已拒绝";
  if (permission === "default") return "未询问";
  return "不支持";
}

function formatLocalDateTime(date: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function formatRelativeTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const diffMs = Math.max(0, Date.now() - date.getTime());
  const diffMinutes = Math.floor(diffMs / 60_000);
  if (diffMinutes < 1) return "刚刚";
  if (diffMinutes < 60) return `${diffMinutes} 分钟前`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours} 小时前`;
  return formatLocalDateTime(date);
}

function formatSeverity(severity: AttentionItem["severity"]): string {
  if (severity === "attention") return "需处理";
  if (severity === "warning") return "警示";
  return "通知";
}

function severityClass(severity: AttentionItem["severity"], classes: typeof styles): string {
  if (severity === "attention") return classes.attention;
  if (severity === "warning") return classes.warning;
  return classes.info;
}

function isDndActive(value: string | null): boolean {
  if (!value) {
    return false;
  }
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.getTime() > Date.now();
}
