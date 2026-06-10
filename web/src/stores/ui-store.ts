import { create } from "zustand";

import type { AttentionItem } from "../lib/console-api.js";

const SIDEBAR_COLLAPSED_KEY = "ccb-console:sidebar-collapsed";
const NOTIFICATION_SETTINGS_KEY = "ccb-console:notification-settings";

function loadSidebarCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

function saveSidebarCollapsed(value: boolean) {
  try {
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, value ? "1" : "0");
  } catch {
    // ignore
  }
}

interface NotificationSettings {
  browserEnabled: boolean;
  soundEnabled: boolean;
}

function loadNotificationSettings(): NotificationSettings {
  try {
    const raw = localStorage.getItem(NOTIFICATION_SETTINGS_KEY);
    if (!raw) {
      return { browserEnabled: true, soundEnabled: true };
    }
    const parsed = JSON.parse(raw) as Partial<NotificationSettings>;
    return {
      browserEnabled: parsed.browserEnabled !== false,
      soundEnabled: parsed.soundEnabled !== false
    };
  } catch {
    return { browserEnabled: true, soundEnabled: true };
  }
}

function saveNotificationSettings(value: NotificationSettings) {
  try {
    localStorage.setItem(NOTIFICATION_SETTINGS_KEY, JSON.stringify(value));
  } catch {
    // ignore
  }
}

interface ToastItem {
  id: string;
  type: "success" | "error" | "info";
  message: string;
}

export interface AttentionSnapshot {
  projectId: string;
  items: AttentionItem[];
  count: number;
  dndActive: boolean;
  dndUntil: string | null;
  fetchedAt: string;
}

interface UIStore {
  sidebarCollapsed: boolean;
  slidePanelOpen: boolean;
  slidePanelContent: { type: "task"; taskId: string } | null;
  modalOpen: boolean;
  modalType: "create-project" | "create-requirement" | "ai-cli-settings" | null;
  /** main 终端弹窗打开请求(请求-消费通道,独立于 modalOpen/modalType 互斥机制)。 */
  mainTerminalOpenRequest: { projectId: string } | null;
  toasts: ToastItem[];
  anchorResetEpochs: Record<string, number>;
  notificationSettings: NotificationSettings;
  attentionSnapshot: AttentionSnapshot | null;
  toggleSidebar: () => void;
  openTaskPanel: (taskId: string) => void;
  closeSlidePanel: () => void;
  openModal: (type: UIStore["modalType"]) => void;
  closeModal: () => void;
  requestOpenMainTerminal: (projectId: string) => void;
  clearMainTerminalOpenRequest: () => void;
  addToast: (type: ToastItem["type"], message: string) => void;
  removeToast: (id: string) => void;
  bumpAnchorResetEpoch: (taskId: string) => void;
  updateNotificationSettings: (patch: Partial<NotificationSettings>) => void;
  setAttentionSnapshot: (snapshot: AttentionSnapshot) => void;
  clearAttentionSnapshot: () => void;
  removeAttentionRefs: (refs: string[]) => void;
}

export const useUIStore = create<UIStore>()((set) => ({
  sidebarCollapsed: loadSidebarCollapsed(),
  slidePanelOpen: false,
  slidePanelContent: null,
  modalOpen: false,
  modalType: null,
  mainTerminalOpenRequest: null,
  toasts: [],
  anchorResetEpochs: {},
  notificationSettings: loadNotificationSettings(),
  attentionSnapshot: null,
  toggleSidebar: () => {
    set((state) => {
      const next = !state.sidebarCollapsed;
      saveSidebarCollapsed(next);
      return { sidebarCollapsed: next };
    });
  },
  openTaskPanel: (taskId) => {
    set({
      slidePanelOpen: true,
      slidePanelContent: { type: "task", taskId }
    });
  },
  closeSlidePanel: () => {
    set({
      slidePanelOpen: false,
      slidePanelContent: null
    });
  },
  openModal: (type) => {
    set({
      modalOpen: true,
      modalType: type
    });
  },
  closeModal: () => {
    set({
      modalOpen: false,
      modalType: null
    });
  },
  requestOpenMainTerminal: (projectId) => {
    set({ mainTerminalOpenRequest: { projectId } });
  },
  clearMainTerminalOpenRequest: () => {
    set({ mainTerminalOpenRequest: null });
  },
  addToast: (type, message) => {
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    set((state) => ({
      toasts: [...state.toasts, { id, type, message }]
    }));
  },
  removeToast: (id) => {
    set((state) => ({
      toasts: state.toasts.filter((toast) => toast.id !== id)
    }));
  },
  bumpAnchorResetEpoch: (taskId) => {
    set((state) => ({
      anchorResetEpochs: {
        ...state.anchorResetEpochs,
        [taskId]: (state.anchorResetEpochs[taskId] ?? 0) + 1
      }
    }));
  },
  updateNotificationSettings: (patch) => {
    set((state) => {
      const next = { ...state.notificationSettings, ...patch };
      saveNotificationSettings(next);
      return { notificationSettings: next };
    });
  },
  setAttentionSnapshot: (snapshot) => {
    set({
      attentionSnapshot: {
        ...snapshot,
        count: Math.max(0, snapshot.count)
      }
    });
  },
  clearAttentionSnapshot: () => {
    set({ attentionSnapshot: null });
  },
  removeAttentionRefs: (refs) => {
    const refSet = new Set(refs);
    if (refSet.size === 0) {
      return;
    }
    set((state) => {
      const snapshot = state.attentionSnapshot;
      if (!snapshot) {
        return {};
      }
      const items = snapshot.items.filter((item) => !refSet.has(item.ref));
      return {
        attentionSnapshot: {
          ...snapshot,
          items,
          count: items.length
        }
      };
    });
  }
}));
