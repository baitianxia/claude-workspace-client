import { app, BrowserWindow, dialog, safeStorage, shell } from "electron";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ClaudeLocator } from "./claude-locator";
import { AssistantService } from "./assistant-service";
import { AssistantStore } from "./assistant-store";
import { AssistantTaskService } from "./assistant-task-service";
import { AssistantTaskStore } from "./assistant-task-store";
import { AssistantWeComBotManager } from "./assistant-wecom-bot-manager";
import { ClaudeCodeAssistantRunner } from "./claude-code-assistant-runner";
import { ClaudeCodeAssistantTaskRunner } from "./claude-code-assistant-task-runner";
import { ClaudeHookServer } from "./claude-hook-server";
import { registerIpcHandlers } from "./ipc";
import { ProjectStore } from "./project-store";
import { SessionManager } from "./session-manager";
import { TemporaryWorkspace } from "./temporary-workspace";
import { WeComBridge } from "./wecom-bridge";
import { WeComSettingsService } from "./wecom-settings";

let mainWindow: BrowserWindow | null = null;
let sessionManager: SessionManager | null = null;
let removeIpcHandlers: (() => void) | null = null;
let claudeHookServer: ClaudeHookServer | null = null;
let wecomBridge: WeComBridge | null = null;
let assistantWeComBots: AssistantWeComBotManager | null = null;
let assistantService: AssistantService | null = null;
let allowClose = false;
let shutdownComplete = false;
let shutdownPromise: Promise<void> | null = null;

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1380,
    height: 860,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: "#12110f",
    title: "Claude Workspace",
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://") || url.startsWith("http://")) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });

  window.webContents.on("will-navigate", (event, url) => {
    const developmentUrl = process.env.VITE_DEV_SERVER_URL;
    if (developmentUrl && url.startsWith(developmentUrl)) {
      return;
    }
    if (url.startsWith("file://")) {
      return;
    }
    event.preventDefault();
  });

  window.once("ready-to-show", () => window.show());
  window.webContents.once("did-finish-load", () => {
    const capturePath = process.env.CLAUDE_WORKSPACE_CAPTURE_PATH;
    if (!capturePath) {
      return;
    }
    setTimeout(() => {
      void window.webContents
        .capturePage()
        .then((image) => writeFile(capturePath, image.toPNG()))
        .then(() => {
          allowClose = true;
          app.quit();
        })
        .catch((error: unknown) => {
          console.error("Failed to capture renderer", error);
          allowClose = true;
          app.exit(1);
        });
    }, 500);
  });
  window.on("close", (event) => {
    const hasRunningSessions = sessionManager?.hasRunningSessions() ?? false;
    const hasRunningAssistant = assistantService?.hasRunningWork() ?? false;
    if (
      allowClose ||
      (!hasRunningSessions && !hasRunningAssistant)
    ) {
      return;
    }
    const choice = dialog.showMessageBoxSync(window, {
      type: "warning",
      title: "仍有任务正在运行",
      message:
        "关闭客户端会终止正在运行的 Claude Code 会话、助理聊天和独立定时任务。",
      detail: hasRunningAssistant
        ? "聊天上下文会保留供下次恢复；正在运行的定时任务会标记为取消或结果未知，且不会自动重跑，以避免重复副作用。"
        : "Claude Code 会保存交互式对话记录，之后仍可通过 /resume 恢复。",
      buttons: ["取消", "关闭并终止任务"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (choice === 0) {
      event.preventDefault();
      return;
    }
    allowClose = true;
  });

  const developmentUrl = process.env.VITE_DEV_SERVER_URL;
  if (developmentUrl) {
    void window.loadURL(developmentUrl);
  } else {
    void window.loadFile(join(__dirname, "../../renderer/index.html"));
  }

  return window;
}

async function startApplication(): Promise<void> {
  const projectStore = new ProjectStore(
    join(app.getPath("userData"), "workspace.json"),
  );
  await projectStore.initialize();
  const assistantStore = new AssistantStore(
    join(app.getPath("userData"), "assistant.json"),
    join(app.getPath("userData"), "automation.json"),
  );
  await assistantStore.initialize();

  const claudeLocator = new ClaudeLocator(projectStore);
  await claudeLocator.initialize();
  const hookServer = new ClaudeHookServer();
  let hookAvailabilityError: string | undefined;
  try {
    await hookServer.start();
    claudeHookServer = hookServer;
  } catch (error) {
    hookAvailabilityError = `无法启动本机 Claude Code Hook 服务：${
      error instanceof Error ? error.message : String(error)
    }`;
    console.error(hookAvailabilityError);
  }
  sessionManager = new SessionManager(
    () => claudeLocator.requireExecutable(),
    undefined,
    process.platform,
    projectStore.listSessions(),
    (sessionId, launchId) =>
      claudeHookServer && wecomBridge?.shouldInjectClaudeHooks()
        ? claudeHookServer.hookLaunchOptions(sessionId, launchId)
        : { args: [] },
  );
  await projectStore.replaceSessions(sessionManager.listSessions());

  wecomBridge = new WeComBridge(
    sessionManager,
    () => projectStore.listProjects(),
    undefined,
    undefined,
    hookAvailabilityError,
  );
  const wecomAssistantEntries = new AssistantWeComBotManager(
    assistantStore,
    safeStorage,
    () => wecomBridge?.getState().botId ?? "",
    undefined,
    (botProfileId) => {
      const profile = assistantStore.findProfileByWeComBot(botProfileId);
      return profile
        ? `私人助理“${profile.name}”仍绑定这个企业微信入口，请先解除绑定或删除助理。`
        : undefined;
    },
  );
  assistantWeComBots = wecomAssistantEntries;
  const wecomSettingsService = new WeComSettingsService(
    projectStore,
    wecomBridge,
    safeStorage,
    (botId) => wecomAssistantEntries.hasBotId(botId),
    () => wecomAssistantEntries.refreshReservedManagementBotId(),
  );
  wecomSettingsService.initialize();
  claudeHookServer?.on("hook", (event) =>
    wecomBridge?.handleClaudeHook(event),
  );

  await wecomAssistantEntries.initialize();

  const assistantTaskStore = new AssistantTaskStore(
    join(app.getPath("userData"), "assistant-tasks.json"),
  );
  const assistantTaskRunner = new ClaudeCodeAssistantTaskRunner(
    () => claudeLocator.requireExecutable(),
  );
  const assistantTasks = new AssistantTaskService(
    assistantTaskStore,
    assistantTaskRunner,
    (assistantId) => assistantStore.getProfile(assistantId),
    (projectId) => projectStore.getProject(projectId),
    wecomAssistantEntries,
  );

  const assistantRunner = new ClaudeCodeAssistantRunner(
    () => claudeLocator.requireExecutable(),
  );
  assistantService = new AssistantService(
    assistantStore,
    assistantRunner,
    (projectId) => projectStore.getProject(projectId),
    wecomAssistantEntries,
    assistantTasks,
  );
  await assistantService.initialize();
  wecomAssistantEntries.setMessageHandler(async (message) => {
    if (!assistantService) {
      return null;
    }
    return assistantService.handleWeComMessage(message);
  });

  mainWindow = createWindow();
  const temporaryWorkspace = new TemporaryWorkspace(
    join(app.getPath("userData"), "temporary-workspaces"),
  );
  removeIpcHandlers = registerIpcHandlers({
    window: mainWindow,
    projectStore,
    claudeLocator,
    sessionManager,
    temporaryWorkspace,
    wecomBridge,
    wecomSettingsService,
    assistantService,
  });
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) {
      return;
    }
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(startApplication).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    dialog.showErrorBox("Claude Workspace 启动失败", message);
    app.quit();
  });
}

