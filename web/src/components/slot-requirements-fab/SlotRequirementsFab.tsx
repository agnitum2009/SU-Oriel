import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";

import { fetchSlots } from "../../lib/console-api.js";
import { stripProjectPathPrefix, useProjectPathBuilder } from "../../lib/project-paths.js";
import { useProjectStore } from "../../stores/project-store.js";
import { deriveBoundRequirementItems, type BoundRequirementItem } from "./deriveBoundRequirementItems.js";
import styles from "./SlotRequirementsFab.module.css";

type LoadState = "idle" | "loading" | "loaded" | "error";

function matchRequirementId(pathname: string): string | null {
  const matched = stripProjectPathPrefix(pathname).match(/^\/requirements\/([^/]+)/);
  return matched ? matched[1] : null;
}

/**
 * Global bottom-right entry that lists the requirements currently bound to a slot
 * (lazy-loaded on open) and navigates to a requirement's detail page on click.
 * Read-only: it only consumes the existing slots projection. Hidden when no
 * project is selected; renders an empty state when nothing is bound.
 */
export function SlotRequirementsFab() {
  const selectedProjectId = useProjectStore((state) => state.selectedProjectId);
  const navigate = useNavigate();
  const location = useLocation();
  const toProjectPath = useProjectPathBuilder();

  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<BoundRequirementItem[]>([]);
  const [loadState, setLoadState] = useState<LoadState>("idle");
  // Monotonic request id: any in-flight response whose id !== current is stale
  // (project switched or a newer request fired) and must be discarded.
  const requestRef = useRef(0);

  const currentRequirementId = matchRequirementId(location.pathname);

  const load = useCallback(async () => {
    if (!selectedProjectId) {
      return;
    }
    const requestId = ++requestRef.current;
    setLoadState("loading");
    try {
      const projection = await fetchSlots(selectedProjectId);
      if (requestRef.current !== requestId) {
        return; // stale response — discard
      }
      setItems(deriveBoundRequirementItems(projection));
      setLoadState("loaded");
    } catch {
      if (requestRef.current !== requestId) {
        return;
      }
      setItems([]);
      setLoadState("error");
    }
  }, [selectedProjectId]);

  // Project switch: close + clear the panel and invalidate any in-flight response.
  useEffect(() => {
    setOpen(false);
    setItems([]);
    setLoadState("idle");
    requestRef.current += 1;
  }, [selectedProjectId]);

  const toggle = useCallback(() => {
    setOpen((prev) => {
      const next = !prev;
      if (next) {
        void load();
      }
      return next;
    });
  }, [load]);

  const select = useCallback(
    (requirementId: string) => {
      setOpen(false);
      navigate(toProjectPath(`/requirements/${requirementId}`));
    },
    [navigate, toProjectPath]
  );

  if (!selectedProjectId) {
    return null;
  }

  return (
    <div className={styles.root}>
      {open && (
        <div className={styles.panel} role="dialog" aria-label="绑定 slot 的需求">
          <div className={styles.panelHeader}>
            <span>Slot 中的需求</span>
            <button
              type="button"
              className={styles.iconButton}
              onClick={() => void load()}
              aria-label="刷新"
            >
              ⟳
            </button>
          </div>
          <div className={styles.panelBody}>
            {loadState === "loading" && <div className={styles.hint}>加载中…</div>}
            {loadState === "error" && (
              <div className={styles.hint}>
                <span>加载失败</span>
                <button type="button" className={styles.retry} onClick={() => void load()}>
                  重试
                </button>
              </div>
            )}
            {loadState === "loaded" && items.length === 0 && (
              <div className={styles.hint}>暂无绑定 slot 的需求</div>
            )}
            {loadState === "loaded" &&
              items.map((item) => {
                const isCurrent = item.requirementId === currentRequirementId;
                return (
                  <button
                    type="button"
                    key={item.requirementId}
                    className={`${styles.item} ${isCurrent ? styles.itemCurrent : ""}`}
                    onClick={() => select(item.requirementId)}
                    disabled={isCurrent}
                    title={item.title}
                  >
                    <span className={styles.itemTitle}>{item.title}</span>
                    <span className={styles.chips}>
                      {isCurrent && <span className={styles.currentChip}>当前</span>}
                      {item.slots.map((slot) => (
                        <span key={slot.slotId} className={styles.chip}>
                          {slot.slotId}·{slot.state}
                        </span>
                      ))}
                    </span>
                  </button>
                );
              })}
          </div>
        </div>
      )}
      <button
        type="button"
        className={styles.fab}
        onClick={toggle}
        aria-expanded={open}
        aria-label="绑定 slot 的需求快捷入口"
      >
        ⧉
      </button>
    </div>
  );
}
