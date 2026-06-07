import { useNavigate } from "react-router";

import { DetailDrawer } from "./DetailDrawer.js";
import styles from "./AdvancedDrawer.module.css";
import { useProjectPathBuilder } from "../../lib/project-paths.js";
import type { TaskDetailView } from "../../types/task.js";

interface AdvancedDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  task: TaskDetailView;
  isExecutable: boolean;
  blockedReason: string;
  onCopyPath: (path: string) => void;
  onMarkBlocked: (reason: string) => void;
  onMarkDone: () => void;
}

export function AdvancedDrawer({
  isOpen,
  onClose,
  task,
  isExecutable,
  blockedReason,
  onCopyPath,
  onMarkBlocked,
  onMarkDone
}: AdvancedDrawerProps) {
  const navigate = useNavigate();
  const toProjectPath = useProjectPathBuilder();
  const sourceDoc = task.linkedDocuments.find((doc) => doc.kind === "dev_task") ?? null;
  const sourcePath = sourceDoc?.path ?? null;

  const handleMarkBlocked = () => {
    const input = window.prompt("请填写阻塞原因（必填）", blockedReason.trim());
    if (input === null) return;
    const reason = input.trim();
    if (!reason) return;
    onMarkBlocked(reason);
  };

  return (
    <DetailDrawer isOpen={isOpen} onClose={onClose} title="高级 / 调试">
      <section className={styles.section}>
        <div className={styles.sectionLabel}>真相源文档</div>
        <div className={styles.row}>
          <span className={styles.rowLabel}>路径</span>
          <code className={styles.code}>{sourcePath ?? "未知"}</code>
        </div>
        <div className={styles.actions}>
          {sourceDoc ? (
            <button className={styles.button} onClick={() => navigate(toProjectPath(`/documents/${sourceDoc.id}`))} type="button">
              打开文档
            </button>
          ) : null}
          {sourcePath ? (
            <button className={styles.button} onClick={() => onCopyPath(sourcePath)} type="button">
              复制路径
            </button>
          ) : null}
        </div>
      </section>

      {isExecutable ? (
        <section className={styles.section}>
          <div className={styles.sectionLabel}>快捷操作</div>
          <div className={styles.actions}>
            <button className={styles.warningButton} onClick={handleMarkBlocked} type="button">
              标记阻塞
            </button>
            <button className={styles.successButton} onClick={onMarkDone} type="button">
              标记完成
            </button>
          </div>
        </section>
      ) : null}
    </DetailDrawer>
  );
}
