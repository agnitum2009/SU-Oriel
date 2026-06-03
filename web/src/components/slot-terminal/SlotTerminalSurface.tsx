import { useCallback, useEffect, useRef, useState } from "react";

import { createSlotTerminalClient, type SlotTerminalClient, type SlotTerminalWebSocketFactory } from "../../lib/slot-terminal-ws.js";
import type { SlotTerminalPaneRole, SlotTerminalReadyDescriptor, SlotTerminalTarget } from "../../types/slot-terminal.js";
import { SlotTerminalFrameRenderer } from "./SlotTerminalFrameRenderer.js";
import { useXtermTerminal } from "./useXtermTerminal.js";
import styles from "./SlotTerminalSurface.module.css";

export interface TerminalSurfaceProps {
  target: SlotTerminalTarget;
  pane: SlotTerminalPaneRole;
  title?: string;
  active?: boolean;
  webSocketFactory?: SlotTerminalWebSocketFactory;
  onReady?: (descriptor: SlotTerminalReadyDescriptor) => void;
  onError?: (code: string, message: string) => void;
}

type LegacySlotTerminalSurfaceProps = Omit<TerminalSurfaceProps, "target"> & {
  projectId: string;
  requirementId: string;
};

export type SlotTerminalSurfaceProps = TerminalSurfaceProps | LegacySlotTerminalSurfaceProps;

type SlotTerminalContextMenu = { x: number; y: number; hasSelection: boolean };

async function writeClipboardText(text: string): Promise<void> {
  if (!text) {
    return;
  }
  try {
    await navigator.clipboard?.writeText(text);
  } catch {
    // non-secure context / permission denied — clipboard unavailable, ignore
  }
}

async function readClipboardText(): Promise<string> {
  try {
    return (await navigator.clipboard?.readText()) ?? "";
  } catch {
    return "";
  }
}

