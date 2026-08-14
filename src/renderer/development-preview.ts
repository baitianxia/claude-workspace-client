import type {
  AppSnapshot,
  DesktopApi,
  SessionChangedEvent,
  SessionRecord,
  TerminalDataEvent,
} from "../shared/contracts";

const now = Date.now();

const previewSnapshot: AppSnapshot = {
  projects: [
    {
      id: "mall-service",
      name: "mall-service",
      alias: "商城服务",
      pinned: true,
      rootPath: "D:\\workspace\\mall-service",
      createdAt: now - 80_000,
      lastOpenedAt: now,
    },
    {
      id: "order-center",
      name: "order-center",
      pinned: false,
      rootPath: "D:\\workspace\\order-center",
      createdAt: now - 70_000,
      lastOpenedAt: now - 1_000,
    },
    {
      id: "frontend-console",
      name: "frontend-console",
      pinned: false,
      rootPath: "D:\\workspace\\frontend-console",
      createdAt: now - 60_000,
      lastOpenedAt: now - 2_000,
    },
  ],
  sessions: [
    {
      id: "login-fix",
      projectId: "mall-service",
      title: "修复登录超时",
      cwd: "D:\\workspace\\mall-service",
      status: "running",
      createdAt: now - 50_000,
    },
    {
      id: "mall-review",
      projectId: "mall-service",
      title: "会话 2 · 16:31",
      cwd: "D:\\workspace\\mall-service",
      status: "exited",
      createdAt: now - 40_000,
      exitCode: 0,
    },
    {
      id: "refund-debug",
      projectId: "order-center",
      title: "订单退款排查",
      cwd: "D:\\workspace\\order-center",
      status: "running",
      createdAt: now - 30_000,
    },
    {
      id: "ui-upgrade",
      projectId: "frontend-console",
      title: "升级组件库",
      cwd: "D:\\workspace\\frontend-console",
      status: "failed",
      createdAt: now - 20_000,
      error: "Preview session",
    },
  ],
  claudeExecutable: {
    path: "C:\\Users\\developer\\.local\\bin\\claude.exe",
    source: "detected",
  },
};

export function installDevelopmentPreview(): void {
  let snapshot = structuredClone(previewSnapshot);
  let clipboardText = "";
  const sessionListeners = new Set<(event: SessionChangedEvent) => void>();
  const terminalListeners = new Set<(event: TerminalDataEvent) => void>();

  if (new URLSearchParams(window.location.search).has("autoConfirm")) {
    window.confirm = () => true;
  }

  const publishSession = (session: SessionRecord) => {
    for (const listener of sessionListeners) {
      listener({ session: { ...session } });
    }
  };

  if (new URLSearchParams(window.location.search).has("unreadDemo")) {
    window.setTimeout(() => {
      for (const listener of terminalListeners) {
        listener({ sessionId: "ui-upgrade", data: "new output", sequence: 1 });
      }
    }, 700);
  }

  const api: DesktopApi = {
    getSnapshot: async () => structuredClone(snapshot),
    selectProjectDirectory: async () => null,
    updateProject: async ({ projectId, alias, pinned }) => {
      const project = snapshot.projects.find((item) => item.id === projectId);
      if (!project) {
        throw new Error("Preview project does not exist.");
      }
      if (alias !== undefined) {
        const normalizedAlias = alias?.trim();
        if (normalizedAlias) {
          project.alias = normalizedAlias;
        } else {
          delete project.alias;
        }
      }
      if (pinned !== undefined) {
        project.pinned = pinned;
      }
      return { ...project };
    },
    removeProject: async (projectId) => {
      snapshot.projects = snapshot.projects.filter(
        (project) => project.id !== projectId,
      );
      snapshot.sessions = snapshot.sessions.filter(
        (session) => session.projectId !== projectId,
      );
    },
    selectClaudeExecutable: async () => snapshot.claudeExecutable,
    autoDetectClaudeExecutable: async () => snapshot.claudeExecutable,
    createSession: async ({ projectId, title }) => {
      const project = snapshot.projects.find((item) => item.id === projectId);
      if (!project) {
        throw new Error("Preview project does not exist.");
      }
      const session: SessionRecord = {
        id: crypto.randomUUID(),
        projectId,
        title: title?.trim() || `会话 ${snapshot.sessions.length + 1} · 16:40`,
        cwd: project.rootPath,
        status: "running",
        createdAt: Date.now(),
      };
      snapshot.sessions.push(session);
      publishSession(session);
      return { ...session };
    },
    renameSession: async ({ sessionId, title }) => {
      const session = snapshot.sessions.find((item) => item.id === sessionId);
      if (!session) {
        throw new Error("Preview session does not exist.");
      }
      session.title = title.trim();
      publishSession(session);
      return { ...session };
    },
    removeSession: async (sessionId) => {
      snapshot.sessions = snapshot.sessions.filter(
        (session) => session.id !== sessionId,
      );
    },
    stopSession: async (sessionId) => {
      const session = snapshot.sessions.find((item) => item.id === sessionId);
      if (session) {
        session.status = "exited";
        session.exitCode = 0;
        publishSession(session);
      }
    },
    readClipboardText: async () => clipboardText,
    writeClipboardText: async (text) => {
      clipboardText = text;
    },
    showSessionNotification: async () => undefined,
    writeTerminal: () => undefined,
    resizeTerminal: () => undefined,
    getTerminalSnapshot: async (sessionId) => ({
      data: `\u001b[38;2;218;130;96mClaude Code\u001b[0m  ${sessionId}\r\n\r\n  Development interface preview\r\n`,
      lastSequence: 0,
    }),
    onTerminalData: (listener) => {
      terminalListeners.add(listener);
      return () => terminalListeners.delete(listener);
    },
    onSessionChanged: (listener) => {
      sessionListeners.add(listener);
      return () => sessionListeners.delete(listener);
    },
  };

  window.claudeWorkspace = api;
}
