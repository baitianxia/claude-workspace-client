import { useEffect, useMemo, useState } from "react";
import type {
  AppSnapshot,
  ClaudeExecutableState,
  ProjectRecord,
  SessionRecord,
} from "../shared/contracts";
import { TerminalView } from "./TerminalView";

function readableError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/^Error invoking remote method '[^']+': Error: /u, "");
}

function statusLabel(status: SessionRecord["status"]): string {
  switch (status) {
    case "starting":
      return "启动中";
    case "running":
      return "运行中";
    case "exited":
      return "已退出";
    case "failed":
      return "失败";
  }
}

function executableName(state: ClaudeExecutableState): string {
  if (!state.path) {
    return "未找到 Claude Code";
  }
  const parts = state.path.split(/[\\/]/u);
  return parts.at(-1) ?? state.path;
}

function upsertSession(
  sessions: SessionRecord[],
  replacement: SessionRecord,
): SessionRecord[] {
  const index = sessions.findIndex((session) => session.id === replacement.id);
  if (index < 0) {
    return [...sessions, replacement];
  }
  const next = [...sessions];
  next[index] = replacement;
  return next;
}

const COLLAPSED_PROJECTS_KEY = "claude-workspace.collapsed-projects.v1";

function loadCollapsedProjectIds(): Set<string> {
  try {
    const stored = JSON.parse(
      window.localStorage.getItem(COLLAPSED_PROJECTS_KEY) ?? "[]",
    ) as unknown;
    if (!Array.isArray(stored)) {
      return new Set();
    }
    return new Set(
      stored.filter((projectId): projectId is string => typeof projectId === "string"),
    );
  } catch {
    return new Set();
  }
}

