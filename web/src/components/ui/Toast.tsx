import { useEffect, type CSSProperties } from "react";

import { useUIStore } from "../../stores/ui-store.js";
import styles from "./Toast.module.css";

export function ToastViewport({ reservedBottomPx = 0 }: { reservedBottomPx?: number } = {}) {
  const toasts = useUIStore((state) => state.toasts);
  const removeToast = useUIStore((state) => state.removeToast);

  useEffect(() => {
    if (toasts.length === 0) {
      return;
    }

    const timers = toasts.map((toast) =>
      window.setTimeout(() => {
        removeToast(toast.id);
      }, 3000)
    );

    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [removeToast, toasts]);

  return (
    <div
      className={styles.viewport}
      style={{ "--toast-reserved-bottom": `${reservedBottomPx}px` } as CSSProperties}
    >
      {toasts.map((toast) => (
        <div className={`${styles.toast} ${styles[toast.type]}`} key={toast.id}>
          {toast.message}
        </div>
      ))}
    </div>
  );
}
