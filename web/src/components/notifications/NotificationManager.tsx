import { useEffect, useRef } from "react";
import { useNavigate } from "react-router";

import {
  ackAttention,
  fetchAttention,
  type AttentionItem
} from "../../lib/console-api.js";
import {
  setAttentionBadge,
  showBrowserNotification
} from "../../lib/browser-notify.js";
import { projectPath } from "../../lib/project-paths.js";
import { useUIStore } from "../../stores/ui-store.js";

const DEFAULT_POLL_MS = 7_000;
const LEADER_TTL_MS = 8_000;
const LEADER_HEARTBEAT_MS = 2_000;

interface NotificationManagerProps {
  projectId: string | null;
  pollMs?: number;
}

interface AttentionTabCoordinator {
  canShowNotification: (ref: string) => boolean;
  destroy: () => void;
}

interface LeaderMessage {
  type: "hello" | "heartbeat";
  tabId: string;
  sentAt: number;
}

interface LeaderRecord {
  tabId: string;
  expiresAt: number;
}

export function NotificationManager({ projectId, pollMs = DEFAULT_POLL_MS }: NotificationManagerProps) {
  const navigate = useNavigate();
  const notificationSettings = useUIStore((state) => state.notificationSettings);
  const setAttentionUnreadCount = useUIStore((state) => state.setAttentionUnreadCount);
  const addToast = useUIStore((state) => state.addToast);

  const settingsRef = useRef(notificationSettings);
  const navigateRef = useRef(navigate);
  const addToastRef = useRef(addToast);
  const knownRefsRef = useRef<Set<string> | null>(null);
  const shownRefsRef = useRef(new Set<string>());
  const pendingAckRefsRef = useRef(new Set<string>());
  const reportedAckFailuresRef = useRef(new Set<string>());
  const permissionDeniedToastShownRef = useRef(false);

  useEffect(() => {
    settingsRef.current = notificationSettings;
  }, [notificationSettings]);

  useEffect(() => {
    navigateRef.current = navigate;
  }, [navigate]);

  useEffect(() => {
    addToastRef.current = addToast;
  }, [addToast]);

  useEffect(() => {
    knownRefsRef.current = null;
    shownRefsRef.current = new Set();
    pendingAckRefsRef.current = new Set();
    reportedAckFailuresRef.current = new Set();
    permissionDeniedToastShownRef.current = false;

    if (!projectId) {
      setAttentionUnreadCount(0);
      setAttentionBadge(0);
      return;
    }

    const coordinator = createAttentionTabCoordinator(projectId);
    let cancelled = false;
    let inFlight = false;

    const ackWithRetry = async (ref: string, userVisible: boolean) => {
      try {
        await ackAttention(projectId, ref);
        pendingAckRefsRef.current.delete(ref);
        reportedAckFailuresRef.current.delete(ref);
      } catch {
        pendingAckRefsRef.current.add(ref);
        if (userVisible || !reportedAckFailuresRef.current.has(ref)) {
          reportedAckFailuresRef.current.add(ref);
          addToastRef.current("error", "通知已打开，但标记已读失败，稍后重试");
        }
      }
    };

    const handleNotificationClick = (item: AttentionItem) => {
      try {
        window.focus();
      } catch {
        // ignore
      }
      navigateRef.current(buildAttentionNavigatePath(item, projectId));
      void ackWithRetry(item.ref, true);
    };

    const retryPendingAcks = async (currentRefs: Set<string>) => {
      const refs = Array.from(pendingAckRefsRef.current);
      for (const ref of refs) {
        if (!currentRefs.has(ref)) {
          pendingAckRefsRef.current.delete(ref);
          reportedAckFailuresRef.current.delete(ref);
          continue;
        }
        await ackWithRetry(ref, false);
      }
    };

    const tick = async () => {
      if (inFlight) {
        return;
      }
      inFlight = true;
      try {
        const response = await fetchAttention(projectId);
        if (cancelled) {
          return;
        }

        const currentRefs = new Set(response.items.map((item) => item.ref));
        setAttentionUnreadCount(response.count);
        setAttentionBadge(response.count);
        await retryPendingAcks(currentRefs);

        const previousRefs = knownRefsRef.current;
        knownRefsRef.current = currentRefs;
        if (!previousRefs) {
          return;
        }

        const candidates = response.items.filter(
          (item) =>
            item.severity === "attention" &&
            !previousRefs.has(item.ref) &&
            !shownRefsRef.current.has(item.ref)
        );
        if (!settingsRef.current.browserEnabled) {
          return;
        }

        for (const item of candidates) {
          if (!coordinator.canShowNotification(item.ref)) {
            continue;
          }
          shownRefsRef.current.add(item.ref);
          const delivery = await showBrowserNotification({
            title: item.title,
            body: item.summary,
            tag: `ccb-attention:${projectId}:${item.ref}`,
            sound: settingsRef.current.soundEnabled,
            onClick: () => handleNotificationClick(item)
          });
          if (delivery.status === "denied" && !permissionDeniedToastShownRef.current) {
            permissionDeniedToastShownRef.current = true;
            addToastRef.current("info", "浏览器通知权限已拒绝，已改用页签提醒");
          }
        }
      } catch {
        // Poll is best effort; next interval is the retry path.
      } finally {
        inFlight = false;
      }
    };

    void tick();
    const intervalId = window.setInterval(() => {
      void tick();
    }, pollMs);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
      coordinator.destroy();
    };
  }, [pollMs, projectId, setAttentionUnreadCount]);

  return null;
}

