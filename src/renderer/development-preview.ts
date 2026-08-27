import type {
  AppSnapshot,
  DesktopApi,
  SessionChangedEvent,
  SessionRecord,
  TerminalDataEvent,
  WeComStateChangedEvent,
  WorkspaceFileContent,
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
      id: "scratch-review",
      projectId: null,
      title: "临时需求讨论",
      cwd: "C:\\Users\\developer\\AppData\\Roaming\\Claude Workspace\\temporary-workspaces\\session-preview",
      status: "running",
      createdAt: now - 55_000,
    },
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
  wecom: {
    enabled: false,
    configured: false,
    hasSecret: false,
    botId: "",
    targetUserId: "",
    status: "disabled",
  },
};

const previewFileContents: Record<string, { latest: string; diff: string }> = {
  "README.md": {
    latest: `# 登录超时处理

本次调整把会话续期和失败重试拆成两个明确步骤。

| 状态 | 行为 |
| --- | --- |
| 即将过期 | 后台续期 |
| 已失效 | 返回登录页 |

\`\`\`mermaid
flowchart LR
  A[读取会话] --> B{是否过期}
  B -- 否 --> C[继续请求]
  B -- 是 --> D[刷新令牌]
  D --> C
\`\`\`

> Mermaid 使用严格安全模式在本地渲染。
`,
    diff: `diff --git a/README.md b/README.md
index 7741a3c..b11d5f1 100644
--- a/README.md
+++ b/README.md
@@ -1,3 +1,8 @@
 # 登录超时处理

-会话过期后重新登录。
+本次调整把会话续期和失败重试拆成两个明确步骤。
+
+\`\`\`mermaid
+flowchart LR
+  A[读取会话] --> B{是否过期}
+\`\`\`
`,
  },
  "src/auth/session.ts": {
    latest: `export async function refreshSession(token: string) {
  const response = await fetch("/api/session/refresh", {
    method: "POST",
    headers: { Authorization: \`Bearer \${token}\` },
  });

  if (!response.ok) {
    throw new Error("Session refresh failed");
  }
  return response.json();
}
`,
    diff: `diff --git a/src/auth/session.ts b/src/auth/session.ts
index 30940bc..9a142d3 100644
--- a/src/auth/session.ts
+++ b/src/auth/session.ts
@@ -1,5 +1,11 @@
 export async function refreshSession(token: string) {
-  return fetch("/api/session/refresh");
+  const response = await fetch("/api/session/refresh", {
+    method: "POST",
+    headers: { Authorization: \`Bearer \${token}\` },
+  });
+  if (!response.ok) {
+    throw new Error("Session refresh failed");
+  }
+  return response.json();
 }
`,
  },
  "src/auth/session.test.ts": {
    latest: `import { expect, it } from "vitest";

it("refreshes an active session", async () => {
  await expect(Promise.resolve("ok")).resolves.toBe("ok");
});
`,
    diff: `diff --git a/src/auth/session.test.ts b/src/auth/session.test.ts
new file mode 100644
--- /dev/null
+++ b/src/auth/session.test.ts
@@ -0,0 +1,5 @@
+import { expect, it } from "vitest";
+
+it("refreshes an active session", async () => {
+  await expect(Promise.resolve("ok")).resolves.toBe("ok");
+});
`,
  },
};

export function installDevelopmentPreview(): void {
  let snapshot = structuredClone(previewSnapshot);
  let clipboardText = "";
  const sessionListeners = new Set<(event: SessionChangedEvent) => void>();
  const terminalListeners = new Set<(event: TerminalDataEvent) => void>();
  const wecomListeners = new Set<(event: WeComStateChangedEvent) => void>();

  if (new URLSearchParams(window.location.search).has("autoConfirm")) {
    window.confirm = () => true;
  }

  const publishSession = (session: SessionRecord) => {
    for (const listener of sessionListeners) {
      listener({ session: { ...session } });
    }
  };

  const publishWeCom = () => {
    for (const listener of wecomListeners) {
      listener({ state: { ...snapshot.wecom } });
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
    updateWeComConfig: async (request) => {
      snapshot.wecom = {
        enabled: request.enabled,
        configured: Boolean(
          request.botId.trim() &&
            request.targetUserId.trim() &&
            (request.secret?.trim() || snapshot.wecom.hasSecret),
        ),
        hasSecret: Boolean(request.secret?.trim() || snapshot.wecom.hasSecret),
        botId: request.botId.trim(),
        targetUserId: request.targetUserId.trim(),
        status: request.enabled ? "connected" : "disabled",
      };
      publishWeCom();
      return { ...snapshot.wecom };
    },
    createSession: async (request) => {
      const project =
        request.scope === "project"
          ? snapshot.projects.find((item) => item.id === request.projectId)
          : undefined;
      if (request.scope === "project" && !project) {
        throw new Error("Preview project does not exist.");
      }
      const projectId = request.scope === "project" ? request.projectId : null;
      const cwd =
        request.scope === "temporary"
          ? `C:\\Users\\developer\\AppData\\Roaming\\Claude Workspace\\temporary-workspaces\\session-${snapshot.sessions.length + 1}`
          : project!.rootPath;
      const session: SessionRecord = {
        id: crypto.randomUUID(),
        projectId,
        title:
          request.title?.trim() ||
          `会话 ${snapshot.sessions.length + 1} · 16:40`,
        cwd,
        status: "running",
        createdAt: Date.now(),
      };
      snapshot.sessions.push(session);
      publishSession(session);
      return { ...session };
    },
    restartSession: async (sessionId) => {
      const session = snapshot.sessions.find((item) => item.id === sessionId);
      if (!session) {
        throw new Error("Preview session does not exist.");
      }
      if (session.status === "running" || session.status === "starting") {
        throw new Error("Preview session is still running.");
      }
      session.status = "starting";
      delete session.exitCode;
      delete session.error;
      publishSession(session);
      session.status = "running";
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
    listWorkspaceChanges: async (projectId) => ({
      isGitRepository: true,
      truncated: false,
      files:
        projectId === "mall-service"
          ? [
              {
                path: "README.md",
                status: "modified",
                staged: false,
                unstaged: true,
              },
              {
                path: "src/auth/session.ts",
                status: "modified",
                staged: true,
                unstaged: true,
              },
              {
                path: "src/auth/session.test.ts",
                status: "untracked",
                staged: false,
                unstaged: true,
              },
            ]
          : [],
    }),
    readWorkspaceFile: async ({ path, mode }) => {
      const file = previewFileContents[path];
      if (!file) {
        throw new Error("Preview file does not exist.");
      }
      const content: WorkspaceFileContent = {
        path,
        mode,
        kind: "text",
        content: file[mode],
        size: new TextEncoder().encode(file[mode]).length,
      };
      return content;
    },
    onTerminalData: (listener) => {
      terminalListeners.add(listener);
      return () => terminalListeners.delete(listener);
    },
    onSessionChanged: (listener) => {
      sessionListeners.add(listener);
      return () => sessionListeners.delete(listener);
    },
    onWeComStateChanged: (listener) => {
      wecomListeners.add(listener);
      return () => wecomListeners.delete(listener);
    },
  };

  window.claudeWorkspace = api;
}
