import { useEffect, useRef, useState } from "react";

import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

export interface UseXtermTerminalOptions {
  onInput: (data: string) => void;
}

export const SLOT_TERMINAL_SCROLLBACK = 2_500;

export function useXtermTerminal(options: UseXtermTerminalOptions) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef(options.onInput);
  const [terminal, setTerminal] = useState<Terminal | null>(null);

  useEffect(() => {
    inputRef.current = options.onInput;
  }, [options.onInput]);

  useEffect(() => {
    if (!containerRef.current) {
      return;
    }
    const term = new Terminal({
      convertEol: true,
      fontSize: 13,
      fontFamily: "'JetBrains Mono', 'Cascadia Code', 'Consolas', 'Menlo', monospace",
      cursorBlink: true,
      scrollback: SLOT_TERMINAL_SCROLLBACK,
      allowProposedApi: true,
      theme: {
        background: "#0b1020",
        foreground: "#e2e8f0",
        cursor: "#22c55e",
        black: "#1f2937",
        red: "#f87171",
        green: "#4ade80",
        yellow: "#facc15",
        blue: "#60a5fa",
        magenta: "#c084fc",
        cyan: "#22d3ee",
        white: "#e5e7eb",
        brightBlack: "#475569",
        brightRed: "#fca5a5",
        brightGreen: "#86efac",
        brightYellow: "#fde047",
        brightBlue: "#93c5fd",
        brightMagenta: "#d8b4fe",
        brightCyan: "#67e8f9",
        brightWhite: "#f8fafc"
      }
    });
    const unicode = new Unicode11Addon();
    term.loadAddon(new WebLinksAddon());
    term.loadAddon(unicode);
    term.unicode.activeVersion = "11";
    term.open(containerRef.current);

    const dataSubscription = term.onData((data) => inputRef.current(data));
    setTerminal(term);

    return () => {
      dataSubscription.dispose();
      term.dispose();
      setTerminal(null);
    };
  }, []);

  return {
    containerRef,
    terminal
  };
}