export function buildAttentionNavigatePath(item: AttentionItem, fallbackProjectId?: string | null): string {
  const projectId = item.projectId ?? fallbackProjectId ?? null;
  const scoped = (path: string) => (projectId ? projectPath(projectId, path) : path);
  if (item.cta.type === "task" && item.cta.taskId) {
    return scoped(`/tasks/${item.cta.taskId}`);
  }
  if (item.cta.type === "requirement" && item.cta.requirementId) {
    return scoped(`/requirements/${item.cta.requirementId}`);
  }
  if (item.taskId) {
    return scoped(`/tasks/${item.taskId}`);
  }
  if (item.requirementId) {
    return scoped(`/requirements/${item.requirementId}`);
  }
  return scoped("/overview");
}

export function createAttentionTabCoordinator(projectId: string): AttentionTabCoordinator {
  const tabId = createTabId();
  const channelName = `ccb-attention-leader:${projectId}`;

  try {
    if (typeof BroadcastChannel === "function") {
      return new BroadcastLeaderCoordinator(channelName, tabId);
    }
  } catch {
    // Fall through to localStorage fallback.
  }

  try {
    localStorage.setItem("__ccb_attention_probe__", "1");
    localStorage.removeItem("__ccb_attention_probe__");
    return new LocalStorageLeaderCoordinator(channelName, tabId);
  } catch {
    return new PerTabCoordinator();
  }
}

function createTabId(): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === "function") {
    return cryptoApi.randomUUID();
  }
  return `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

class BroadcastLeaderCoordinator implements AttentionTabCoordinator {
  private readonly channel: BroadcastChannel;
  private readonly peers = new Map<string, number>();
  private readonly intervalId: number;

  constructor(channelName: string, private readonly tabId: string) {
    this.channel = new BroadcastChannel(channelName);
    this.channel.onmessage = (event) => {
      this.handleMessage(event.data);
    };
    this.post("hello");
    this.intervalId = window.setInterval(() => {
      this.post("heartbeat");
      this.prunePeers();
    }, LEADER_HEARTBEAT_MS);
  }

  canShowNotification(_ref: string): boolean {
    this.prunePeers();
    const activeIds = [this.tabId, ...this.peers.keys()].sort();
    return activeIds[0] === this.tabId;
  }

  destroy() {
    window.clearInterval(this.intervalId);
    this.channel.close();
  }

  private handleMessage(value: unknown) {
    if (!isLeaderMessage(value) || value.tabId === this.tabId) {
      return;
    }
    this.peers.set(value.tabId, Date.now());
    if (value.type === "hello") {
      this.post("heartbeat");
    }
  }

  private post(type: LeaderMessage["type"]) {
    this.channel.postMessage({ type, tabId: this.tabId, sentAt: Date.now() } satisfies LeaderMessage);
  }

  private prunePeers() {
    const cutoff = Date.now() - LEADER_TTL_MS;
    for (const [peerId, lastSeen] of this.peers) {
      if (lastSeen < cutoff) {
        this.peers.delete(peerId);
      }
    }
  }
}

class LocalStorageLeaderCoordinator implements AttentionTabCoordinator {
  private readonly key: string;
  private readonly intervalId: number;
  private readonly fallback = new PerTabCoordinator();

  constructor(channelName: string, private readonly tabId: string) {
    this.key = `${channelName}:owner`;
    this.intervalId = window.setInterval(() => {
      try {
        this.refreshOwnership();
      } catch {
        // Local storage can disappear at runtime; canShowNotification will fall back per tab.
      }
    }, LEADER_HEARTBEAT_MS);
  }

  canShowNotification(ref: string): boolean {
    try {
      return this.refreshOwnership();
    } catch {
      return this.fallback.canShowNotification(ref);
    }
  }

  destroy() {
    window.clearInterval(this.intervalId);
  }

  private refreshOwnership(): boolean {
    const now = Date.now();
    const current = parseLeaderRecord(localStorage.getItem(this.key));
    if (current && current.tabId !== this.tabId && current.expiresAt > now) {
      return false;
    }

    localStorage.setItem(this.key, JSON.stringify({ tabId: this.tabId, expiresAt: now + LEADER_TTL_MS }));
    const next = parseLeaderRecord(localStorage.getItem(this.key));
    return next?.tabId === this.tabId;
  }
}

class PerTabCoordinator implements AttentionTabCoordinator {
  private readonly shownRefs = new Set<string>();

  canShowNotification(ref: string): boolean {
    if (this.shownRefs.has(ref)) {
      return false;
    }
    this.shownRefs.add(ref);
    return true;
  }

  destroy() {
    this.shownRefs.clear();
  }
}

function isLeaderMessage(value: unknown): value is LeaderMessage {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<LeaderMessage>;
  return (
    (candidate.type === "hello" || candidate.type === "heartbeat") &&
    typeof candidate.tabId === "string" &&
    typeof candidate.sentAt === "number"
  );
}

function parseLeaderRecord(value: string | null): LeaderRecord | null {
  if (!value) {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as Partial<LeaderRecord>;
    if (typeof parsed.tabId === "string" && typeof parsed.expiresAt === "number") {
      return { tabId: parsed.tabId, expiresAt: parsed.expiresAt };
    }
  } catch {
    // ignore
  }
  return null;
}