export function App() {
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [collapsedProjectIds, setCollapsedProjectIds] = useState(
    loadCollapsedProjectIds,
  );
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null);
  const [sessionTitleDraft, setSessionTitleDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        COLLAPSED_PROJECTS_KEY,
        JSON.stringify([...collapsedProjectIds]),
      );
    } catch {
      // A locked-down renderer can still use folding for the current run.
    }
  }, [collapsedProjectIds]);

  useEffect(() => {
    let disposed = false;
    const unsubscribe = window.claudeWorkspace.onSessionChanged(({ session }) => {
      if (disposed) {
        return;
      }
      setSnapshot((current) =>
        current
          ? { ...current, sessions: upsertSession(current.sessions, session) }
          : current,
      );
    });

    void window.claudeWorkspace
      .getSnapshot()
      .then((initialSnapshot) => {
        if (disposed) {
          return;
        }
        setSnapshot(initialSnapshot);
        const firstProject = initialSnapshot.projects[0];
        if (firstProject) {
          setActiveProjectId(firstProject.id);
          const firstSession = initialSnapshot.sessions.find(
            (session) => session.projectId === firstProject.id,
          );
          setActiveSessionId(firstSession?.id ?? null);
        }
      })
      .catch((initializationError: unknown) => {
        if (!disposed) {
          setError(readableError(initializationError));
        }
      });

    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);

  const projects = snapshot?.projects ?? [];
  const sessions = snapshot?.sessions ?? [];
  const activeProject = projects.find((project) => project.id === activeProjectId);
  const activeSession = sessions.find((session) => session.id === activeSessionId);

  const sessionsByProject = useMemo(() => {
    const grouped = new Map<string, SessionRecord[]>();
    for (const session of sessions) {
      const projectSessions = grouped.get(session.projectId) ?? [];
      projectSessions.push(session);
      grouped.set(session.projectId, projectSessions);
    }
    return grouped;
  }, [sessions]);

  const runAction = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (actionError) {
      setError(readableError(actionError));
    } finally {
      setBusy(false);
    }
  };

  const addProject = () =>
    runAction(async () => {
      const project = await window.claudeWorkspace.selectProjectDirectory();
      if (!project) {
        return;
      }
      setSnapshot((current) => {
        if (!current) {
          return current;
        }
        const withoutDuplicate = current.projects.filter(
          (candidate) => candidate.id !== project.id,
        );
        return { ...current, projects: [project, ...withoutDuplicate] };
      });
      setActiveProjectId(project.id);
      setCollapsedProjectIds((current) => {
        const next = new Set(current);
        next.delete(project.id);
        return next;
      });
      const existingSession = sessions.find(
        (session) => session.projectId === project.id,
      );
      setActiveSessionId(existingSession?.id ?? null);
    });

  const chooseClaudeExecutable = () =>
    runAction(async () => {
      const claudeExecutable =
        await window.claudeWorkspace.selectClaudeExecutable();
      if (claudeExecutable) {
        setSnapshot((current) =>
          current ? { ...current, claudeExecutable } : current,
        );
      }
    });

  const detectClaudeExecutable = () =>
    runAction(async () => {
      const claudeExecutable =
        await window.claudeWorkspace.autoDetectClaudeExecutable();
      setSnapshot((current) =>
        current ? { ...current, claudeExecutable } : current,
      );
    });

  const createSession = (project: ProjectRecord) =>
    runAction(async () => {
      const session = await window.claudeWorkspace.createSession({
        projectId: project.id,
      });
      setSnapshot((current) =>
        current
          ? { ...current, sessions: upsertSession(current.sessions, session) }
          : current,
      );
      setActiveProjectId(project.id);
      setActiveSessionId(session.id);
      setCollapsedProjectIds((current) => {
        const next = new Set(current);
        next.delete(project.id);
        return next;
      });
    });

  const toggleProject = (projectId: string) => {
    setCollapsedProjectIds((current) => {
      const next = new Set(current);
      if (next.has(projectId)) {
        next.delete(projectId);
      } else {
        next.add(projectId);
      }
      return next;
    });
  };

  const startRenamingSession = (session: SessionRecord) => {
    setActiveProjectId(session.projectId);
    setActiveSessionId(session.id);
    setCollapsedProjectIds((current) => {
      const next = new Set(current);
      next.delete(session.projectId);
      return next;
    });
    setSessionTitleDraft(session.title);
    setRenamingSessionId(session.id);
  };

  const commitSessionRename = (session: SessionRecord) => {
    const title = sessionTitleDraft.trim();
    if (!title) {
      setError("会话名称不能为空。");
      return;
    }

    setRenamingSessionId(null);
    if (title === session.title) {
      return;
    }

    void runAction(async () => {
      const renamed = await window.claudeWorkspace.renameSession({
        sessionId: session.id,
        title,
      });
      setSnapshot((current) =>
        current
          ? { ...current, sessions: upsertSession(current.sessions, renamed) }
          : current,
      );
    });
  };

  const removeSession = (session: SessionRecord) => {
    const isRunning =
      session.status === "running" || session.status === "starting";
    const warning = isRunning
      ? `删除“${session.title}”会终止正在运行的 Claude Code 进程，并从列表移除。Claude Code 历史记录不会删除，是否继续？`
      : `从列表删除“${session.title}”？Claude Code 历史记录不会删除。`;
    if (!window.confirm(warning)) {
      return;
    }

    void runAction(async () => {
      await window.claudeWorkspace.removeSession(session.id);
      const projectSessions = sessionsByProject.get(session.projectId) ?? [];
      const removedIndex = projectSessions.findIndex(
        (candidate) => candidate.id === session.id,
      );
      const remainingProjectSessions = projectSessions.filter(
        (candidate) => candidate.id !== session.id,
      );
      const nextSession =
        remainingProjectSessions.length > 0
          ? remainingProjectSessions[
              Math.min(
                Math.max(removedIndex, 0),
                remainingProjectSessions.length - 1,
              )
            ]
          : undefined;

      setSnapshot((current) =>
        current
          ? {
              ...current,
              sessions: current.sessions.filter(
                (candidate) => candidate.id !== session.id,
              ),
            }
          : current,
      );
      if (renamingSessionId === session.id) {
        setRenamingSessionId(null);
      }
      if (activeSessionId === session.id) {
        setActiveProjectId(session.projectId);
        setActiveSessionId(nextSession?.id ?? null);
      }
    });
  };

  const removeProject = (project: ProjectRecord) => {
    const projectSessions = sessionsByProject.get(project.id) ?? [];
    const warning = projectSessions.some(
      (session) => session.status === "running" || session.status === "starting",
    )
      ? `“${project.name}”仍有会话运行。移除工程会终止这些会话，是否继续？`
      : `从列表中移除“${project.name}”？不会删除磁盘文件。`;
    if (!window.confirm(warning)) {
      return;
    }

    void runAction(async () => {
      await window.claudeWorkspace.removeProject(project.id);
      const remainingProjects = projects.filter(
        (candidate) => candidate.id !== project.id,
      );
      setSnapshot((current) =>
        current
          ? {
              ...current,
              projects: current.projects.filter(
                (candidate) => candidate.id !== project.id,
              ),
              sessions: current.sessions.filter(
                (session) => session.projectId !== project.id,
              ),
            }
          : current,
      );
      setCollapsedProjectIds((current) => {
        const next = new Set(current);
        next.delete(project.id);
        return next;
      });
      if (renamingSessionId) {
        const renamedSession = sessions.find(
          (session) => session.id === renamingSessionId,
        );
        if (renamedSession?.projectId === project.id) {
          setRenamingSessionId(null);
        }
      }
      if (activeProjectId === project.id) {
        const nextProject = remainingProjects[0];
        setActiveProjectId(nextProject?.id ?? null);
        setActiveSessionId(
          nextProject
            ? sessions.find((session) => session.projectId === nextProject.id)?.id ??
                null
            : null,
        );
      }
    });
  };

  const stopSession = (session: SessionRecord) =>
    runAction(() => window.claudeWorkspace.stopSession(session.id));

  if (!snapshot) {
    return (
      <main className="loading-screen">
        <div className="brand-mark">C</div>
        <div>
          <h1>Claude Workspace</h1>
          <p>{error ?? "正在读取本地工作区…"}</p>
        </div>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <header className="sidebar-header">
          <div className="brand-row">
            <div className="brand-mark brand-mark--small">C</div>
            <div>
              <h1>Claude Workspace</h1>
              <p>本地多工程控制台</p>
            </div>
          </div>
        </header>

        <section className="claude-runtime-card">
          <div className="runtime-heading">
            <span
              className={`status-dot ${snapshot.claudeExecutable.path ? "status-dot--online" : "status-dot--offline"}`}
            />
            <div>
              <strong>{executableName(snapshot.claudeExecutable)}</strong>
              <span>
                {snapshot.claudeExecutable.path
                  ? snapshot.claudeExecutable.source === "custom"
                    ? "手动配置"
                    : "自动发现"
                  : "无法启动会话"}
              </span>
            </div>
          </div>
          <div className="runtime-actions">
            <button type="button" onClick={detectClaudeExecutable} disabled={busy}>
              重新检测
            </button>
            <button type="button" onClick={chooseClaudeExecutable} disabled={busy}>
              选择文件
            </button>
          </div>
        </section>

        <div className="section-heading">
          <span>工程与会话</span>
          <button
            className="icon-button"
            type="button"
            title="添加工程目录"
            onClick={addProject}
            disabled={busy}
          >
            ＋
          </button>
        </div>

        <nav className="project-list" aria-label="工程与会话">
          {projects.map((project) => {
            const projectSessions = sessionsByProject.get(project.id) ?? [];
            const selected = activeProjectId === project.id;
            const collapsed = collapsedProjectIds.has(project.id);
            const sessionListId = `project-sessions-${project.id}`;
            return (
              <section
                className={`project-group ${selected ? "project-group--active" : ""}`}
                key={project.id}
              >
                <div className="project-row">
                  <button
                    className="project-collapse-button"
                    type="button"
                    title={collapsed ? "展开工程会话" : "折叠工程会话"}
                    aria-label={collapsed ? `展开 ${project.name}` : `折叠 ${project.name}`}
                    aria-expanded={!collapsed}
                    aria-controls={sessionListId}
                    onClick={() => toggleProject(project.id)}
                  >
                    <span
                      className={`project-chevron ${collapsed ? "" : "project-chevron--expanded"}`}
                      aria-hidden="true"
                    >
                      ›
                    </span>
                  </button>
                  <button
                    className="project-select"
                    type="button"
                    onClick={() => {
                      setActiveProjectId(project.id);
                      setActiveSessionId(projectSessions[0]?.id ?? null);
                    }}
                    title={project.rootPath}
                  >
                    <span className="folder-icon" aria-hidden="true" />
                    <span className="project-copy">
                      <strong>{project.name}</strong>
                      <span>{project.rootPath}</span>
                    </span>
                  </button>
                  <span
                    className="project-session-count"
                    title={`${projectSessions.length} 个会话`}
                  >
                    {projectSessions.length}
                  </span>
                  <button
                    className="project-menu-button"
                    type="button"
                    title="移除工程"
                    onClick={() => removeProject(project)}
                  >
                    ×
                  </button>
                </div>

                {!collapsed ? (
                  <div className="session-list" id={sessionListId}>
                    {projectSessions.map((session) =>
                      renamingSessionId === session.id ? (
                        <form
                          className="session-rename-form"
                          key={session.id}
                          onSubmit={(event) => {
                            event.preventDefault();
                            commitSessionRename(session);
                          }}
                        >
                          <input
                            type="text"
                            value={sessionTitleDraft}
                            maxLength={80}
                            aria-label="会话名称"
                            autoFocus
                            onFocus={(event) => event.currentTarget.select()}
                            onChange={(event) =>
                              setSessionTitleDraft(event.currentTarget.value)
                            }
                            onKeyDown={(event) => {
                              if (event.key === "Escape") {
                                event.preventDefault();
                                setRenamingSessionId(null);
                              }
                            }}
                          />
                          <button
                            className="session-edit-action session-edit-action--save"
                            type="submit"
                            title="保存名称"
                            aria-label="保存会话名称"
                            disabled={busy}
                          >
                            ✓
                          </button>
                          <button
                            className="session-edit-action"
                            type="button"
                            title="取消"
                            aria-label="取消重命名"
                            onClick={() => setRenamingSessionId(null)}
                          >
                            ×
                          </button>
                        </form>
                      ) : (
                        <div
                          className={`session-row ${activeSessionId === session.id ? "session-row--active" : ""}`}
                          key={session.id}
                        >
                          <button
                            className="session-select"
                            type="button"
                            title={`${session.title}（双击重命名）`}
                            onClick={() => {
                              setActiveProjectId(project.id);
                              setActiveSessionId(session.id);
                            }}
                            onDoubleClick={() => startRenamingSession(session)}
                          >
                            <span
                              className={`session-indicator session-indicator--${session.status}`}
                            />
                            <span>{session.title}</span>
                            <small>{statusLabel(session.status)}</small>
                          </button>
                          <button
                            className="session-rename-button"
                            type="button"
                            title="重命名会话"
                            aria-label={`重命名 ${session.title}`}
                            onClick={() => startRenamingSession(session)}
                          >
                            ✎
                          </button>
                          <button
                            className="session-delete-button"
                            type="button"
                            title="删除会话"
                            aria-label={`删除 ${session.title}`}
                            onClick={() => removeSession(session)}
                          >
                            ×
                          </button>
                        </div>
                      ),
                    )}
                    <button
                      className="new-session-button"
                      type="button"
                      onClick={() => createSession(project)}
                      disabled={busy || !snapshot.claudeExecutable.path}
                    >
                      <span>＋</span> 新建会话
                    </button>
                  </div>
                ) : null}
              </section>
            );
          })}
        </nav>

        <button
          className="add-project-button"
          type="button"
          onClick={addProject}
          disabled={busy}
        >
          <span>＋</span>
          选择工程文件夹
        </button>
      </aside>

      <section className="workspace-panel">
        {activeSession && activeProject ? (
          <>
            <header className="workspace-toolbar">
              <div className="toolbar-title">
                <div className="toolbar-breadcrumb">
                  <span>{activeProject.name}</span>
                  <span className="breadcrumb-divider">/</span>
                  <strong>{activeSession.title}</strong>
                </div>
                <p title={activeSession.cwd}>{activeSession.cwd}</p>
              </div>
              <div className="toolbar-actions">
                <button
                  className="toolbar-rename-button"
                  type="button"
                  onClick={() => startRenamingSession(activeSession)}
                  disabled={busy}
                >
                  重命名
                </button>
                <button
                  className="toolbar-delete-button"
                  type="button"
                  onClick={() => removeSession(activeSession)}
                  disabled={busy}
                >
                  删除
                </button>
                <span
                  className={`session-status-chip session-status-chip--${activeSession.status}`}
                >
                  {statusLabel(activeSession.status)}
                </span>
                {activeSession.status === "running" ? (
                  <button
                    className="stop-button"
                    type="button"
                    onClick={() => stopSession(activeSession)}
                    disabled={busy}
                  >
                    停止会话
                  </button>
                ) : (
                  <button
                    className="primary-button primary-button--compact"
                    type="button"
                    onClick={() => createSession(activeProject)}
                    disabled={busy || !snapshot.claudeExecutable.path}
                  >
                    新建会话
                  </button>
                )}
              </div>
            </header>
            <div className="terminal-stack">
              {sessions.map((session) => (
                <TerminalView
                  key={session.id}
                  session={session}
                  active={session.id === activeSessionId}
                />
              ))}
            </div>
          </>
        ) : activeProject ? (
          <div className="empty-state">
            <div className="empty-terminal-glyph">›_</div>
            <h2>在 {activeProject.name} 中启动 Claude Code</h2>
            <p>{activeProject.rootPath}</p>
            <p className="empty-state-note">
              新会话会直接以该文件夹作为工作目录，Claude Code 将读取这里的
              CLAUDE.md、Git 和项目配置。
            </p>
            <button
              className="primary-button"
              type="button"
              onClick={() => createSession(activeProject)}
              disabled={busy || !snapshot.claudeExecutable.path}
            >
              启动 Claude Code
            </button>
            {!snapshot.claudeExecutable.path ? (
              <button
                className="text-button"
                type="button"
                onClick={chooseClaudeExecutable}
                disabled={busy}
              >
                先选择本机 claude.exe
              </button>
            ) : null}
          </div>
        ) : (
          <div className="empty-state empty-state--welcome">
            <div className="welcome-orbit" aria-hidden="true">
              <span />
              <span />
              <span />
            </div>
            <p className="eyebrow">WINDOWS DESKTOP WORKSPACE</p>
            <h2>一个窗口，管理所有 Claude Code 会话</h2>
            <p>
              选择本地工程文件夹。每个会话都会在对应目录运行，无需打开多个
              IntelliJ IDEA 窗口。
            </p>
            <button
              className="primary-button"
              type="button"
              onClick={addProject}
              disabled={busy}
            >
              选择第一个工程文件夹
            </button>
          </div>
        )}

        {error ? (
          <div className="error-toast" role="alert">
            <div>
              <strong>操作失败</strong>
              <span>{error}</span>
            </div>
            <button type="button" onClick={() => setError(null)} aria-label="关闭">
              ×
            </button>
          </div>
        ) : null}
      </section>
    </main>
  );
}
