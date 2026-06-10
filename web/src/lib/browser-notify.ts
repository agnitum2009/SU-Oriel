export type BrowserNotificationPermission = NotificationPermission | "unsupported";

export interface BrowserNotificationInput {
  title: string;
  body?: string;
  tag?: string;
  sound?: boolean;
  onClick?: () => void;
}

export interface BrowserNotificationDelivery {
  status: "shown" | "denied" | "unsupported";
  notification?: Notification;
}

let permissionRequested = false;
let baseTitle = typeof document === "undefined" ? "" : document.title;
let originalFaviconHref: string | null | undefined;

function getNotificationConstructor(): typeof Notification | null {
  return typeof globalThis.Notification === "function" ? globalThis.Notification : null;
}

export function getBrowserNotificationPermission(): BrowserNotificationPermission {
  const NotificationCtor = getNotificationConstructor();
  return NotificationCtor ? NotificationCtor.permission : "unsupported";
}

export async function requestBrowserNotificationPermissionOnce(): Promise<BrowserNotificationPermission> {
  const NotificationCtor = getNotificationConstructor();
  if (!NotificationCtor) {
    return "unsupported";
  }

  if (NotificationCtor.permission === "default" && !permissionRequested) {
    permissionRequested = true;
    if (typeof NotificationCtor.requestPermission === "function") {
      return await NotificationCtor.requestPermission();
    }
  }

  return NotificationCtor.permission;
}

export async function showBrowserNotification(
  input: BrowserNotificationInput
): Promise<BrowserNotificationDelivery> {
  const permission = await requestBrowserNotificationPermissionOnce();
  if (permission === "denied") {
    return { status: "denied" };
  }
  if (permission !== "granted") {
    return { status: "unsupported" };
  }

  const NotificationCtor = getNotificationConstructor();
  if (!NotificationCtor) {
    return { status: "unsupported" };
  }

  try {
    const notification = new NotificationCtor(input.title, {
      body: input.body,
      tag: input.tag
    });
    notification.onclick = () => {
      input.onClick?.();
      notification.close();
    };
    if (input.sound) {
      playAttentionSound();
    }
    return { status: "shown", notification };
  } catch {
    return { status: "unsupported" };
  }
}

export function setAttentionBadge(count: number) {
  if (typeof document === "undefined") {
    return;
  }

  const normalizedCount = Math.max(0, Math.floor(count));
  if (baseTitle.length === 0) {
    baseTitle = document.title.replace(/^\(\d+\)\s+/, "");
  }

  document.title = normalizedCount > 0 ? `(${normalizedCount}) ${baseTitle}` : baseTitle;
  updateFaviconBadge(normalizedCount);
}

export function resetBrowserNotifyForTests() {
  permissionRequested = false;
  baseTitle = typeof document === "undefined" ? "" : document.title.replace(/^\(\d+\)\s+/, "");
  originalFaviconHref = undefined;
}

export function playAttentionSound() {
  const maybeWebkit = globalThis as typeof globalThis & { webkitAudioContext?: typeof AudioContext };
  const AudioContextCtor = globalThis.AudioContext ?? maybeWebkit.webkitAudioContext;
  if (AudioContextCtor) {
    try {
      const context = new AudioContextCtor();
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = 660;
      gain.gain.value = 0.03;
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start();
      oscillator.stop(context.currentTime + 0.12);
      oscillator.addEventListener("ended", () => {
        void context.close().catch(() => undefined);
      });
      return;
    } catch {
      // Fall through to Audio fallback.
    }
  }

  if (typeof Audio === "function") {
    try {
      const audio = new Audio();
      audio.volume = 0.2;
      void audio.play().catch(() => undefined);
    } catch {
      // Sound is best effort.
    }
  }
}

function updateFaviconBadge(count: number) {
  const link = ensureFaviconLink();
  if (!link) {
    return;
  }

  if (originalFaviconHref === undefined) {
    originalFaviconHref = link.getAttribute("href");
  }

  if (count <= 0) {
    if (originalFaviconHref) {
      link.setAttribute("href", originalFaviconHref);
    }
    link.removeAttribute("data-ccb-attention-badge");
    return;
  }

  const label = count > 99 ? "99+" : String(count);
  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">',
    '<rect width="64" height="64" rx="14" fill="#111827"/>',
    '<circle cx="46" cy="18" r="14" fill="#dc2626"/>',
    `<text x="46" y="23" text-anchor="middle" font-family="Arial, sans-serif" font-size="14" font-weight="700" fill="#ffffff">${label}</text>`,
    "</svg>"
  ].join("");
  link.setAttribute("href", `data:image/svg+xml,${encodeURIComponent(svg)}`);
  link.setAttribute("data-ccb-attention-badge", "true");
}

function ensureFaviconLink(): HTMLLinkElement | null {
  if (typeof document === "undefined") {
    return null;
  }

  const existing = document.querySelector<HTMLLinkElement>('link[rel~="icon"]');
  if (existing) {
    return existing;
  }

  const link = document.createElement("link");
  link.rel = "icon";
  document.head.appendChild(link);
  return link;
}
