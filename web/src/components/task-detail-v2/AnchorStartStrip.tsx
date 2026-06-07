import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";

import { fetchSlots, type SlotLaneView } from "../../lib/console-api.js";
import {
  fetchPendingIntent,
  resumeWithIntent,
  stopAndAppend,
  type PendingIntentView,
  type UserIntentType
} from "../../lib/user-intent-api.js";
import { projectSlotsPath } from "../../lib/project-paths.js";
import { useProjectStore } from "../../stores/project-store.js";
import { useUIStore } from "../../stores/ui-store.js";
import { Button } from "../ui/Button.js";
import { StopAndAppendDialog } from "./StopAndAppendDialog.js";
import styles from "./AnchorStartStrip.module.css";

interface AnchorStartStripProps {
  taskId: string;
  taskTitle: string;
  taskKind?: "epic" | "subtask";
  requirementId?: string | null;
  visible: boolean;
}

const POLL_INTERVAL_MS = 5000;

const INTENT_LABEL: Record<UserIntentType, string> = {
  append_instruction: "追加",
  change_direction: "改向",
  pause: "暂停"
};

export function AnchorStartStrip(props: AnchorStartStripProps) {
  const [stopDialogOpen, setStopDialogOpen] = useState(false);
  const [submittingStop, setSubmittingStop] = useState(false);
  const [submittingResume, setSubmittingResume] = useState(false);
  const [pendingIntent, setPendingIntent] = useState<PendingIntentView | null>(null);
  const [slots, setSlots] = useState<SlotLaneView[]>([]);
  const [loading, setLoading] = useState(false);
  const selectedProjectId = useProjectStore((state) => state.selectedProjectId);
  const addToast = useUIStore((state) => state.addToast);

  useEffect(() => {
    if (!props.visible) return;
    let cancelled = false;
    const tick = async () => {
      setLoading(true);
      try {
        const [intent, slotProjection] = await Promise.all([
          fetchPendingIntent(props.taskId).catch(() => null),
          selectedProjectId ? fetchSlots(selectedProjectId).catch(() => null) : Promise.resolve(null)
        ]);
        if (!cancelled) {
          setPendingIntent(intent);
          setSlots(slotProjection?.slots ?? []);
        }
      } catch {
        // 轮询失败不打断任务详情页；操作时仍会通过 toast 告知明确错误。
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };
    void tick();
    const intervalId = window.setInterval(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [props.visible, props.taskId, selectedProjectId]);

  const boundSlot = useMemo(() => {
    if (!props.requirementId) return null;
    return slots.find((slot) =>
      slot.requirement?.id === props.requirementId &&
      slot.state !== "idle" &&
      slot.state !== "draining"
    ) ?? null;
  }, [props.requirementId, slots]);

  if (!props.visible) return null;

  const activeSlotId = boundSlot?.state === "busy" ? boundSlot.slotId : null;
  const statusState: "ready" | "running" | "loading" = activeSlotId || boundSlot
    ? "running"
    : loading
      ? "loading"
      : "ready";
  const statusLabel = pendingIntent && boundSlot
    ? `绑定 ${boundSlot.requirement?.id ?? props.requirementId}·有待恢复意图`
    : activeSlotId
      ? `${activeSlotId} 运行中`
      : boundSlot
        ? `${boundSlot.slotId} 已绑定`
        : !selectedProjectId
          ? "未选择项目"
          : loading
            ? "加载中"
            : "未绑定 slot";

  const handleStopAppend = async (payload: { intentType: UserIntentType; body: string }) => {
    setSubmittingStop(true);
    try {
      const result = await stopAndAppend(props.taskId, payload);
      setStopDialogOpen(false);
      if (result.slotId && result.slotState) {
        setSlots((current) =>
          current.map((slot) =>
            slot.slotId === result.slotId
              ? { ...slot, state: result.slotState as SlotLaneView["state"], busySince: null }
              : slot
          )
        );
      }
      addToast("success", `已记录介入意图（${INTENT_LABEL[payload.intentType]}）`);
      setPendingIntent({
        id: result.intentId,
        intentType: payload.intentType,
        body: payload.body,
        createdAt: new Date().toISOString(),
        ccbJobId: result.cancelledJobId
      });
    } catch (error) {
      addToast("error", error instanceof Error ? error.message : "停止并追加失败");
    } finally {
      setSubmittingStop(false);
    }
  };

  const handleResume = async () => {
    setSubmittingResume(true);
    try {
      const result = await resumeWithIntent(props.taskId);
      addToast("success", `Slot 恢复中：${result.slotId}`);
      setSlots((current) =>
        current.map((slot) =>
          slot.slotId === result.slotId
            ? { ...slot, state: result.slotState as SlotLaneView["state"], busySince: new Date().toISOString() }
            : slot
        )
      );
      setPendingIntent(null);
    } catch (error) {
      addToast("error", error instanceof Error ? error.message : "恢复失败");
    } finally {
      setSubmittingResume(false);
    }
  };

  return (
    <section className={styles.strip} aria-label="Task Slot">
      <div className={styles.summary}>
        <span className={styles.label}>
          Slot
          {props.taskKind === "subtask" ? (
            <span className={styles.kindTag} data-kind="subtask" title="SubTask 继承 parent requirement sticky slot">
              SubTask
            </span>
          ) : props.taskKind === "epic" ? (
            <span className={styles.kindTag} data-kind="epic" title="Epic 兼容视图">
              Epic
            </span>
          ) : null}
        </span>
        <span className={styles.statusDot} data-state={statusState}>
          {statusLabel}
        </span>
        <span className={styles.guidance}>终端请在 ccb 原生 sidebar 查看 slot 窗口</span>
      </div>
      <div className={styles.actions}>
        {activeSlotId ? (
          <>
            <span className={styles.runningTag}>{activeSlotId}</span>
            <Button
              onClick={() => setStopDialogOpen(true)}
              size="sm"
              variant="secondary"
              disabled={submittingStop}
            >
              停止追加
            </Button>
          </>
        ) : pendingIntent ? (
          <Button
            onClick={() => void handleResume()}
            size="sm"
            loading={submittingResume}
            disabled={submittingResume}
          >
            恢复 · {INTENT_LABEL[pendingIntent.intentType]}
          </Button>
        ) : boundSlot ? (
          <>
            <span className={styles.runningTag}>{boundSlot.slotId}</span>
            <Button size="sm" variant="secondary" disabled>
              已绑定
            </Button>
          </>
        ) : (
          <Button disabled size="sm" variant="secondary">
            未绑定
          </Button>
        )}
        <Link className={styles.slotsLink} to={selectedProjectId ? projectSlotsPath(selectedProjectId) : "/"}>
          打开 Slots
        </Link>
      </div>

      <StopAndAppendDialog
        open={stopDialogOpen}
        submitting={submittingStop}
        onClose={() => setStopDialogOpen(false)}
        onConfirm={(payload) => void handleStopAppend(payload)}
      />
    </section>
  );
}
