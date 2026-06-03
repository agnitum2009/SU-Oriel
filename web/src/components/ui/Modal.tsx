import { useEffect } from "react";
import type { ReactNode } from "react";

import styles from "./Modal.module.css";

type ModalSize = "sm" | "md" | "lg" | "xl";

interface ModalProps {
  open: boolean;
  title: string;
  children: ReactNode;
  contentClassName?: string;
  footer?: ReactNode;
  onClose: () => void;
  size?: ModalSize;
}

export function Modal(props: ModalProps) {
  useEffect(() => {
    if (!props.open) {
      return;
    }

    // 统一支持 ESC 关闭，保证弹窗行为和实施规格一致。
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        props.onClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [props.onClose, props.open]);

  if (!props.open) {
    return null;
  }

  const size = props.size ?? "sm";
  const sizeClassMap: Record<ModalSize, string> = {
    sm: styles.modal_sm,
    md: styles.modal_md,
    lg: styles.modal_lg,
    xl: styles.modal_xl
  };

  return (
    <div className={styles.overlay} onClick={props.onClose} role="presentation">
      <div
        aria-label={props.title}
        aria-modal="true"
        className={`${styles.modal} ${sizeClassMap[size]}`}
        onClick={(event) => event.stopPropagation()}
        role="dialog"
      >
        <div className={styles.header}>
          <div>{props.title}</div>
          <button className={styles.closeButton} onClick={props.onClose} type="button">
            ×
          </button>
        </div>
        <div className={`${styles.content} ${props.contentClassName ?? ""}`}>{props.children}</div>
        {props.footer ? <div className={styles.footer}>{props.footer}</div> : null}
      </div>
    </div>
  );
}
