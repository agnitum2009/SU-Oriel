import { useEffect, useRef } from "react";
import type { ReactNode, RefObject } from "react";

import styles from "./Modal.module.css";

type ModalSize = "sm" | "md" | "lg" | "xl" | "reader";

interface ModalProps {
  open: boolean;
  title: string;
  children: ReactNode;
  contentClassName?: string;
  footer?: ReactNode;
  onClose: () => void;
  size?: ModalSize;
  /** 打开时聚焦的元素;缺省聚焦关闭按钮(不假设首个可聚焦元素是内容,如编辑器)。 */
  initialFocus?: RefObject<HTMLElement | null>;
}

export function Modal(props: ModalProps) {
  const { open, onClose, initialFocus } = props;
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  // 焦点管理只在打开/关闭切换时跑,避免 onClose 等内联回调变化导致焦点抖动。
  useEffect(() => {
    if (!open) {
      return;
    }
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    // 默认聚焦关闭按钮 / dialog,不假设首个可聚焦元素就是内容(EasyMDE 等会接管视口)。
    (initialFocus?.current ?? closeButtonRef.current ?? dialogRef.current)?.focus();
    return () => {
      previousFocusRef.current?.focus();
    };
  }, [open, initialFocus]);

  // ESC 关闭 + focus trap;依赖 onClose,单独成 effect 只增减监听,不触动焦点。
  useEffect(() => {
    if (!open) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key === "Tab" && dialogRef.current) {
        const focusables = dialogRef.current.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
        );
        if (focusables.length === 0) {
          event.preventDefault();
          dialogRef.current.focus();
          return;
        }
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement;
        if (event.shiftKey && active === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && active === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, onClose]);

  if (!open) {
    return null;
  }

  const size = props.size ?? "sm";
  const sizeClassMap: Record<ModalSize, string> = {
    sm: styles.modal_sm,
    md: styles.modal_md,
    lg: styles.modal_lg,
    xl: styles.modal_xl,
    reader: styles.modal_reader
  };

  return (
    <div className={styles.overlay} onClick={onClose} role="presentation">
      <div
        aria-label={props.title}
        aria-modal="true"
        className={`${styles.modal} ${sizeClassMap[size]}`}
        onClick={(event) => event.stopPropagation()}
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <div className={styles.header}>
          <div>{props.title}</div>
          <button aria-label="关闭" className={styles.closeButton} onClick={onClose} ref={closeButtonRef} type="button">
            ×
          </button>
        </div>
        <div className={`${styles.content} ${props.contentClassName ?? ""}`}>{props.children}</div>
        {props.footer ? <div className={styles.footer}>{props.footer}</div> : null}
      </div>
    </div>
  );
}
