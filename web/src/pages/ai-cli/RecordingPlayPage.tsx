import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";

import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import "@xterm/xterm/css/xterm.css";

import { Button } from "../../components/ui/Button.js";
import { fetchAiCliRecording } from "../../lib/ai-cli-api.js";
import { useProjectPathBuilder } from "../../lib/project-paths.js";
import type { RecordingMetaView } from "../../types/ai-cli.js";
import styles from "./RecordingPlayPage.module.css";

interface CastEvent {
  time: number; // seconds since start
  data: string;
}

interface ParsedCast {
  cols: number;
  rows: number;
  events: CastEvent[];
  duration: number;
}

function parseCast(raw: string): ParsedCast {
  const lines = raw.split(/\r?\n/);
  let cols = 100;
  let rows = 30;
  const events: CastEvent[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (index === 0 && parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const header = parsed as { width?: number; height?: number; version?: number };
      if (typeof header.width === "number") cols = header.width;
      if (typeof header.height === "number") rows = header.height;
      continue;
    }
    if (Array.isArray(parsed) && parsed.length >= 3) {
      const time = Number(parsed[0]);
      const kind = String(parsed[1]);
      const data = String(parsed[2]);
      if (kind === "o" && Number.isFinite(time)) {
        events.push({ time, data });
      }
    }
  }
  const duration = events.length > 0 ? events[events.length - 1].time : 0;
  return { cols, rows, events, duration };
}

function formatSeconds(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return "0:00";
  }
  const total = Math.floor(seconds);
  const minutes = Math.floor(total / 60);
  const remain = total % 60;
  return `${minutes}:${remain.toString().padStart(2, "0")}`;
}

const SPEEDS = [0.5, 1, 2, 4];

export function RecordingPlayPage() {
  const { recordingId } = useParams<{ recordingId: string }>();
  const navigate = useNavigate();
  const toProjectPath = useProjectPathBuilder();

  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const playStateRef = useRef<{
    timer: ReturnType<typeof setTimeout> | null;
    cursor: number;
    elapsed: number;
    speed: number;
    lastTick: number;
  }>({ timer: null, cursor: 0, elapsed: 0, speed: 1, lastTick: 0 });

  const [meta, setMeta] = useState<RecordingMetaView | null>(null);
  const [cast, setCast] = useState<ParsedCast | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [speed, setSpeed] = useState(1);

  useEffect(() => {
    if (!recordingId) {
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const payload = await fetchAiCliRecording(recordingId);
        if (cancelled) return;
        setMeta(payload.meta);
        setCast(parseCast(payload.cast));
      } catch (error) {
        if (!cancelled) {
          setErrorMsg(error instanceof Error ? error.message : "录像加载失败");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [recordingId]);

  useEffect(() => {
    if (!cast || !containerRef.current) {
      return;
    }
    const term = new Terminal({
      fontSize: 13,
      fontFamily: "'JetBrains Mono', 'Cascadia Code', 'Consolas', 'Menlo', monospace",
      cols: cast.cols,
      rows: cast.rows,
      scrollback: 5000,
      allowProposedApi: true,
      disableStdin: true,
      theme: {
        background: "#0b1020",
        foreground: "#e2e8f0"
      }
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    const unicode = new Unicode11Addon();
    term.loadAddon(unicode);
    term.unicode.activeVersion = "11";
    term.open(containerRef.current);
    try {
      fit.fit();
    } catch {
      // ignore
    }
    terminalRef.current = term;
    fitRef.current = fit;

    return () => {
      stopTicker();
      term.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
    // 只在 cast 装载完成后初始化一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cast]);

  const stopTicker = () => {
    if (playStateRef.current.timer) {
      clearTimeout(playStateRef.current.timer);
      playStateRef.current.timer = null;
    }
  };

  const scheduleNext = () => {
    if (!cast || !terminalRef.current) {
      return;
    }
    const state = playStateRef.current;
    if (state.cursor >= cast.events.length) {
      stopTicker();
      setPlaying(false);
      return;
    }
    const targetTime = cast.events[state.cursor].time;
    const wait = Math.max(0, (targetTime - state.elapsed) / state.speed) * 1000;
    state.timer = setTimeout(() => {
      const event = cast.events[state.cursor];
      if (!event || !terminalRef.current) {
        return;
      }
      terminalRef.current.write(event.data);
      state.elapsed = event.time;
      state.cursor += 1;
      setPosition(state.elapsed);
      scheduleNext();
    }, wait);
  };

  const handlePlay = () => {
    if (!cast || playing) {
      return;
    }
    if (playStateRef.current.cursor >= cast.events.length) {
      // 已结束，重新播放
      handleReset();
    }
    setPlaying(true);
    playStateRef.current.lastTick = Date.now();
    scheduleNext();
  };

  const handlePause = () => {
    stopTicker();
    setPlaying(false);
  };

  const handleReset = () => {
    stopTicker();
    setPlaying(false);
    if (terminalRef.current) {
      terminalRef.current.reset();
    }
    playStateRef.current.cursor = 0;
    playStateRef.current.elapsed = 0;
    setPosition(0);
  };

  const handleSpeed = (next: number) => {
    setSpeed(next);
    playStateRef.current.speed = next;
    if (playing) {
      stopTicker();
      scheduleNext();
    }
  };

  const totalDuration = cast?.duration ?? 0;
  const fillPercent = useMemo(() => {
    if (totalDuration <= 0) return 0;
    return Math.min(100, (position / totalDuration) * 100);
  }, [position, totalDuration]);

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <div className={styles.title}>会话回放</div>
          {meta ? (
            <div className={styles.meta}>
              {meta.toolId} · {meta.cwd} · 创建于 {new Date(meta.createdAt).toLocaleString()}
            </div>
          ) : (
            <div className={styles.meta}>加载中...</div>
          )}
        </div>
        <div className={styles.actions}>
          <Button onClick={() => navigate(toProjectPath("/ai-cli"))} size="sm" variant="secondary">
            返回 AI CLI
          </Button>
        </div>
      </div>

      {errorMsg ? <div className={styles.errorState}>{errorMsg}</div> : null}

      <div className={styles.terminalWrap}>
        <div className={styles.terminalHost} ref={containerRef} />
      </div>

      <div className={styles.controlBar}>
        <Button onClick={playing ? handlePause : handlePlay} size="sm">
          {playing ? "暂停" : "播放"}
        </Button>
        <Button onClick={handleReset} size="sm" variant="secondary">
          重置
        </Button>
        <div className={styles.timeline}>
          <div className={styles.timelineFill} style={{ width: `${fillPercent}%` }} />
        </div>
        <div className={styles.timeText}>
          {formatSeconds(position)} / {formatSeconds(totalDuration)}
        </div>
        <div className={styles.speedRow}>
          {SPEEDS.map((value) => (
            <button
              className={styles.speedButton}
              data-active={String(speed === value)}
              key={value}
              onClick={() => handleSpeed(value)}
              type="button"
            >
              {value}×
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
