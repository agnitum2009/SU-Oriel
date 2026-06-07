import { useEffect, useMemo, useState } from "react";

import { fetchTerminalDescriptor } from "../../lib/console-api.js";
import type { SlotTerminalWebSocketFactory } from "../../lib/slot-terminal-ws.js";
import type {
  SlotTerminalDescriptor,
  SlotTerminalPaneRole,
  SlotTerminalPaneTarget,
  SlotTerminalTarget
} from "../../types/slot-terminal.js";
import { SlotTerminalSurface } from "./SlotTerminalSurface.js";
import { TerminalPaneTabs } from "./TerminalPaneTabs.js";
import styles from "./MainTerminalPanel.module.css";

const MAIN_GROUP = "main";
const MAIN_FALLBACK = "main 会话未启动，请在 ccb 启动后重试";

export interface MainTerminalPanelProps {
  projectId: string;
  mainState?: string | null;
  webSocketFactory?: SlotTerminalWebSocketFactory;
}

type ResolverState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; descriptor: SlotTerminalDescriptor }
  | { status: "fallback"; message: string };

export function MainTerminalPanel(props: MainTerminalPanelProps) {
  const [resolverState, setResolverState] = useState<ResolverState>({ status: "idle" });
  const [resolverEpoch, setResolverEpoch] = useState(0);
  const [activeRole, setActiveRole] = useState<SlotTerminalPaneRole>("claude");
  const target = useMemo<SlotTerminalTarget>(
    () => ({
      kind: "agentGroup",
      projectId: props.projectId,
      group: MAIN_GROUP
    }),
    [props.projectId]
  );

  useEffect(() => {
    if (!props.projectId) {
      setResolverState({ status: "idle" });
      setActiveRole("claude");
      return;
    }

    let cancelled = false;
    setResolverState({ status: "loading" });
    void fetchTerminalDescriptor(target)
      .then((descriptor) => {
        if (cancelled) {
          return;
        }
        if (descriptor.panes.length === 0) {
          setResolverState({ status: "fallback", message: MAIN_FALLBACK });
          return;
        }
        setResolverState({ status: "ready", descriptor });
        setActiveRole((current) => (descriptor.panes.some((pane) => pane.role === current) ? current : descriptor.panes[0].role));
      })
      .catch(() => {
        if (!cancelled) {
          setResolverState({ status: "fallback", message: MAIN_FALLBACK });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [props.projectId, resolverEpoch, target]);

  const panesByRole = useMemo(() => {
    const panes = resolverState.status === "ready" ? resolverState.descriptor.panes : [];
    return new Map<SlotTerminalPaneRole, SlotTerminalPaneTarget>(panes.map((pane) => [pane.role, pane]));
  }, [resolverState]);

  if (resolverState.status !== "ready") {
    return (
      <div className={styles.panel} data-testid="main-terminal-panel">
        <p className={styles.primary}>main · {props.mainState ?? "unknown"}</p>
        <p className={styles.text}>{resolverState.status === "loading" ? "正在解析 main 终端..." : "main agent 组终端"}</p>
        {resolverState.status === "fallback" ? (
          <>
            <p className={styles.fallbackReason}>{resolverState.message}</p>
            <button
              className={styles.retryButton}
              onClick={() => setResolverEpoch((epoch) => epoch + 1)}
              type="button"
            >
              重试
            </button>
          </>
        ) : null}
      </div>
    );
  }

  const activePane = panesByRole.get(activeRole) ?? resolverState.descriptor.panes[0];
  const activePaneRole = activePane.role;

  return (
    <div className={styles.panel} data-testid="main-terminal-panel">
      <div className={styles.summary}>
        <p className={styles.primary}>main · {props.mainState ?? "available"}</p>
        <p className={styles.writeWarning} role="status">
          正在写 {resolverState.descriptor.slotId} 的 {activePaneRole}
        </p>
      </div>
      <TerminalPaneTabs activeRole={activePaneRole} onSelectRole={setActiveRole} panesByRole={panesByRole} />
      <div className={styles.surfaceWrap} data-testid="main-terminal-surface-wrap" role="tabpanel">
        <SlotTerminalSurface
          active
          key={`${resolverState.descriptor.slotId}:${activePaneRole}`}
          pane={activePaneRole}
          target={target}
          title={`${resolverState.descriptor.slotId} · ${activePaneRole}`}
          webSocketFactory={props.webSocketFactory}
        />
      </div>
    </div>
  );
}
