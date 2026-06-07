import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router";

import styles from "./DocumentsPage.module.css";
import { MarkdownViewer } from "../../components/shared/MarkdownViewer.js";
import { Badge } from "../../components/ui/Badge.js";
import { EmptyState } from "../../components/ui/EmptyState.js";
import { SkeletonCard } from "../../components/ui/Skeleton.js";
import { projectDocumentBrowser } from "../../lib/document-browser-projection.js";
import { formatRelativePath } from "../../lib/format.js";
import { stripFrontmatter } from "../../lib/markdown.js";
import { useProjectPathBuilder } from "../../lib/project-paths.js";
import { getDocumentKindBadge } from "../../lib/ui-mapping.js";
import type { DocumentTier, DocumentView } from "../../types/document.js";
import { useDetailStore } from "../../stores/detail-store.js";
import { useProjectStore } from "../../stores/project-store.js";
import { useUIStore } from "../../stores/ui-store.js";

type TierFilter = "全部" | DocumentTier;

const TIER_FILTERS: readonly TierFilter[] = ["全部", "生效中", "历史", "归档"];

export function DocumentsPage() {
  const navigate = useNavigate();
  const toProjectPath = useProjectPathBuilder();
  const params = useParams();
  const selectedProjectId = useProjectStore((state) => state.selectedProjectId);
  const documents = useProjectStore((state) => state.documents);
  const loadingData = useProjectStore((state) => state.loadingData);
  const scanProject = useProjectStore((state) => state.scanProject);
  const documentDetail = useDetailStore((state) => state.documentDetail);
  const loadingDocumentDetail = useDetailStore((state) => state.loadingDocumentDetail);
  const loadDocumentDetail = useDetailStore((state) => state.loadDocumentDetail);
  const clearDocumentDetail = useDetailStore((state) => state.clearDocumentDetail);
  const addToast = useUIStore((state) => state.addToast);
  const openModal = useUIStore((state) => state.openModal);
  const [keyword, setKeyword] = useState("");
  const [tierFilter, setTierFilter] = useState<TierFilter>("全部");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const documentId = params.documentId ?? null;

  useEffect(() => {
    if (!documentId) {
      clearDocumentDetail();
      return;
    }
    // 文档详情完全由 URL 参数驱动，避免列表选中态和地址栏脱节。
    void loadDocumentDetail(documentId);
  }, [clearDocumentDetail, documentId, loadDocumentDetail]);

  const projection = useMemo(() => projectDocumentBrowser(documents), [documents]);

  const filteredGroups = useMemo(() => {
    const normalized = keyword.trim().toLowerCase();
    const matches = (document: DocumentView) => {
      const matchesKeyword =
        !normalized ||
        document.title.toLowerCase().includes(normalized) ||
        document.path.toLowerCase().includes(normalized);
      const matchesTier = tierFilter === "全部" || document.governance.tier === tierFilter;
      return matchesKeyword && matchesTier;
    };
    return projection.groups
      .map((group) => ({ ...group, documents: group.documents.filter(matches) }))
      .filter((group) => group.documents.length > 0);
  }, [projection.groups, keyword, tierFilter]);

  const handleScanProject = async () => {
    try {
      await scanProject();
      addToast("success", "文档扫描已开始");
    } catch (error) {
      addToast("error", error instanceof Error ? error.message : "文档扫描失败");
    }
  };

  if (!selectedProjectId) {
    return (
      <EmptyState
        action={{ label: "创建项目", onClick: () => openModal("create-project") }}
        description="当前项目不存在或尚未创建。重新创建项目并完成接入引导后，再执行文档扫描。"
        icon="📄"
        title="还没有选中的项目"
      />
    );
  }

  if (loadingData) {
    return (
      <div className={styles.layout}>
        <section className={styles.navPane}>
          {Array.from({ length: 4 }).map((_, index) => (
            <SkeletonCard key={`document-skeleton-${index}`} />
          ))}
        </section>
        <section className={styles.readerPane}>
          <EmptyState description="文档加载完成后可在这里阅读 Markdown 内容。" icon="📄" title="选择文档后查看内容" />
        </section>
      </div>
    );
  }

  if (documents.length === 0) {
    return (
      <EmptyState
        action={{ label: "扫描文档", onClick: () => void handleScanProject() }}
        description="当前项目还没有文档，执行一次扫描后会自动生成文档索引。"
        icon="📄"
        title="当前项目还没有文档"
      />
    );
  }

  const activeDocumentBadge = documentDetail ? getDocumentKindBadge(documentDetail.kind) : null;

  const navItem = (document: DocumentView) => {
    const badge = getDocumentKindBadge(document.kind);
    const showTierBadge = document.governance.tier !== "生效中";
    const hasParseError = document.governance.healthFlags.parseError;
    return (
      <button
        className={styles.navItem}
        data-active={String(document.id === documentId)}
        key={document.id}
        onClick={() => navigate(toProjectPath(`/documents/${document.id}`))}
        type="button"
      >
        <span className={styles.navItemMain}>
          <span className={styles.navItemTitle} title={document.title}>
            {document.title}
          </span>
          {hasParseError ? (
            <span aria-label={`${document.title} 解析异常`} className={styles.parseErrorMarker} title="解析异常">
              !
            </span>
          ) : null}
        </span>
        <span className={styles.navItemMeta}>
          {showTierBadge ? (
            <span className={styles.tierBadge} data-tier={document.governance.tier}>
              {document.governance.tier}
            </span>
          ) : null}
          <Badge color={badge.color} label={badge.label} />
        </span>
      </button>
    );
  };

  return (
    <div className={styles.layout}>
      <section className={styles.navPane}>
        <div className={styles.navControls}>
          <input
            className={styles.searchInput}
            onChange={(event) => setKeyword(event.target.value)}
            placeholder="搜索文档..."
            value={keyword}
          />
          <select
            aria-label="档位筛选"
            className={styles.tierSelect}
            onChange={(event) => setTierFilter(event.target.value as TierFilter)}
            value={tierFilter}
          >
            {TIER_FILTERS.map((tier) => (
              <option key={tier} value={tier}>
                {tier}
              </option>
            ))}
          </select>
        </div>
        <div className={styles.navGroups}>
          {filteredGroups.length === 0 ? (
            <div className={styles.placeholder}>当前筛选条件下没有匹配文档。</div>
          ) : (
            filteredGroups.map((group) => {
              const key = group.directory;
              // 默认折叠目录组；有搜索关键词时强制展开，避免搜到的文档被折叠隐藏。
              const isCollapsed = (collapsed[key] ?? true) && !keyword.trim();
              return (
                <div className={styles.navGroup} key={key}>
                  <button
                    className={styles.navGroupHeader}
                    data-collapsed={String(isCollapsed)}
                    onClick={() => setCollapsed((prev) => ({ ...prev, [key]: !isCollapsed }))}
                    type="button"
                  >
                    <span className={styles.navGroupDir}>{formatRelativePath(group.directory) || "/"}</span>
                    <span className={styles.navGroupCount}>{group.documents.length}</span>
                  </button>
                  {!isCollapsed ? <div className={styles.navGroupItems}>{group.documents.map(navItem)}</div> : null}
                </div>
              );
            })
          )}
        </div>
      </section>

      <section className={styles.readerPane}>
        {!documentId ? (
          <EmptyState description="从左侧目录选择文档后，这里会展示 Markdown 阅读器。" icon="📄" title="选择文档后查看内容" />
        ) : loadingDocumentDetail && !documentDetail ? (
          <div className={styles.readerLoading}>
            <SkeletonCard className={styles.readerSkeleton} />
          </div>
        ) : documentDetail && activeDocumentBadge ? (
          <div className={styles.readerCard}>
            <div className={styles.readerHeader}>
              <div>
                <div className={styles.readerTitleRow}>
                  <h2 className={styles.readerTitle}>{documentDetail.title}</h2>
                  <Badge color={activeDocumentBadge.color} label={activeDocumentBadge.label} />
                </div>
                <div className={styles.readerPath}>{formatRelativePath(documentDetail.path)}</div>
              </div>
            </div>

            {Object.keys(documentDetail.frontmatter).length > 0 ? (
              <details className={styles.metadataBlock}>
                <summary className={styles.metadataSummary}>元数据</summary>
                <pre className={styles.metadataContent}>{JSON.stringify(documentDetail.frontmatter, null, 2)}</pre>
              </details>
            ) : null}

            <MarkdownViewer content={stripFrontmatter(documentDetail.content)} />
          </div>
        ) : (
          <EmptyState description="没有找到这份文档，可能已被重新扫描或删除。" icon="📄" title="文档不存在" />
        )}
      </section>
    </div>
  );
}
