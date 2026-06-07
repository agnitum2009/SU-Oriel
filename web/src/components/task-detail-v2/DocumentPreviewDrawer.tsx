import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";

import styles from "./DocumentPreviewDrawer.module.css";
import { MarkdownViewer } from "../shared/MarkdownViewer.js";
import { fetchDocumentDetail } from "../../lib/console-api.js";
import { useProjectPathBuilder } from "../../lib/project-paths.js";
import { getDocumentKindBadge } from "../../lib/ui-mapping.js";
import type { DocumentDetailView } from "../../types/document.js";

interface DocumentPreviewDrawerProps {
  documentId: string | null;
  onClose: () => void;
  onCopyPath: (path: string) => void;
}

export function DocumentPreviewDrawer({ documentId, onClose, onCopyPath }: DocumentPreviewDrawerProps) {
  const navigate = useNavigate();
  const toProjectPath = useProjectPathBuilder();
  const [detail, setDetail] = useState<DocumentDetailView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  const isOpen = documentId !== null;

  useEffect(() => {
    if (!documentId) {
      setDetail(null);
      setError(null);
      return undefined;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setDetail(null);
    fetchDocumentDetail(documentId)
      .then((doc) => {
        if (!cancelled) setDetail(doc);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "加载文档失败");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [documentId]);

  useEffect(() => {
    if (!isOpen) return undefined;
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButtonRef.current?.focus();

    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key === "Tab" && dialogRef.current) {
        const focusables = dialogRef.current.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
        );
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("keydown", handleKey);
      previousFocusRef.current?.focus();
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const title = detail?.title ?? (loading ? "加载中…" : "文档预览");
  const badge = detail ? getDocumentKindBadge(detail.kind) : null;

  return (
    <div
      className={styles.backdrop}
      data-testid="document-preview-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        aria-label={title}
        aria-modal="true"
        className={styles.modal}
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <header className={styles.header}>
          <h2 className={styles.title}>{title}</h2>
          <button
            aria-label="关闭"
            className={styles.closeButton}
            onClick={onClose}
            ref={closeButtonRef}
            type="button"
          >
            ✕
          </button>
        </header>

        <div className={styles.body}>
          {loading && !detail ? (
            <p className={styles.placeholder}>加载中…</p>
          ) : error ? (
            <p className={styles.error}>{error}</p>
          ) : detail ? (
            <>
              <div className={styles.meta}>
                {badge ? (
                  <span className={styles.kindBadge} data-color={badge.color}>
                    {badge.label}
                  </span>
                ) : null}
                <code className={styles.path}>{detail.path}</code>
              </div>
              <div className={styles.markdown}>
                <MarkdownViewer content={detail.content} />
              </div>
            </>
          ) : null}
        </div>

        {detail ? (
          <footer className={styles.actions}>
            <button
              aria-label="复制文档路径"
              className={styles.button}
              onClick={() => onCopyPath(detail.path)}
              type="button"
            >
              复制路径
            </button>
            <button
              aria-label="在文档页打开"
              className={styles.primaryButton}
              onClick={() => {
                navigate(toProjectPath(`/documents/${detail.id}`));
                onClose();
              }}
              type="button"
            >
              在文档页打开 →
            </button>
          </footer>
        ) : null}
      </div>
    </div>
  );
}
