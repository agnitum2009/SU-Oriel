import { useEffect, useMemo, useState } from "react";

import { Button } from "../ui/Button.js";
import { fetchTerminalDescriptor } from "../../lib/console-api.js";
import { useProjectPathBuilder } from "../../lib/project-paths.js";
import type { SlotTerminalWebSocketFactory } from "../../lib/slot-terminal-ws.js";
import type {
  SlotTerminalDescriptor,
  SlotTerminalPaneRole,
  SlotTerminalPaneTarget,
  SlotTerminalTarget
} from "../../types/slot-terminal.js";
import { SlotTerminalSurface } from "./SlotTerminalSurface.js";
import { TerminalPaneTabs } from "./TerminalPaneTabs.js";
import styles from "./SlotTerminalPanel.module.css";

export interface SlotTerminalPanelSlotView {
  slotId: string;
  state: string;
}

export interface SlotTerminalPanelProps {
  projectId: string;
  requirementId: string;
  requirementSlot: SlotTerminalPanelSlotView | null;
  slotLoading: boolean;
  slotAction: "bind" | "release" | null;
  webSocketFactory?: SlotTerminalWebSocketFactory;
}

type ResolverState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; descriptor: SlotTerminalDescriptor }
  | { status: "fallback"; message?: string };

export function SlotTerminalPanel(props: SlotTerminalPanelProps) {
  const [resolverState, setResolverState] = useState<ResolverState>({ status: "idle" });
  const [activeRole, setActiveRole] = useState<SlotTerminalPaneRole>("claude");
  const target = useMemo<SlotTerminalTarget>(
    () => ({
      kind: "requirement",
      projectId: props.projectId,
      requirementId: props.requirementId
    }),
    [props.projectId, props.requirementId]
  );

  useEffect(() => {
    if (!props.requirementSlot) {
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
          setResolverState({ status: "fallback", message: "slot terminal panes not found" });
          return;
        }
        setResolverState({ status: "ready", descriptor });
        setActiveRole((current) => (descriptor.panes.some((pane) => pane.role === current) ? current : descriptor.panes[0].role));
      })
      .catch((error) => {
        if (!cancelled) {
          setResolverState({ status: "fallback", message: error instanceof Error ? error.message : "slot terminal unavailable" });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [target, props.requirementSlot?.slotId]);

  const panesByRole = useMemo(() => {
    const panes = resolverState.status === "ready" ? resolverState.descriptor.panes : [];
    return new Map<SlotTerminalPaneRole, SlotTerminalPaneTarget>(panes.map((pane) => [pane.role, pane]));
  }, [resolverState]);

  if (resolverState.status !== "ready") {
    return (
      <FallbackPanel
        message={resolverState.status === "loading" ? "正在解析 slot 终端..." : resolverState.status === "fallback" ? resolverState.message : undefined}
        requirementSlot={props.requirementSlot}
        slotAction={props.slotAction}
        slotLoading={props.slotLoading || resolverState.status === "loading"}
      />
    );
  }

  const activePane = panesByRole.get(activeRole) ?? resolverState.descriptor.panes[0];
  const activePaneRole = activePane.role;

  return (
    <div className={styles.panel} data-testid="slot-terminal-panel">
      <div className={styles.summary}>
        <p className={styles.primary}>
          已绑定 {props.requirementSlot?.slotId ?? resolverState.descriptor.slotId} · {props.requirementSlot?.state ?? "bound"}
        </p>
        <p className={styles.writeWarning} role="status">
          正在写 {resolverState.descriptor.slotId} 的 {activePaneRole}
        </p>
      </div>
      <TerminalPaneTabs activeRole={activePaneRole} onSelectRole={setActiveRole} panesByRole={panesByRole} />
      <div className={styles.surfaceWrap} role="tabpanel">
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

function FallbackPanel(props: {
  requirementSlot: SlotTerminalPanelSlotView | null;
  slotLoading: boolean;
  slotAction: "bind" | "release" | null;
  message?: string;
}) {
  return (
    <div className={styles.panel} data-testid="slot-terminal-panel">
      <p className={styles.primary}>
        {props.slotAction || props.slotLoading
          ? "操作中..."
          : props.requirementSlot
            ? `已绑定 ${props.requirementSlot.slotId} · ${props.requirementSlot.state}`
            : "未绑定 slot"}
      </p>
      <p className={styles.text}>终端请在 ccb 原生 sidebar 查看对应 slot 窗口。</p>
      {props.message ? <p className={styles.fallbackReason}>{props.message}</p> : null}
    </div>
  );
}

export function SlotPanelActions(props: {
  hasSlot: boolean;
  slotLoading: boolean;
  slotAction: "bind" | "release" | null;
  canReleaseSlot: boolean;
  onBindSlot: () => void;
  onReleaseSlot: () => void;
}) {
  const toProjectPath = useProjectPathBuilder();
  return (
    <div className={styles.actions}>
      {!props.hasSlot ? (
        <Button disabled={props.slotLoading || Boolean(props.slotAction)} loading={props.slotAction === "bind"} onClick={props.onBindSlot} size="sm">
          绑定 slot
        </Button>
      ) : props.canReleaseSlot ? (
        <Button
          disabled={props.slotLoading || Boolean(props.slotAction)}
          loading={props.slotAction === "release"}
          onClick={props.onReleaseSlot}
          size="sm"
          variant="danger"
        >
          解绑 slot
        </Button>
      ) : null}
      <a className={styles.link} href={toProjectPath("/anchors")}>打开 Slots</a>
    </div>
  );
}
