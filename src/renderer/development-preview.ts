import type {
  AppSnapshot,
  AutomationJobRecord,
  AutomationRunRecord,
  AutomationStateChangedEvent,
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
    enabled: true,
    configured: true,
    hasSecret: true,
    botId: "aibot-preview-news",
    targetUserId: "developer",
    status: "connected",
  },
  automation: {
    discoveredWeComGroups: [
      {
        chatId: "wr-preview-group",
        alias: "每日资讯群",
        discoveredAt: now - 240_000,
        lastSeenAt: now - 18_000,
      },
      {
        chatId: "wr-product-watch",
        alias: "产品观察群",
        discoveredAt: now - 180_000,
        lastSeenAt: now - 45_000,
      },
      {
        chatId: "wr-unnamed-preview-group",
        discoveredAt: now - 120_000,
        lastSeenAt: now - 72_000,
      },
    ],
    jobs: [
      {
        id: "daily-industry-news",
        name: "每日行业资讯",
        enabled: true,
        projectId: "mall-service",
        schedule: "0 9 * * 1-5",
        mcpConfigPath: ".mcp.json",
        allowedMcpServers: ["web", "mail"],
        prompt: "读取配置中的行业网页，只整理新出现且与业务相关的信息。",
        emailRecipients: ["owner@example.com"],
        wecomTargetIds: ["wr-preview-group"],
        allowedWecomUserIds: ["developer"],
        timeoutMinutes: 20,
        maxTurns: 20,
        createdAt: now - 90_000,
        updatedAt: now - 90_000,
      },
    ],
    runs: [
      {
        id: "preview-run",
        reportCode: "A1B2C3D4E5",
        jobId: "daily-industry-news",
        jobName: "每日行业资讯",
        trigger: "scheduled",
        status: "succeeded",
        attempt: 1,
        createdAt: now - 40_000,
        startedAt: now - 39_000,
        finishedAt: now - 12_000,
        result: {
          outcome: "notify",
          summary: "发现 2 条新的行业信息，并已生成群摘要。",
          wecomMarkdown: "## 今日行业资讯\n\n发现 2 条新信息。",
          evidence: [
            { title: "示例来源", url: "https://example.com/news" },
          ],
          email: {
            status: "sent",
            recipients: ["owner@example.com"],
            detail: "邮件 MCP 返回发送成功。",
          },
        },
        deliveries: [
          {
            targetId: "wr-preview-group",
            status: "sent",
            attempts: 1,
            sentAt: now - 11_000,
          },
        ],
      },
    ],
    runningJobIds: [],
    schedulerActive: true,
    lastSchedulerCheckAt: now,
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
  const automationListeners = new Set<
    (event: AutomationStateChangedEvent) => void
  >();

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

  const publishAutomation = () => {
    for (const listener of automationListeners) {
      listener({ state: structuredClone(snapshot.automation) });
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
    upsertAutomationJob: async (request) => {
      const existing = request.id
        ? snapshot.automation.jobs.find((job) => job.id === request.id)
        : undefined;
      const timestamp = Date.now();
      const job: AutomationJobRecord = {
        ...request,
        id: existing?.id ?? crypto.randomUUID(),
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
      };
      snapshot.automation.jobs = [
        ...snapshot.automation.jobs.filter((candidate) => candidate.id !== job.id),
        job,
      ];
      publishAutomation();
      return structuredClone(job);
    },
    updateAutomationWeComGroupAlias: async ({ chatId, alias }) => {
      const group = snapshot.automation.discoveredWeComGroups.find(
        (candidate) => candidate.chatId === chatId,
      );
      if (!group) {
        throw new Error("Preview WeCom group does not exist.");
      }
      const normalizedAlias = alias.trim();
      if (normalizedAlias) {
        group.alias = normalizedAlias;
      } else {
        delete group.alias;
      }
      publishAutomation();
      return structuredClone(group);
    },
    deleteAutomationJob: async (jobId) => {
      snapshot.automation.jobs = snapshot.automation.jobs.filter(
        (job) => job.id !== jobId,
      );
      publishAutomation();
    },
    runAutomationJob: async (jobId) => {
      const job = snapshot.automation.jobs.find((candidate) => candidate.id === jobId);
      if (!job) {
        throw new Error("Preview automation job does not exist.");
      }
      const run: AutomationRunRecord = {
        id: crypto.randomUUID(),
        reportCode: "F0E1D2C3B4",
        jobId: job.id,
        jobName: job.name,
        trigger: "manual",
        status: "running",
        attempt: 1,
        createdAt: Date.now(),
        startedAt: Date.now(),
        deliveries: job.wecomTargetIds.map((targetId) => ({
          targetId,
          status: "pending",
          attempts: 0,
        })),
      };
      snapshot.automation.runs.unshift(run);
      snapshot.automation.runningJobIds = [job.id];
      publishAutomation();
      return structuredClone(run);
    },
    retryAutomationRun: async (runId) => {
      const run = snapshot.automation.runs.find((candidate) => candidate.id === runId);
      if (!run) {
        throw new Error("Preview automation run does not exist.");
      }
      run.status = "running";
      run.attempt += 1;
      run.startedAt = Date.now();
      delete run.finishedAt;
      delete run.error;
      snapshot.automation.runningJobIds = [run.jobId];
      publishAutomation();
      return structuredClone(run);
    },
    cancelAutomationRun: async (runId) => {
      const run = snapshot.automation.runs.find((candidate) => candidate.id === runId);
      if (run) {
        run.status = "cancelled";
        run.finishedAt = Date.now();
        snapshot.automation.runningJobIds = snapshot.automation.runningJobIds.filter(
          (jobId) => jobId !== run.jobId,
        );
        publishAutomation();
      }
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
    onAutomationStateChanged: (listener) => {
      automationListeners.add(listener);
      return () => automationListeners.delete(listener);
    },
  };

  window.claudeWorkspace = api;
}
