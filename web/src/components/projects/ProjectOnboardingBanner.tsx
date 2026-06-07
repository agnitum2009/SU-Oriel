import { useCallback, useEffect, useMemo, useState } from "react";

import {
  fetchProjectInitJobStatus,
  fetchProjectOnboardingStatus,
  initProjectKnowledgeBase,
  spawnMainTerminal
} from "../../lib/console-api.js";
import type { AnchorNativeTerminalSpawnResult } from "../../types/anchor-terminal.js";
import { useUIStore } from "../../stores/ui-store.js";
import type { ProjectOnboardingStatusView } from "../../types/project.js";
import { Button } from "../ui/Button.js";
import { Modal } from "../ui/Modal.js";
import styles from "./ProjectOnboardingBanner.module.css";

const CACHE_TTL_MS = 30_000;
const POLL_INTERVAL_MS = 3_000;
const POLL_TIMEOUT_MS = 60_000;

const statusCache = new Map<string, { value: ProjectOnboardingStatusView; fetchedAt: number }>();

interface ProjectOnboardingBannerProps {
  projectId: string | null;
}

interface InitJobState {
  jobId: string;
  claudeAgentName: string;
  startedAt: number;
}

async function copyText(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
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

export function ProjectOnboardingBanner({ projectId }: ProjectOnboardingBannerProps) {
  const addToast = useUIStore((state) => state.addToast);
  const requestOpenMainTerminal = useUIStore((state) => state.requestOpenMainTerminal);
  const [status, setStatus] = useState<ProjectOnboardingStatusView | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [terminalSpawning, setTerminalSpawning] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [initJob, setInitJob] = useState<InitJobState | null>(null);

  const loadStatus = useCallback(
    async (options: { force?: boolean; quiet?: boolean } = {}) => {
      if (!projectId) {
        setStatus(null);
        return null;
      }

      const cached = statusCache.get(projectId);
      if (!options.force && cached && Date.now() - cached.fetchedAt <= CACHE_TTL_MS) {
        setStatus(cached.value);
        return cached.value;
      }

      if (!options.quiet) {
        setLoading(true);
      }
      try {
        const next = await fetchProjectOnboardingStatus(projectId);
        statusCache.set(projectId, { value: next, fetchedAt: Date.now() });
        setStatus(next);
        return next;
      } catch (error) {
        addToast("error", error instanceof Error ? error.message : "加载项目接入状态失败");
        return null;
      } finally {
        if (!options.quiet) {
          setLoading(false);
        }
      }
    },
    [addToast, projectId]
  );

  useEffect(() => {
    setConfirmOpen(false);
    setInitJob(null);
    void loadStatus();
  }, [loadStatus]);

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
            fetchProjectOnboardingStatus(projectId),
            fetchProjectInitJobStatus(projectId, initJob.jobId)
          ]);
          statusCache.set(projectId, { value: nextStatus, fetchedAt: Date.now() });
          setStatus(nextStatus);
          if (nextStatus.knowledgeBaseReady) {
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
  }, [addToast, initJob, projectId]);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await loadStatus({ force: true, quiet: true });
    } finally {
      setRefreshing(false);
    }
  };

  const handleCopyCommand = async () => {
    if (!status) {
      return;
    }
    try {
      await copyText(status.manualCommand);
      addToast("success", "命令已复制");
    } catch {
      addToast("error", "复制命令失败");
    }
  };

  const handleConfirmInit = async () => {
    if (!projectId) {
      return;
    }
    setSubmitting(true);
    try {
      const result = await initProjectKnowledgeBase(projectId);
      setInitJob({
        jobId: result.jobId,
        claudeAgentName: result.claudeAgentName,
        startedAt: Date.now()
      });
      setConfirmOpen(false);
      // 提交成功后主动弹出 main 终端弹窗,让用户直观看到 su-init 执行过程;失败路径不发请求。
      requestOpenMainTerminal(projectId);
    } catch (error) {
      addToast("error", error instanceof Error ? error.message : "初始化项目知识库失败");
    } finally {
      setSubmitting(false);
    }
  };

  const handleOpenMainTerminal = async () => {
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
  };

  const bannerState = useMemo(() => {
    if (!status) {
      return null;
    }
    if (!status.ccbRuntimeReady) {
      return "runtime-missing" as const;
    }
    if (!status.knowledgeBaseReady) {
      return "knowledge-missing" as const;
    }
    return "ready" as const;
  }, [status]);

  if (!projectId || !status) {
    return null;
  }

  if (loading) {
    return null;
  }

  return (
    <>
      <section className={`${styles.banner} ${styles[bannerState ?? "ready"]}`} role="status">
        <div className={styles.copy}>
          {bannerState === "runtime-missing" ? (
            <>
              <div className={styles.title}>项目 ccb runtime 未初始化</div>
              <div className={styles.message}>
                请点「复制命令」并在 <code>{status.localPath}</code> 终端粘贴执行，完成 ccb.config 写入与 ccbd 启动。
              </div>
            </>
          ) : null}

          {bannerState === "knowledge-missing" ? (
            <>
              <div className={styles.title}>
                {initJob ? `初始化中（jobId: ${initJob.jobId}）` : "知识库未初始化"}
              </div>
              <div className={styles.message}>
                {initJob
                  ? `已投递给 ${initJob.claudeAgentName}，Console 会短间隔检测结果。`
                  : "可一键向主项目 ccbd 投递 /ccb:su-init，或在终端手动执行。"}
              </div>
            </>
          ) : null}

          {bannerState === "ready" ? (
            <>
              <div className={styles.title}>项目接入已就绪</div>
              <div className={styles.message}>ccb runtime 与知识库索引均已检测到。</div>
            </>
          ) : null}
        </div>

        <div className={styles.actions}>
          {bannerState === "runtime-missing" ? (
            <Button onClick={() => void handleCopyCommand()} size="sm" variant="secondary">
              复制命令
            </Button>
          ) : null}
          <Button loading={refreshing} onClick={() => void handleRefresh()} size="sm" variant="secondary">
            重新检测
          </Button>
          {bannerState !== "runtime-missing" ? (
            <Button
              loading={terminalSpawning}
              onClick={() => void handleOpenMainTerminal()}
              size="sm"
              variant={bannerState === "ready" ? "ghost" : "secondary"}
            >
              🖥 打开实体终端
            </Button>
          ) : null}
          {bannerState !== "runtime-missing" ? (
            <Button
              disabled={Boolean(initJob)}
              onClick={() => setConfirmOpen(true)}
              size="sm"
              variant={bannerState === "ready" ? "ghost" : "secondary"}
            >
              {bannerState === "ready" ? "重新初始化知识库" : "一键初始化知识库"}
            </Button>
          ) : null}
        </div>
      </section>

      <Modal
        footer={
          <>
            <Button onClick={() => setConfirmOpen(false)} variant="secondary">
              取消
            </Button>
            <Button loading={submitting} onClick={() => void handleConfirmInit()}>
              确认初始化
            </Button>
          </>
        }
        onClose={() => setConfirmOpen(false)}
        open={confirmOpen}
        title="初始化知识库"
      >
        <div className={styles.modalBody}>
          <p>即将向主项目 ccbd 投递 /ccb:su-init 命令。</p>
          <p>注意：命令会进入你终端里的 Claude pane。如果你正在跟 Claude 聊天，会被打断。</p>
          <p>请确认当前对话空闲后再继续。</p>
        </div>
      </Modal>
    </>
  );
}
