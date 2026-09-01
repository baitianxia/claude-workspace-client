import type {
  AppSnapshot,
  AssistantProfileRecord,
  AssistantStateChangedEvent,
  AssistantTurnRecord,
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
    botId: "aibot-preview-claude-manager",
    targetUserId: "developer",
    status: "connected",
  },
  automation: {
    wecomBots: [
      {
        id: "automation-news-bot",
        name: "资讯推送机器人",
        enabled: true,
        configured: true,
        hasSecret: true,
        botId: "aibot-preview-news",
        status: "connected",
        createdAt: now - 300_000,
        updatedAt: now - 300_000,
      },
      {
        id: "automation-ops-bot",
        name: "运营播报机器人",
        enabled: true,
        configured: true,
        hasSecret: true,
        botId: "aibot-preview-ops",
        status: "connected",
        createdAt: now - 260_000,
        updatedAt: now - 260_000,
      },
    ],
    discoveredWeComGroups: [
      {
        botProfileId: "automation-news-bot",
        chatId: "wr-preview-group",
        alias: "每日资讯群",
        discoveredAt: now - 240_000,
        lastSeenAt: now - 18_000,
      },
      {
        botProfileId: "automation-news-bot",
        chatId: "wr-product-watch",
        alias: "产品观察群",
        discoveredAt: now - 180_000,
        lastSeenAt: now - 45_000,
      },
      {
        botProfileId: "automation-ops-bot",
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
        wecomBotProfileId: "automation-news-bot",
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
            botProfileId: "automation-news-bot",
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
  assistant: {
    profiles: [
      {
        id: "assistant-shadow",
        name: "小岚",
        enabled: true,
        projectId: "mall-service",
        instructions: "作为我的私人研究助理，先给结论，再补充关键依据。",
        mcpConfigPath: ".mcp.json",
        allowedMcpServers: ["web", "mail"],
        ownerWeComUserId: "developer",
        wecomBotProfileId: "automation-news-bot",
        timeoutMinutes: 20,
        maxTurns: 20,
        createdAt: now - 360_000,
        updatedAt: now - 360_000,
      },
    ],
    conversations: [
      {
        id: "assistant-shadow",
        assistantId: "assistant-shadow",
        kind: "owner",
        createdAt: now - 350_000,
        updatedAt: now - 25_000,
        lastMessageAt: now - 25_000,
      },
    ],
    turns: [
      {
        id: "assistant-turn-one",
        assistantId: "assistant-shadow",
        conversationId: "assistant-shadow",
        source: "desktop",
        request: "今天有哪些事情值得我优先关注？",
        status: "succeeded",
        response: "今天建议优先关注两件事：\n\n1. **商城登录超时修复**已经进入验证阶段。\n2. 下午的产品评审前，先确认自动化日报里的两条行业变化。",
        createdAt: now - 62_000,
        startedAt: now - 61_000,
        finishedAt: now - 48_000,
      },
      {
        id: "assistant-turn-two",
        assistantId: "assistant-shadow",
        conversationId: "assistant-shadow",
        source: "wecom",
        messageId: "preview-wecom-owner-message",
        botProfileId: "automation-news-bot",
        userId: "developer",
        request: "把产品评审相关的上下文整理成三个要点。",
        status: "succeeded",
        response: "已整理：**目标范围、当前风险、需要现场确认的决策**。我会保持这段上下文，你回到客户端后可以继续补充。",
        createdAt: now - 32_000,
        startedAt: now - 31_000,
        finishedAt: now - 25_000,
      },
    ],
    runningConversationIds: [],
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
  const assistantListeners = new Set<
    (event: AssistantStateChangedEvent) => void
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

  const publishAssistant = () => {
    for (const listener of assistantListeners) {
      listener({ state: structuredClone(snapshot.assistant) });
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
      if (
        request.botId.trim() &&
        snapshot.automation.wecomBots.some(
          (bot) => bot.botId === request.botId.trim(),
        )
      ) {
        throw new Error("这个 Bot ID 已用于企业微信业务入口。");
      }
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
      if (
        request.wecomTargetIds.length > 0 &&
        !snapshot.automation.wecomBots.some(
          (bot) => bot.id === request.wecomBotProfileId,
        )
      ) {
        throw new Error("请选择有效的企业微信业务入口。");
      }
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
    upsertAutomationWeComBot: async (request) => {
      const existing = request.id
        ? snapshot.automation.wecomBots.find((bot) => bot.id === request.id)
        : undefined;
      if (existing && existing.botId !== request.botId.trim()) {
        throw new Error("已保存机器人的 Bot ID 不能修改。");
      }
      if (
        request.botId.trim() === snapshot.wecom.botId ||
        snapshot.automation.wecomBots.some(
          (bot) => bot.id !== existing?.id && bot.botId === request.botId.trim(),
        )
      ) {
        throw new Error("这个 Bot ID 已被其他机器人使用。");
      }
      const timestamp = Date.now();
      const bot = {
        id: existing?.id ?? crypto.randomUUID(),
        name: request.name.trim(),
        enabled: request.enabled,
        configured: Boolean(
          request.botId.trim() && (request.secret?.trim() || existing?.hasSecret),
        ),
        hasSecret: Boolean(request.secret?.trim() || existing?.hasSecret),
        botId: request.botId.trim(),
        status: request.enabled ? ("connected" as const) : ("disabled" as const),
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
      };
      snapshot.automation.wecomBots = [
        ...snapshot.automation.wecomBots.filter(
          (candidate) => candidate.id !== bot.id,
        ),
        bot,
      ];
      publishAutomation();
      return structuredClone(bot);
    },
    deleteAutomationWeComBot: async (botProfileId) => {
      if (
        snapshot.assistant.profiles.some(
          (profile) => profile.wecomBotProfileId === botProfileId,
        )
      ) {
        throw new Error("仍有私人助理绑定这个企业微信入口。");
      }
      if (
        snapshot.automation.jobs.some(
          (job) => job.wecomBotProfileId === botProfileId,
        )
      ) {
        throw new Error("仍有自动化任务使用这个机器人。");
      }
      snapshot.automation.wecomBots = snapshot.automation.wecomBots.filter(
        (bot) => bot.id !== botProfileId,
      );
      snapshot.automation.discoveredWeComGroups =
        snapshot.automation.discoveredWeComGroups.filter(
          (group) => group.botProfileId !== botProfileId,
        );
      publishAutomation();
    },
    upsertAssistantProfile: async (request) => {
      const existing = request.id
        ? snapshot.assistant.profiles.find((profile) => profile.id === request.id)
        : undefined;
      if (
        request.wecomBotProfileId &&
        snapshot.assistant.profiles.some(
          (profile) =>
            profile.id !== existing?.id &&
            profile.wecomBotProfileId === request.wecomBotProfileId,
        )
      ) {
        throw new Error("这个企业微信入口已经绑定到其他私人助理。");
      }
      const timestamp = Date.now();
      const profile: AssistantProfileRecord = {
        ...request,
        id: existing?.id ?? crypto.randomUUID(),
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
      };
      snapshot.assistant.profiles = [
        ...snapshot.assistant.profiles.filter(
          (candidate) => candidate.id !== profile.id,
        ),
        profile,
      ];
      if (
        !snapshot.assistant.conversations.some(
          (conversation) => conversation.id === profile.id,
        )
      ) {
        snapshot.assistant.conversations.push({
          id: profile.id,
          assistantId: profile.id,
          kind: "owner",
          createdAt: timestamp,
          updatedAt: timestamp,
        });
      }
      publishAssistant();
      return structuredClone(profile);
    },
    deleteAssistantProfile: async (assistantId) => {
      snapshot.assistant.profiles = snapshot.assistant.profiles.filter(
        (profile) => profile.id !== assistantId,
      );
      snapshot.assistant.conversations = snapshot.assistant.conversations.filter(
        (conversation) => conversation.assistantId !== assistantId,
      );
      snapshot.assistant.turns = snapshot.assistant.turns.filter(
        (turn) => turn.assistantId !== assistantId,
      );
      publishAssistant();
    },
    sendAssistantMessage: async ({ assistantId, text }) => {
      const profile = snapshot.assistant.profiles.find(
        (candidate) => candidate.id === assistantId,
      );
      if (!profile?.enabled) {
        throw new Error("私人助理当前不可用。");
      }
      const timestamp = Date.now();
      const turn: AssistantTurnRecord = {
        id: crypto.randomUUID(),
        assistantId,
        conversationId: assistantId,
        source: "desktop",
        request: text.trim(),
        status: "running",
        createdAt: timestamp,
        startedAt: timestamp,
      };
      snapshot.assistant.turns.push(turn);
      const conversation = snapshot.assistant.conversations.find(
        (candidate) => candidate.id === assistantId,
      );
      if (conversation) {
        conversation.updatedAt = timestamp;
        conversation.lastMessageAt = timestamp;
      }
      snapshot.assistant.runningConversationIds = [assistantId];
      publishAssistant();
      window.setTimeout(() => {
        turn.status = "succeeded";
        turn.response = `我已经收到：“${turn.request}”。这是预览模式回复；真实运行时会继续同一个主人 Claude 会话。`;
        turn.finishedAt = Date.now();
        snapshot.assistant.runningConversationIds = [];
        publishAssistant();
      }, 700);
      return structuredClone(turn);
    },
    resetAssistantConversation: async (assistantId) => {
      const conversation = snapshot.assistant.conversations.find(
        (candidate) => candidate.id === assistantId,
      );
      if (!conversation) {
        throw new Error("Preview assistant conversation does not exist.");
      }
      delete conversation.claudeSessionId;
      conversation.updatedAt = Date.now();
      snapshot.assistant.turns = snapshot.assistant.turns.filter(
        (turn) => turn.assistantId !== assistantId,
      );
      publishAssistant();
      return structuredClone(conversation);
    },
    cancelAssistantTurn: async (conversationId) => {
      const turn = snapshot.assistant.turns.find(
        (candidate) =>
          candidate.conversationId === conversationId &&
          (candidate.status === "queued" || candidate.status === "running"),
      );
      if (turn) {
        turn.status = "cancelled";
        turn.error = "本轮对话已取消。";
        turn.finishedAt = Date.now();
      }
      snapshot.assistant.runningConversationIds =
        snapshot.assistant.runningConversationIds.filter(
          (candidate) => candidate !== conversationId,
        );
      publishAssistant();
    },
    updateAutomationWeComGroupAlias: async ({
      botProfileId,
      chatId,
      alias,
    }) => {
      const group = snapshot.automation.discoveredWeComGroups.find(
        (candidate) =>
          candidate.botProfileId === botProfileId &&
          candidate.chatId === chatId,
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
          botProfileId: job.wecomBotProfileId,
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
    onAssistantStateChanged: (listener) => {
      assistantListeners.add(listener);
      return () => assistantListeners.delete(listener);
    },
  };

  window.claudeWorkspace = api;
}
