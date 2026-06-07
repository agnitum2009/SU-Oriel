import { useNavigate, useParams } from "react-router";

import styles from "./BreakdownReviewPage.module.css";
import { BreakdownReviewEmbedded } from "../../components/breakdown-review/BreakdownReviewEmbedded.js";
import { Button } from "../../components/ui/Button.js";
import { useProjectPathBuilder } from "../../lib/project-paths.js";

export function BreakdownReviewPage() {
  const { requirementId } = useParams<{ requirementId: string }>();
  const navigate = useNavigate();
  const toProjectPath = useProjectPathBuilder();

  if (!requirementId) {
    return <div className={styles.empty}>缺少 requirementId</div>;
  }

  return (
    <div className={styles.page}>
      <div className={styles.breadcrumb}>
        <Button size="sm" variant="ghost" onClick={() => navigate(toProjectPath(`/requirements/${requirementId}`))}>
          ← 回需求详情
        </Button>
        <span className={styles.crumbSep}>·</span>
        <span className={styles.crumbCurrent}>拆分审查 · 全屏视图</span>
      </div>
      <BreakdownReviewEmbedded
        requirementId={requirementId}
        onAfterMaterialize={() => navigate(toProjectPath(`/requirements/${requirementId}`))}
      />
    </div>
  );
}
