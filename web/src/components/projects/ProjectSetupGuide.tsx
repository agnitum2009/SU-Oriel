import { useState } from "react";

import type { ProjectOnboardingActions } from "../../lib/use-project-onboarding-actions.js";
import { Button } from "../ui/Button.js";
import { Modal } from "../ui/Modal.js";
import styles from "./ProjectSetupGuide.module.css";

interface ProjectSetupGuideProps {
  /** 由 OverviewPage(稳定 owner)持有的接入动作单元;轮询/状态写 store,本组件纯展示。 */
  actions: ProjectOnboardingActions;
}

/**
 * 未初始化时概览整页呈现的分步初始化引导。按 ccbRuntimeReady / knowledgeBaseReady 高亮当前步。
 * 复用 useProjectOnboardingActions(由 OverviewPage 持有),不新造初始化逻辑;就绪后 OverviewPage 自动切回数据盘。
 */
export function ProjectSetupGuide({ actions }: ProjectSetupGuideProps) {
  const { status, initJob, refreshing, submitting, terminalSpawning, refresh, copyCommand, confirmInit, openTerminal } = actions;
  const [confirmOpen, setConfirmOpen] = useState(false);

  const runtimeReady = status?.ccbRuntimeReady === true;
  const knowledgeReady = status?.knowledgeBaseReady === true;
  const step1State: "done" | "active" = runtimeReady ? "done" : "active";
  const step2State: "done" | "active" | "pending" = knowledgeReady ? "done" : runtimeReady ? "active" : "pending";

  return (
    <>
      <section className={styles.guide} role="region" aria-label="项目初始化引导">
        <header className={styles.header}>
          <div className={styles.title}>欢迎接入项目 · 完成两步即可开始</div>
          <div className={styles.subtitle}>
            SU-Oriel 需要先初始化 CCB 运行时与知识库，才能进入需求、文档、运行记录等页面。
          </div>
        </header>

        <ol className={styles.steps}>
          <li className={`${styles.step} ${styles[step1State]}`}>
            <div aria-hidden="true" className={styles.stepIcon}>
              {step1State === "done" ? "✓" : "1"}
            </div>
            <div className={styles.stepBody}>
              <div className={styles.stepTitle}>初始化 CCB 运行时</div>
              <div className={styles.stepDesc}>
                在项目目录执行 <code>ccb</code>，生成 <code>.ccb/ccb.config</code> 并拉起守护进程。
              </div>
              {!runtimeReady && status ? (
                <div className={styles.stepActions}>
                  <Button onClick={() => void copyCommand()} size="sm" variant="secondary">
                    复制命令
                  </Button>
                  <code className={styles.cmd}>{status.manualCommand}</code>
                </div>
              ) : null}
            </div>
          </li>

          <li className={`${styles.step} ${styles[step2State]}`}>
            <div aria-hidden="true" className={styles.stepIcon}>
              {step2State === "done" ? "✓" : "2"}
            </div>
            <div className={styles.stepBody}>
              <div className={styles.stepTitle}>初始化知识库</div>
              <div className={styles.stepDesc}>
                {initJob
                  ? `初始化中（jobId: ${initJob.jobId}），已投递给 ${initJob.claudeAgentName}，Console 会短间隔检测结果。`
                  : "向主项目 ccbd 投递 /ccb:su-init 生成 docs 索引，或在终端手动执行。"}
              </div>
              {runtimeReady && !knowledgeReady ? (
                <div className={styles.stepActions}>
                  <Button disabled={Boolean(initJob)} onClick={() => setConfirmOpen(true)} size="sm">
                    一键初始化知识库
                  </Button>
                  <Button loading={terminalSpawning} onClick={() => void openTerminal()} size="sm" variant="secondary">
                    🖥 打开实体终端
                  </Button>
                </div>
              ) : null}
            </div>
          </li>
        </ol>

        <footer className={styles.footer}>
          <Button loading={refreshing} onClick={() => void refresh()} size="sm" variant="ghost">
            重新检测
          </Button>
        </footer>
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
