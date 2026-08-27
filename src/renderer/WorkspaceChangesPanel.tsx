import { useEffect, useMemo, useState } from "react";
import type {
  ProjectRecord,
  WorkspaceChangesSnapshot,
  WorkspaceFileChange,
  WorkspaceFileContent,
  WorkspaceFileStatus,
  WorkspaceFileViewMode,
} from "../shared/contracts";
import {
  DiffViewer,
  HighlightedCode,
  isMarkdownPath,
  languageForPath,
} from "./code-rendering";
import { MarkdownPreview } from "./MarkdownPreview";

function readableError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/^Error invoking remote method '[^']+': Error: /u, "");
}

const statusLabels: Record<WorkspaceFileStatus, string> = {
  modified: "修改",
  added: "新增",
  deleted: "删除",
  renamed: "重命名",
  copied: "复制",
  untracked: "未跟踪",
  conflicted: "冲突",
};

function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) {
    return "";
  }
  if (bytes < 1_024) {
    return `${bytes} B`;
  }
  if (bytes < 1_024 * 1_024) {
    return `${(bytes / 1_024).toFixed(1)} KB`;
  }
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MB`;
}

function FileRow({
  file,
  selected,
  onSelect,
}: {
  file: WorkspaceFileChange;
  selected: boolean;
  onSelect(): void;
}) {
  const parts = file.path.split("/");
  const filename = parts.pop() ?? file.path;
  const directory = parts.join("/");
  return (
    <button
      className={`change-file-row ${selected ? "change-file-row--selected" : ""}`}
      type="button"
      title={file.previousPath ? `${file.previousPath} → ${file.path}` : file.path}
      onClick={onSelect}
    >
      <span className={`change-status change-status--${file.status}`}>
        {statusLabels[file.status]}
      </span>
      <span className="change-file-copy">
        <strong>{filename}</strong>
        <small>{directory || "工程根目录"}</small>
      </span>
      <span className="change-stages" aria-label={`${file.staged ? "已暂存" : ""}${file.staged && file.unstaged ? "，" : ""}${file.unstaged ? "工作区修改" : ""}`}>
        {file.staged ? <span title="已暂存">S</span> : null}
        {file.unstaged ? <span title="工作区修改">W</span> : null}
      </span>
    </button>
  );
}

function EmptyContent({ content }: { content: WorkspaceFileContent }) {
  let title: string;
  let description: string;
  switch (content.kind) {
    case "binary":
      title = "二进制文件";
      description = "当前版本不显示二进制内容。";
      break;
    case "deleted":
      title = "文件已删除";
      description = "最新内容在工作区中已不存在，请切换到“对比”查看删除内容。";
      break;
    case "too-large":
      title = "文件过大";
      description = `内容超过 2 MB 的预览限制${content.size ? `（${formatBytes(content.size)}）` : ""}。`;
      break;
    case "text":
      return null;
  }
  return (
    <div className="change-content-empty">
      <span aria-hidden="true">{content.kind === "deleted" ? "−" : "…"}</span>
      <strong>{title}</strong>
      <p>{description}</p>
    </div>
  );
}

export function WorkspaceChangesPanel({
  project,
  onClose,
}: {
  project: ProjectRecord;
  onClose(): void;
}) {
  const [snapshot, setSnapshot] = useState<WorkspaceChangesSnapshot | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<WorkspaceFileViewMode>("diff");
  const [markdownMode, setMarkdownMode] = useState<"preview" | "source">("preview");
  const [content, setContent] = useState<WorkspaceFileContent | null>(null);
  const [listRefreshVersion, setListRefreshVersion] = useState(0);
  const [contentRefreshVersion, setContentRefreshVersion] = useState(0);
  const [listLoading, setListLoading] = useState(true);
  const [contentLoading, setContentLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [contentError, setContentError] = useState<string | null>(null);

  useEffect(() => {
    const timer = window.setInterval(
      () => setListRefreshVersion((version) => version + 1),
      4_000,
    );
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let disposed = false;
    if (!snapshot) {
      setListLoading(true);
    }
    void window.claudeWorkspace
      .listWorkspaceChanges(project.id)
      .then((nextSnapshot) => {
        if (disposed) {
          return;
        }
        setSnapshot(nextSnapshot);
        setSelectedPath((current) =>
          current && nextSnapshot.files.some((file) => file.path === current)
            ? current
            : nextSnapshot.files[0]?.path ?? null,
        );
        setListError(null);
      })
      .catch((listError: unknown) => {
        if (!disposed) {
          setListError(readableError(listError));
        }
      })
      .finally(() => {
        if (!disposed) {
          setListLoading(false);
        }
      });
    return () => {
      disposed = true;
    };
  }, [project.id, listRefreshVersion]);

  useEffect(() => {
    if (!selectedPath) {
      setContent(null);
      return;
    }
    let disposed = false;
    setContentLoading(
      content?.path !== selectedPath || content.mode !== viewMode,
    );
    void window.claudeWorkspace
      .readWorkspaceFile({
        projectId: project.id,
        path: selectedPath,
        mode: viewMode,
      })
      .then((nextContent) => {
        if (!disposed) {
          setContent(nextContent);
          setContentError(null);
        }
      })
      .catch((contentError: unknown) => {
        if (!disposed) {
          setContent(null);
          setContentError(readableError(contentError));
        }
      })
      .finally(() => {
        if (!disposed) {
          setContentLoading(false);
        }
      });
    return () => {
      disposed = true;
    };
  }, [contentRefreshVersion, project.id, selectedPath, viewMode]);

  const selectedFile = useMemo(
    () => snapshot?.files.find((file) => file.path === selectedPath),
    [selectedPath, snapshot],
  );
  const markdown = Boolean(selectedPath && isMarkdownPath(selectedPath));

  return (
    <aside className="changes-panel" aria-label={`${project.name} 修改文件`}>
      <header className="changes-panel-header">
        <div>
          <span className="changes-panel-eyebrow">WORKSPACE CHANGES</span>
          <h2>修改文件</h2>
          <p title={project.rootPath}>{project.rootPath}</p>
        </div>
        <div className="changes-panel-header-actions">
          <button
            type="button"
            title="刷新修改文件"
            aria-label="刷新修改文件"
            disabled={listLoading}
            onClick={() => {
              setListRefreshVersion((version) => version + 1);
              setContentRefreshVersion((version) => version + 1);
            }}
          >
            ↻
          </button>
          <button type="button" title="关闭" aria-label="关闭修改文件侧栏" onClick={onClose}>
            ×
          </button>
        </div>
      </header>

      <div className="changes-panel-body">
        <section className="change-file-list" aria-label="修改文件列表">
          <div className="change-file-list-heading">
            <strong>{snapshot?.files.length ?? 0} 个文件</strong>
            {listLoading ? <span>刷新中…</span> : null}
          </div>
          {snapshot && !snapshot.isGitRepository ? (
            <div className="change-list-message">
              <strong>不是 Git 仓库</strong>
              <span>当前工程没有可读取的 Git 修改列表。</span>
            </div>
          ) : snapshot?.files.length === 0 ? (
            <div className="change-list-message">
              <strong>工作区干净</strong>
              <span>暂时没有已修改或未跟踪文件。</span>
            </div>
          ) : (
            snapshot?.files.map((file) => (
              <FileRow
                file={file}
                key={file.path}
                selected={file.path === selectedPath}
                onSelect={() => setSelectedPath(file.path)}
              />
            ))
          )}
          {snapshot?.truncated ? (
            <div className="change-list-warning">仅显示前 2,000 个修改文件。</div>
          ) : null}
        </section>

        <section className="change-content-panel" aria-label="文件内容">
          {selectedFile ? (
            <>
              <header className="change-content-header">
                <div>
                  <strong title={selectedFile.path}>{selectedFile.path}</strong>
                  <span>
                    {statusLabels[selectedFile.status]}
                    {content?.size !== undefined ? ` · ${formatBytes(content.size)}` : ""}
                  </span>
                </div>
                <div className="change-view-tabs" role="tablist" aria-label="文件查看方式">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={viewMode === "diff"}
                    className={viewMode === "diff" ? "change-view-tab--active" : ""}
                    onClick={() => setViewMode("diff")}
                  >
                    对比
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={viewMode === "latest"}
                    className={viewMode === "latest" ? "change-view-tab--active" : ""}
                    onClick={() => setViewMode("latest")}
                  >
                    最新内容
                  </button>
                </div>
              </header>
              {markdown && viewMode === "latest" && content?.kind === "text" ? (
                <div className="markdown-view-tabs" role="tablist" aria-label="Markdown 查看方式">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={markdownMode === "preview"}
                    className={markdownMode === "preview" ? "markdown-view-tab--active" : ""}
                    onClick={() => setMarkdownMode("preview")}
                  >
                    渲染
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={markdownMode === "source"}
                    className={markdownMode === "source" ? "markdown-view-tab--active" : ""}
                    onClick={() => setMarkdownMode("source")}
                  >
                    源码
                  </button>
                </div>
              ) : null}
              <div className="change-content-scroll">
                {contentLoading ? (
                  <div className="change-content-loading">正在读取文件…</div>
                ) : content?.kind === "text" ? (
                  viewMode === "diff" ? (
                    content.content ? (
                      <DiffViewer content={content.content} />
                    ) : (
                      <div className="change-content-empty">
                        <strong>没有文本差异</strong>
                        <p>文件状态已变化，请刷新修改列表。</p>
                      </div>
                    )
                  ) : markdown && markdownMode === "preview" ? (
                    <MarkdownPreview content={content.content} />
                  ) : (
                    <HighlightedCode
                      content={content.content}
                      language={languageForPath(content.path)}
                    />
                  )
                ) : content ? (
                  <EmptyContent content={content} />
                ) : contentError ? (
                  <div className="change-content-empty change-content-empty--error">
                    <strong>无法读取文件</strong>
                    <p>{contentError}</p>
                  </div>
                ) : null}
              </div>
            </>
          ) : (
            <div className="change-content-empty">
              <span aria-hidden="true">{`{ }`}</span>
              <strong>选择一个修改文件</strong>
              <p>可以查看相对 HEAD 的对比，或工作区中的最新内容。</p>
            </div>
          )}
        </section>
      </div>
      {listError ? (
        <div className="changes-panel-error" role="alert">{listError}</div>
      ) : null}
    </aside>
  );
}
