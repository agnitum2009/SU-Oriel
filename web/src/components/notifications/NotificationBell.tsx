import { useEffect, useMemo, useState } from "react";

import {
  fetchAttentionSettings,
  updateAttentionSettings,
  type AttentionSettingsResponse
} from "../../lib/console-api.js";
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
  const [open, setOpen] = useState(false);
  const [projectSettings, setProjectSettings] = useState<AttentionSettingsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [permission, setPermission] = useState<BrowserNotificationPermission>(() => getBrowserNotificationPermission());
  const notificationSettings = useUIStore((state) => state.notificationSettings);
  const attentionSnapshot = useUIStore((state) => state.attentionSnapshot);
  const updateLocalSettings = useUIStore((state) => state.updateNotificationSettings);
  const addToast = useUIStore((state) => state.addToast);

  useEffect(() => {
    setOpen(false);
    setProjectSettings(null);
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
      addToast("success", dndUntil ? "已暂停 attention 通知" : "已恢复 attention 通知");
    } catch (error) {
      addToast("error", error instanceof Error ? error.message : "保存通知设置失败");
    } finally {
      setSaving(false);
    }
  };

  if (!projectId) {
    return null;
  }

  const unreadCount = attentionSnapshot?.projectId === projectId ? attentionSnapshot.count : 0;
  const countLabel = unreadCount > 99 ? "99+" : String(unreadCount);

  return (
    <div className={styles.root}>
      <button
        aria-expanded={open}
        aria-label={`通知设置，${unreadCount} 条未读`}
        className={styles.trigger}
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <span>通知</span>
        {unreadCount > 0 ? <span className={styles.badge}>{countLabel}</span> : null}
      </button>

      {open ? (
        <div aria-label="通知设置" className={styles.popover} role="dialog">
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