export function TerminalSurface(props: TerminalSurfaceProps) {
  const active = props.active ?? true;
  const target = props.target;
  const clientRef = useRef<SlotTerminalClient | null>(null);
  const rendererRef = useRef<SlotTerminalFrameRenderer | null>(null);
  const [status, setStatus] = useState<"connecting" | "open" | "closed" | "error">("connecting");
  const [lastError, setLastError] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<SlotTerminalContextMenu | null>(null);
  const { containerRef, terminal } = useXtermTerminal({
    onInput: (data) => clientRef.current?.sendInput(data)
  });
  const targetKey = slotTerminalTargetKey(target);

  const copySelection = useCallback((): boolean => {
    const selection = terminal?.getSelection() ?? "";
    if (selection) {
      void writeClipboardText(selection);
      return true;
    }
    return false;
  }, [terminal]);

  const pasteFromClipboard = useCallback(async (): Promise<void> => {
    const text = await readClipboardText();
    if (text) {
      clientRef.current?.sendPaste(text);
    }
  }, []);

  useEffect(() => {
    clientRef.current?.sendActive(active);
  }, [active]);

  useEffect(() => {
    if (!terminal) {
      return;
    }
    const renderer = new SlotTerminalFrameRenderer(terminal);
    rendererRef.current = renderer;
    setStatus("connecting");
    setLastError(null);
    const client = createSlotTerminalClient({
      target,
      pane: props.pane,
      webSocketFactory: props.webSocketFactory,
      callbacks: {
        onStatusChange: setStatus,
        onReady: (descriptor) => props.onReady?.(descriptor),
        onFrame: (frame) => renderer.applyFrame(frame),
        onError: (code, message) => {
          setLastError(`${code}: ${message}`);
          props.onError?.(code, message);
        }
      }
    });
    clientRef.current = client;
    const sendVisibility = () => {
      client.sendVisibility(document.hidden ? "hidden" : "visible");
    };
    sendVisibility();
    client.sendActive(active);
    document.addEventListener("visibilitychange", sendVisibility);
    return () => {
      document.removeEventListener("visibilitychange", sendVisibility);
      client.close();
      renderer.dispose();
      if (clientRef.current === client) {
        clientRef.current = null;
      }
      if (rendererRef.current === renderer) {
        rendererRef.current = null;
      }
    };
  }, [active, props.pane, targetKey, props.webSocketFactory, props.onReady, props.onError, terminal]);

  // 复制键盘快捷键：Ctrl/Cmd+Shift+C 复制选区。Ctrl+C 不拦截（仍作 SIGINT 发给 pane）。
  // 粘贴统一走容器的 onPasteCapture（拦截浏览器 paste 事件，发原始文本），不走 xterm 内置 paste，
  // 否则 xterm 会把文本包进括号粘贴标记 \e[200~..\e[201~，被逐键 send-keys 打碎导致粘贴失败。
  useEffect(() => {
    if (!terminal) {
      return;
    }
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") {
        return true;
      }
      const mod = event.ctrlKey || event.metaKey;
      if (mod && event.shiftKey && event.code === "KeyC") {
        copySelection();
        return false;
      }
      return true;
    });
    return () => {
      terminal.attachCustomKeyEventHandler(() => true);
    };
  }, [terminal, copySelection]);

  // 粘贴：原生捕获相拦截浏览器 paste（Ctrl/Cmd+V、中键、Shift+V），早于 xterm 的 textarea 处理。
  // 取原始文本走 sendPaste（后端用 tmux paste-buffer -p 原子投递 + 括号粘贴，多行不逐行执行），
  // 并阻断 xterm 内置 paste（否则它会包成 \e[200~..\e[201~ 再被逐键映射打碎）。
  useEffect(() => {
    const host = containerRef.current;
    if (!host) {
      return;
    }
    const onPaste = (event: ClipboardEvent) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      const text = event.clipboardData?.getData("text") ?? "";
      if (text) {
        clientRef.current?.sendPaste(text);
      }
    };
    host.addEventListener("paste", onPaste, true);
    return () => host.removeEventListener("paste", onPaste, true);
  }, [containerRef, terminal]);

  // 右键菜单：点击别处 / 滚动 / Esc 关闭。
  useEffect(() => {
    if (!contextMenu) {
      return;
    }
    const close = () => setContextMenu(null);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setContextMenu(null);
      }
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [contextMenu]);

  return (
    <section className={styles.surface} data-status={status}>
      <div className={styles.header}>
        <span className={styles.statusDot} data-status={status} />
        <span className={styles.title}>{props.title ?? `${props.pane} terminal`}</span>
        {lastError ? <span className={styles.error}>{lastError}</span> : null}
      </div>
      <div
        className={styles.terminalHost}
        onContextMenu={(event) => {
          event.preventDefault();
          setContextMenu({ x: event.clientX, y: event.clientY, hasSelection: terminal?.hasSelection() ?? false });
        }}
        onMouseUp={() => {
          copySelection();
        }}
        ref={containerRef}
      />
      {contextMenu ? (
        <div
          className={styles.menu}
          onMouseDown={(event) => event.stopPropagation()}
          role="menu"
          style={{ top: contextMenu.y, left: contextMenu.x }}
        >
          <button
            className={styles.menuItem}
            disabled={!contextMenu.hasSelection}
            onClick={() => {
              copySelection();
              setContextMenu(null);
            }}
            role="menuitem"
            type="button"
          >
            复制
          </button>
          <button
            className={styles.menuItem}
            onClick={() => {
              void pasteFromClipboard();
              setContextMenu(null);
            }}
            role="menuitem"
            type="button"
          >
            粘贴
          </button>
        </div>
      ) : null}
    </section>
  );
}

export function SlotTerminalSurface(props: SlotTerminalSurfaceProps) {
  if ("target" in props) {
    return <TerminalSurface {...props} />;
  }
  return (
    <TerminalSurface
      {...props}
      target={{
        kind: "requirement",
        projectId: props.projectId,
        requirementId: props.requirementId
      }}
    />
  );
}

function slotTerminalTargetKey(target: SlotTerminalTarget): string {
  return target.kind === "requirement"
    ? `${target.kind}:${target.projectId}:${target.requirementId}`
    : `${target.kind}:${target.projectId}:${target.group}`;
}
