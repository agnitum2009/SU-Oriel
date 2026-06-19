import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

import { computeVisibleProjects, filterProjects, projectStatusTone } from "../../lib/project-filter.js";
import type { ProjectView } from "../../types/project.js";
import styles from "./ProjectStrip.module.css";

interface ProjectStripProps {
  projects: ProjectView[];
  selectedProjectId: string | null;
  loading: boolean;
  onSelectProject: (projectId: string) => void;
  onCreateProject: () => void;
}

const MAX_VISIBLE = 6;

/**
 * 顶部常驻项目条（项目=顶层 scope）：居左排开项目 chips、当前高亮、点一下即切；
 * 溢出进「更多」浅色搜索弹层；条尾固定「＋新建项目」。
 * 受控组件：不持有业务状态、不订阅 store；切换一律走 onSelectProject（= ConsoleLayout.handleSelectProject 的 URL 导航）。
 */
export function ProjectStrip(props: ProjectStripProps) {
  const { projects, selectedProjectId, loading, onSelectProject, onCreateProject } = props;
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [keyword, setKeyword] = useState("");
  const moreButtonRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const chipRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const { visible, overflow } = useMemo(
    () => computeVisibleProjects(projects, selectedProjectId, MAX_VISIBLE),
    [projects, selectedProjectId]
  );
  const popoverProjects = useMemo(() => filterProjects(projects, keyword), [projects, keyword]);
  const isEmpty = !loading && projects.length === 0;

  useEffect(() => {
    if (!overflowOpen) {
      return;
    }
    searchRef.current?.focus();
    function onDocumentMouseDown(event: MouseEvent) {
      const target = event.target as Node;
      if (popoverRef.current?.contains(target) || moreButtonRef.current?.contains(target)) {
        return;
      }
      setOverflowOpen(false);
      setKeyword("");
    }
    document.addEventListener("mousedown", onDocumentMouseDown);
    return () => document.removeEventListener("mousedown", onDocumentMouseDown);
  }, [overflowOpen]);

  function closeOverflow(restoreFocus: boolean) {
    setOverflowOpen(false);
    setKeyword("");
    if (restoreFocus) {
      moreButtonRef.current?.focus();
    }
  }

  function handleChipKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") {
      return;
    }
    event.preventDefault();
    const delta = event.key === "ArrowRight" ? 1 : -1;
    const nextIndex = (index + delta + visible.length) % visible.length;
    chipRefs.current[nextIndex]?.focus();
  }

  const rovingIndex = (() => {
    const selectedIndex = visible.findIndex((project) => project.id === selectedProjectId);
    return selectedIndex >= 0 ? selectedIndex : 0;
  })();

  return (
    <nav aria-label="项目切换" className={styles.strip} data-layout-region="project-strip">
      <div className={styles.chips}>
        {loading ? (
          Array.from({ length: 3 }).map((_, index) => (
            <span aria-hidden="true" className={styles.skeleton} key={index} />
          ))
        ) : isEmpty ? (
          <span className={styles.emptyHint}>还没有项目</span>
        ) : (
          visible.map((project, index) => {
            const selected = project.id === selectedProjectId;
            const tone = projectStatusTone(project);
            return (
              <button
                aria-current={selected ? "page" : undefined}
                className={styles.chip}
                data-selected={String(selected)}
                key={project.id}
                onClick={() => onSelectProject(project.id)}
                onKeyDown={(event) => handleChipKeyDown(event, index)}
                ref={(element) => {
                  chipRefs.current[index] = element;
                }}
                tabIndex={index === rovingIndex ? 0 : -1}
                title={project.localPath}
                type="button"
              >
                {tone ? <span aria-hidden="true" className={styles.dot} data-tone={tone} /> : null}
                <span className={styles.chipName}>{project.name}</span>
              </button>
            );
          })
        )}

        {overflow.length > 0 ? (
          <div className={styles.overflowWrap}>
            <button
              aria-expanded={overflowOpen}
              aria-haspopup="dialog"
              className={styles.moreButton}
              onClick={() => setOverflowOpen((value) => !value)}
              ref={moreButtonRef}
              type="button"
            >
              更多·{overflow.length}
            </button>
            {overflowOpen ? (
              <div
                aria-label="全部项目"
                className={styles.popover}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.stopPropagation();
                    closeOverflow(true);
                  }
                }}
                ref={popoverRef}
                role="dialog"
              >
                <input
                  aria-label="搜索项目"
                  className={styles.search}
                  onChange={(event) => setKeyword(event.target.value)}
                  placeholder="搜索项目…"
                  ref={searchRef}
                  value={keyword}
                />
                <div className={styles.popoverList}>
                  {popoverProjects.length === 0 ? (
                    <div className={styles.emptyHint}>没有匹配项目</div>
                  ) : (
                    popoverProjects.map((project) => (
                      <button
                        className={styles.popoverItem}
                        data-selected={String(project.id === selectedProjectId)}
                        key={project.id}
                        onClick={() => {
                          onSelectProject(project.id);
                          closeOverflow(false);
                        }}
                        type="button"
                      >
                        <span className={styles.popoverItemName}>{project.name}</span>
                        <span className={styles.popoverItemPath}>{project.localPath}</span>
                      </button>
                    ))
                  )}
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      <button
        className={styles.createButton}
        data-emphasis={isEmpty ? "primary" : "secondary"}
        onClick={onCreateProject}
        type="button"
      >
        <span aria-hidden="true">＋</span>
        <span>新建项目</span>
      </button>
    </nav>
  );
}
