import { useCallback, useEffect, useRef, useState } from "react";

import { fetchSlots } from "../../lib/console-api.js";
import type { SlotTerminalWebSocketFactory } from "../../lib/slot-terminal-ws.js";
import { useProjectStore } from "../../stores/project-store.js";
import { Modal } from "../ui/Modal.js";
import { MainTerminalPanel } from "../slot-terminal/MainTerminalPanel.js";
import styles from "./MainTerminalLauncher.module.css";

type MainState = "loading" | "error" | string;

export interface MainTerminalLauncherProps {
  webSocketFactory?: SlotTerminalWebSocketFactory;
}

export function MainTerminalLauncher(props: MainTerminalLauncherProps) {
  const selectedProjectId = useProjectStore((state) => state.selectedProjectId);
  const [open, setOpen] = useState(false);
  const [mainState, setMainState] = useState<MainState>("loading");
  const requestRef = useRef(0);

  const loadMainState = useCallback(async () => {
    if (!selectedProjectId) {
      return;
    }
    const requestId = ++requestRef.current;
    setMainState("loading");
    try {
      const projection = await fetchSlots(selectedProjectId);
      if (requestRef.current !== requestId) {
        return;
      }
      setMainState(projection.main.state || "missing");
    } catch {
      if (requestRef.current !== requestId) {
        return;
      }
      setMainState("error");
    }
  }, [selectedProjectId]);

  useEffect(() => {
    setOpen(false);
    setMainState("loading");
    requestRef.current += 1;
    if (selectedProjectId) {
      void loadMainState();
    }
  }, [loadMainState, selectedProjectId]);

  const openModal = () => {
    void loadMainState();
    setOpen(true);
  };

  if (!selectedProjectId) {
    return null;
  }

  return (
    <div className={styles.root} data-testid="main-terminal-launcher">
      <button
        aria-label="main agent 组终端快捷入口"
        className={styles.button}
        onClick={openModal}
        title={`main agent 组终端 · ${mainState}`}
        type="button"
      >
        M
        <span className={styles.stateDot} data-state={mainState} />
      </button>
      <Modal
        contentClassName={styles.modalContent}
        onClose={() => setOpen(false)}
        open={open}
        size="xl"
        title="main agent 组终端"
      >
        <MainTerminalPanel
          mainState={mainState}
          projectId={selectedProjectId}
          webSocketFactory={props.webSocketFactory}
        />
      </Modal>
    </div>
  );
}
