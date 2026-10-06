import type {
  AppTheme,
  AppSnapshot,
  AssistantProfileRecord,
  AssistantStateChangedEvent,
  AssistantTurnRecord,
  AssistantWeComBotProfile,
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
  theme: "dark",
  wecom: {
    enabled: true,
    configured: true,
    hasSecret: true,
    botId: "aibot-preview-claude-manager",
    targetUserId: "developer",
    status: "connected",
  },
  assistant: {
    profiles: [
      {
        id: "assistant-shadow",
        name: "小岚",
        enabled: true,
        projectPath: "D:\\workspace\\assistant-shadow",
        instructions: "作为我的私人研究助理，先给结论，再补充关键依据。",
        ownerWeComUserId: "developer",
        wecomBotProfileId: "assistant-shadow-bot",
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
        response: "今天建议优先关注两件事：\n\n1. **商城登录超时修复**已经进入验证阶段。\n2. 下午的产品评审前，先确认助理定时任务整理出的两条行业变化。",
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
        botProfileId: "assistant-shadow-bot",
        userId: "developer",
        request: "把产品评审相关的上下文整理成三个要点。",
        status: "succeeded",
        response: "已整理：**目标范围、当前风险、需要现场确认的决策**。我会保持这段上下文，你回到客户端后可以继续补充。",
        createdAt: now - 32_000,
        startedAt: now - 31_000,
        finishedAt: now - 25_000,
      },
    ],
    wecomBots: [
      {
        id: "assistant-shadow-bot",
        name: "小岚",
        enabled: true,
        configured: true,
        hasSecret: true,
        botId: "aibot-preview-shadow",
        status: "connected",
        lastInboundAt: now - 24_000,
        lastInboundStatus: "routed",
        lastInboundDetail: "已路由到主人会话。",
        createdAt: now - 300_000,
        updatedAt: now - 300_000,
      },
    ],
    tasks: [
      {
        id: "daily-industry-news",
        assistantId: "assistant-shadow",
        name: "工作日行业动态",
        enabled: true,
        schedule: "0 9 * * 1-5",
        prompt: "整理今天新出现且与商城业务相关的行业动态，并把结论通知我。",
        timeoutMinutes: 20,
        maxTurns: 20,
        createdAt: now - 90_000,
        updatedAt: now - 90_000,
      },
      {
        id: "weekly-mail-review",
        assistantId: "assistant-shadow",
        name: "每周邮件回顾",
        enabled: true,
        schedule: "30 17 * * 5",
        prompt: "回顾本周需要我跟进的个人邮件并生成待办摘要。",
        timeoutMinutes: 20,
        maxTurns: 20,
        createdAt: now - 80_000,
        updatedAt: now - 80_000,
      },
    ],
    taskRuns: [
      {
        id: "preview-task-run-success",
        taskId: "daily-industry-news",
        assistantId: "assistant-shadow",
        taskName: "工作日行业动态",
        trigger: "scheduled",
        status: "succeeded",
        createdAt: now - 70_000,
        startedAt: now - 69_000,
        finishedAt: now - 40_000,
        scheduledFor: now - 70_000,
        response: "今天新增两条值得关注的行业动态，均已核对来源。",
      },
      {
        id: "preview-task-run-failed",
        taskId: "weekly-mail-review",
        assistantId: "assistant-shadow",
        taskName: "每周邮件回顾",
        trigger: "scheduled",
        status: "failed",
        createdAt: now - 34_000,
        startedAt: now - 33_000,
        finishedAt: now - 25_000,
        scheduledFor: now - 34_000,
        error: "邮箱 MCP 连接已失效，Claude Code 无法读取邮件；任务未静默跳过。",
        deliveryError: "企业微信智能机器人暂时离线，失败通知未送达。",
      },
    ],
    runningConversationIds: [],
    openConversationIds: ["assistant-shadow"],
    resumableConversationIds: ["assistant-shadow"],
    runningTaskIds: [],
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
  const previewParams = new URLSearchParams(window.location.search);
  const previewTheme: AppTheme =
    previewParams.get("theme") === "light" ? "light" : "dark";
  let snapshot = structuredClone(previewSnapshot);
  snapshot.theme = previewTheme;
  let clipboardText = "";
  const sessionListeners = new Set<(event: SessionChangedEvent) => void>();
  const terminalListeners = new Set<(event: TerminalDataEvent) => void>();
  const wecomListeners = new Set<(event: WeComStateChangedEvent) => void>();
  const assistantListeners = new Set<
    (event: AssistantStateChangedEvent) => void
  >();

  if (previewParams.has("autoConfirm")) {
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

  const publishAssistant = () => {
    for (const listener of assistantListeners) {
      listener({ state: structuredClone(snapshot.assistant) });
    }
  };

  if (previewParams.has("unreadDemo")) {
    window.setTimeout(() => {
      for (const listener of terminalListeners) {
        listener({ sessionId: "ui-upgrade", data: "new output", sequence: 1 });
      }
    }, 700);
  }

  const api: DesktopApi = {
    getSnapshot: async () => structuredClone(snapshot),
    setTheme: async (theme) => {
      snapshot.theme = theme;
      return snapshot.theme;
    },
    selectProjectDirectory: async () => null,
    selectAssistantProjectDirectory: async () =>
      "D:\\workspace\\assistant-shadow",
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
        snapshot.assistant.wecomBots.some(
          (bot) => bot.botId === request.botId.trim(),
        )
      ) {
        throw new Error("这个 Bot ID 已用于私人助理的企业微信智能机器人。");
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
    upsertAssistantProfile: async (request) => {
      const existing = request.id
        ? snapshot.assistant.profiles.find((profile) => profile.id === request.id)
        : undefined;
      // `undefined` behaves like an omitted field for compatibility with
      // older renderer payloads; `null` is the explicit unbind value.
      const hasInlineBot = request.wecomBot !== undefined;
      const inlineBot = hasInlineBot ? request.wecomBot : undefined;
      let botProfileId = hasInlineBot
        ? undefined
        : request.wecomBotProfileId ?? existing?.wecomBotProfileId;
      const oldBotId = existing?.wecomBotProfileId;
      if (hasInlineBot && inlineBot) {
        let existingBot = inlineBot.id
          ? snapshot.assistant.wecomBots.find((bot) => bot.id === inlineBot.id)
          : undefined;
        if (inlineBot.id && !existingBot) {
          throw new Error("企业微信智能机器人配置不存在或已经删除。");
        }
        // Match the main-process migration path: an imported, currently
        // unbound bot can be selected by its Bot ID even when the renderer has
        // not yet received its generated profile ID.
        if (!inlineBot.id && typeof inlineBot.botId === "string") {
          existingBot = snapshot.assistant.wecomBots.find(
            (bot) =>
              bot.botId.toLocaleLowerCase("en-US") ===
              inlineBot.botId.trim().toLocaleLowerCase("en-US"),
          );
        }
        if (
          existingBot &&
          snapshot.assistant.profiles.some(
            (profile) =>
              profile.id !== existing?.id &&
              profile.wecomBotProfileId === existingBot?.id,
          )
        ) {
          throw new Error("这个企业微信智能机器人已经绑定到其他私人助理。");
        }
        if (
          existingBot &&
          existingBot.botId !== inlineBot.botId.trim()
        ) {
          throw new Error("已保存连接的 Bot ID 不能修改。");
        }
        if (
          inlineBot.botId.trim() === snapshot.wecom.botId ||
          snapshot.assistant.wecomBots.some(
            (bot) =>
              bot.id !== existingBot?.id && bot.botId === inlineBot.botId.trim(),
          )
        ) {
          throw new Error("这个 Bot ID 已被其他机器人使用。");
        }
        const timestamp = Date.now();
        const bot: AssistantWeComBotProfile = {
          id: existingBot?.id ?? crypto.randomUUID(),
          name: inlineBot.name.trim(),
          enabled: inlineBot.enabled,
          configured: Boolean(
            inlineBot.botId.trim() && (inlineBot.secret?.trim() || existingBot?.hasSecret),
          ),
          hasSecret: Boolean(inlineBot.secret?.trim() || existingBot?.hasSecret),
          botId: inlineBot.botId.trim(),
          status: inlineBot.enabled ? "connected" : "disabled",
          ...(existingBot?.lastInboundAt === undefined
            ? {}
            : { lastInboundAt: existingBot.lastInboundAt }),
          ...(existingBot?.lastInboundStatus
            ? { lastInboundStatus: existingBot.lastInboundStatus }
            : {}),
          ...(existingBot?.lastInboundDetail
            ? { lastInboundDetail: existingBot.lastInboundDetail }
            : {}),
          createdAt: existingBot?.createdAt ?? timestamp,
          updatedAt: timestamp,
        };
        snapshot.assistant.wecomBots = [
          ...snapshot.assistant.wecomBots.filter((candidate) => candidate.id !== bot.id),
          bot,
        ];
        botProfileId = bot.id;
      }
      if (
        botProfileId &&
        snapshot.assistant.profiles.some(
          (profile) =>
            profile.id !== existing?.id && profile.wecomBotProfileId === botProfileId,
        )
      ) {
        throw new Error("这个企业微信智能机器人已经绑定到其他私人助理。");
      }
      const timestamp = Date.now();
      const profile: AssistantProfileRecord = {
        id: existing?.id ?? crypto.randomUUID(),
        name: request.name,
        enabled: request.enabled,
        projectPath: request.projectPath,
        ...(request.projectId ? { projectId: request.projectId } : {}),
        instructions: request.instructions,
        ownerWeComUserId: request.ownerWeComUserId,
        ...(botProfileId ? { wecomBotProfileId: botProfileId } : {}),
        timeoutMinutes: request.timeoutMinutes,
        maxTurns: request.maxTurns,
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
      if (oldBotId && oldBotId !== botProfileId) {
        snapshot.assistant.wecomBots = snapshot.assistant.wecomBots.filter(
          (bot) => bot.id !== oldBotId,
        );
      }
      publishAssistant();
      return structuredClone(profile);
    },
    deleteAssistantProfile: async (assistantId) => {
      const deletedProfile = snapshot.assistant.profiles.find(
        (profile) => profile.id === assistantId,
      );
      snapshot.assistant.profiles = snapshot.assistant.profiles.filter(
        (profile) => profile.id !== assistantId,
      );
      if (deletedProfile?.wecomBotProfileId) {
        snapshot.assistant.wecomBots = snapshot.assistant.wecomBots.filter(
          (bot) => bot.id !== deletedProfile.wecomBotProfileId,
        );
      }
      snapshot.assistant.conversations = snapshot.assistant.conversations.filter(
        (conversation) => conversation.assistantId !== assistantId,
      );
      snapshot.assistant.turns = snapshot.assistant.turns.filter(
        (turn) => turn.assistantId !== assistantId,
      );
      snapshot.assistant.tasks = snapshot.assistant.tasks.filter(
        (task) => task.assistantId !== assistantId,
      );
      snapshot.assistant.taskRuns = snapshot.assistant.taskRuns.filter(
        (run) => run.assistantId !== assistantId,
      );
      snapshot.assistant.openConversationIds =
        snapshot.assistant.openConversationIds.filter(
          (candidate) => candidate !== assistantId,
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
      if (!snapshot.assistant.openConversationIds.includes(assistantId)) {
        snapshot.assistant.openConversationIds.push(assistantId);
      }
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
      snapshot.assistant.openConversationIds =
        snapshot.assistant.openConversationIds.filter(
          (candidate) => candidate !== assistantId,
        );
      publishAssistant();
      return structuredClone(conversation);
    },
    closeAssistantConversation: async (assistantId) => {
      snapshot.assistant.openConversationIds =
        snapshot.assistant.openConversationIds.filter(
          (candidate) => candidate !== assistantId,
        );
      publishAssistant();
    },
    cancelAssistantTurn: async (conversationId, turnId) => {
      const turn = snapshot.assistant.turns.find(
        (candidate) =>
          candidate.conversationId === conversationId &&
          (turnId === undefined || candidate.id === turnId) &&
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
        ...(request.skipPermissions === true ? { skipPermissions: true } : {}),
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
    onAssistantStateChanged: (listener) => {
      assistantListeners.add(listener);
      return () => assistantListeners.delete(listener);
    },
  };

  window.claudeWorkspace = api;
}
