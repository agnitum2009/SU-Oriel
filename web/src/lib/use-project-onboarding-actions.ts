import { useCallback, useEffect, useMemo, useState } from "react";

import { fetchProjectInitJobStatus, initProjectKnowledgeBase, spawnMainTerminal } from "./console-api.js";
import { useProjectStore } from "../stores/project-store.js";
import { useUIStore } from "../stores/ui-store.js";
import type { AnchorNativeTerminalSpawnResult } from "../types/anchor-terminal.js";
import type { ProjectOnboardingStatusView } from "../types/project.js";

const POLL_INTERVAL_MS = 3_000;
const POLL_TIMEOUT_MS = 60_000;

export type OnboardingBannerState = "runtime-missing" | "knowledge-missing" | "ready" | null;

export interface InitJobState {
  jobId: string;
  claudeAgentName: string;
  startedAt: number;
}

export interface ProjectOnboardingActions {
  status: ProjectOnboardingStatusView | null;
  loading: boolean;
  bannerState: OnboardingBannerState;
  initJob: InitJobState | null;
  refreshing: boolean;
  submitting: boolean;
  terminalSpawning: boolean;
  refresh: () => Promise<void>;
  copyCommand: () => Promise<void>;
  /** 投递 /ccb:su-init,成功返回 true(调用方据此关闭确认框);失败 toast 并返回 false。 */
  confirmInit: () => Promise<boolean>;
  openTerminal: () => Promise<void>;
}

function formatTerminalSpawnFailure(result: AnchorNativeTerminalSpawnResult): string {
  const reason = result.reason?.trim() || "未找到可用实体终端";
  const attempted = result.attempted.slice(0, 2).join("；");
  if (!attempted) {
    return `打开失败：${reason}`;
  }
  const more = result.attempted.length > 2 ? "；更多见 server log" : "";
  return `打开失败：${reason}；尝试：${attempted}${more}`;
}

/**
 * 项目接入「检测 + 动作 + init-job 轮询」复用单元。状态走 project-store 单一数据源
 * (ensureOnboarding),init-job 轮询结果经 ensureOnboarding(force) 写回 store 而非组件局部
 * state —— 故就绪后组件被卸载时只清 interval,末次状态已落 store,无丢失、无 unmounted setState。
 * ProjectOnboardingBanner 与 ProjectSetupGuide 共用本 hook。
 */
export function useProjectOnboardingActions(projectId: string | null): ProjectOnboardingActions {
  const addToast = useUIStore((state) => state.addToast);
  const requestOpenMainTerminal = useUIStore((state) => state.requestOpenMainTerminal);
  const ensureOnboarding = useProjectStore((state) => state.ensureOnboarding);
  const entry = useProjectStore((state) => (projectId ? state.onboardingByProject[projectId] : undefined));

  const [refreshing, setRefreshing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [terminalSpawning, setTerminalSpawning] = useState(false);
  const [initJob, setInitJob] = useState<InitJobState | null>(null);

  useEffect(() => {
    setInitJob(null);
    if (projectId) {
      void ensureOnboarding(projectId);
    }
  }, [projectId, ensureOnboarding]);

  const status = entry?.value ?? null;
  const loading = projectId ? (entry?.loading ?? true) : false;

  useEffect(() => {
    if (!projectId || !initJob) {
      return;
    }
    let settled = false;
    const intervalId = window.setInterval(() => {
      if (settled) {
        return;
      }
      const elapsed = Date.now() - initJob.startedAt;
      if (elapsed >= POLL_TIMEOUT_MS) {
        settled = true;
        window.clearInterval(intervalId);
        setInitJob(null);
        addToast("error", `执行超时，请在终端检查 ccb pend ${initJob.jobId}`);
        return;
      }
      void (async () => {
        try {
          const [nextStatus, jobStatus] = await Promise.all([
            ensureOnboarding(projectId, { force: true }),
            fetchProjectInitJobStatus(projectId, initJob.jobId)
          ]);
          // 卸载/已结算后不再写本地 state(status 已由 ensureOnboarding 落 store,安全)。
          if (settled) {
            return;
          }
          if (nextStatus?.knowledgeBaseReady) {
            settled = true;
            window.clearInterval(intervalId);
            setInitJob(null);
            addToast("success", "知识库已就绪");
            return;
          }
          if (jobStatus.status === "failed") {
            settled = true;
            window.clearInterval(intervalId);
            setInitJob(null);
            const reason = jobStatus.reason?.trim() || "未知错误";
            addToast("error", `su-init 失败：${reason}。请在终端运行 ccb pend ${initJob.jobId} 查看详情`);
          }
        } catch (error) {
          addToast("error", error instanceof Error ? error.message : "检查知识库初始化状态失败");
        }
      })();
    }, POLL_INTERVAL_MS);
    return () => {
      settled = true;
      window.clearInterval(intervalId);
    };
  }, [addToast, ensureOnboarding, initJob, projectId]);

  const bannerState = useMemo<OnboardingBannerState>(() => {
    if (!status) {
      return null;
    }
    if (!status.ccbRuntimeReady) {
      return "runtime-missing";
    }
    if (!status.knowledgeBaseReady) {
      return "knowledge-missing";
    }
    return "ready";
  }, [status]);

  const refresh = useCallback(async () => {
    if (!projectId) {
      return;
    }
    setRefreshing(true);
    try {
      await ensureOnboarding(projectId, { force: true });
    } finally {
      setRefreshing(false);
    }
  }, [ensureOnboarding, projectId]);

  const copyCommand = useCallback(async () => {
    if (!status) {
      return;
    }
    try {
      await navigator.clipboard.writeText(status.manualCommand);
      addToast("success", "命令已复制");
    } catch {
      addToast("error", "复制命令失败");
    }
  }, [addToast, status]);

  const confirmInit = useCallback(async () => {
    if (!projectId) {
      return false;
    }
    setSubmitting(true);
    try {
      const result = await initProjectKnowledgeBase(projectId);
      setInitJob({ jobId: result.jobId, claudeAgentName: result.claudeAgentName, startedAt: Date.now() });
      // 提交成功后主动弹出 main 终端弹窗,让用户直观看到 su-init 执行过程;失败路径不发请求。
      requestOpenMainTerminal(projectId);
      return true;
    } catch (error) {
      addToast("error", error instanceof Error ? error.message : "初始化项目知识库失败");
      return false;
    } finally {
      setSubmitting(false);
    }
  }, [addToast, projectId, requestOpenMainTerminal]);

  const openTerminal = useCallback(async () => {
    if (!projectId || terminalSpawning) {
      return;
    }
    setTerminalSpawning(true);
    try {
      const result = await spawnMainTerminal(projectId);
      if (result.spawned) {
        addToast("success", "已尝试打开实体终端");
      } else {
        addToast("error", formatTerminalSpawnFailure(result));
      }
    } catch (error) {
      addToast("error", error instanceof Error ? `打开失败：${error.message}` : "打开实体终端失败");
    } finally {
      setTerminalSpawning(false);
    }
  }, [addToast, projectId, terminalSpawning]);

  return {
    status,
    loading,
    bannerState,
    initJob,
    refreshing,
    submitting,
    terminalSpawning,
    refresh,
    copyCommand,
    confirmInit,
    openTerminal
  };
}