app.on("window-all-closed", () => {
  app.quit();
});

app.on("before-quit", (event) => {
  allowClose = true;
  if (shutdownComplete) {
    return;
  }
  event.preventDefault();
  if (shutdownPromise) {
    return;
  }
  shutdownPromise = (async () => {
    try {
      removeIpcHandlers?.();
    } catch (error) {
      console.error("Failed to remove IPC handlers during shutdown", error);
    }
    removeIpcHandlers = null;
    assistantWeComBots?.setMessageHandler(null);
    try {
      await assistantService?.dispose();
    } catch (error) {
      console.error("Failed to stop assistant during shutdown", error);
    }
    assistantWeComBots?.dispose();
    try {
      wecomBridge?.dispose();
    } catch (error) {
      console.error("Failed to stop WeCom during shutdown", error);
    }
    try {
      sessionManager?.dispose();
    } catch (error) {
      console.error("Failed to stop sessions during shutdown", error);
    }
    try {
      await claudeHookServer?.stop();
    } catch (error) {
      console.error("Failed to stop Claude hooks during shutdown", error);
    }
  })()
    .catch((error: unknown) => {
      console.error("Failed to shut down Claude Workspace cleanly", error);
    })
    .finally(() => {
      shutdownComplete = true;
      app.quit();
    });
});
