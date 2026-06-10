import { useState } from "react";

import { useProjectOnboardingActions } from "../../lib/use-project-onboarding-actions.js";
import { Button } from "../ui/Button.js";
import { Modal } from "../ui/Modal.js";
import styles from "./ProjectOnboardingBanner.module.css";

interface ProjectOnboardingBannerProps {
  projectId: string | null;
}

export function ProjectOnboardingBanner({ projectId }: ProjectOnboardingBannerProps) {
  // 检测 / 动作 / init-job 轮询统一走 useProjectOnboardingActions(状态落 project-store 单一源)。
  const {
    status,
    bannerState,
    initJob,
    refreshing,
    submitting,
    terminalSpawning,
    refresh,
    copyCommand,
    confirmInit,
    openTerminal
  } = useProjectOnboardingActions(projectId);
  const [confirmOpen, setConfirmOpen] = useState(false);

  if (!projectId || !status) {
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
            <Button onClick={() => void copyCommand()} size="sm" variant="secondary">
              复制命令
            </Button>
          ) : null}
          <Button loading={refreshing} onClick={() => void refresh()} size="sm" variant="secondary">
            重新检测
          </Button>
          {bannerState !== "runtime-missing" ? (
            <Button
              loading={terminalSpawning}
              onClick={() => void openTerminal()}
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
            <Button
              loading={submitting}
              onClick={() => {
                void confirmInit().then((ok) => {
                  if (ok) {
                    setConfirmOpen(false);
                  }
                });
              }}
            >
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
