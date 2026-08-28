import {
  app,
  BrowserWindow,
  dialog,
  safeStorage,
  shell,
  type MessageBoxOptions,
} from "electron";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ClaudeLocator } from "./claude-locator";
import type { ClaudeHookEvent } from "./claude-hook-server";
import { registerIpcHandlers } from "./ipc";
import { ProjectStore } from "./project-store";
import type { SessionHostClient } from "./session-host/client";
import { connectSessionHost } from "./session-host/launcher";
import { TemporaryWorkspace } from "./temporary-workspace";
import { WeComBridge } from "./wecom-bridge";
import { WeComSettingsService } from "./wecom-settings";

let mainWindow: BrowserWindow | null = null;
let sessionHostClient: SessionHostClient | null = null;
let removeIpcHandlers: (() => void) | null = null;
let wecomBridge: WeComBridge | null = null;
let allowClose = false;
let exitPromptOpen = false;
let cleanupStarted = false;

function runningSessionCount(): number {
  return (
    sessionHostClient
      ?.listSessions()
      .filter(
        (session) =>
          session.status === "running" || session.status === "starting",
      ).length ?? 0
  );
}

async function showExitChoice(window?: BrowserWindow): Promise<number> {
  const count = runningSessionCount();
  const options: MessageBoxOptions = {
    type: "question",
    title: "是否同时结束所有会话？",
    message: `当前有 ${count} 个 Claude Code 会话正在运行。退出客户端时，是否同时结束这些会话？`,
    detail:
      "选择“仅退出客户端”后，会话会在后台继续运行；下次启动客户端时会自动重新连接。",
    buttons: [
      "仅退出客户端（会话继续运行）",
      "退出并结束所有会话",
      "取消",
    ],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  };
  const result = window
    ? await dialog.showMessageBox(window, options)
    : await dialog.showMessageBox(options);
  return result.response;
}

async function requestApplicationExit(window?: BrowserWindow): Promise<void> {
  if (exitPromptOpen) {
    return;
  }
  if (!sessionHostClient?.hasRunningSessions()) {
    allowClose = true;
    app.quit();
    return;
  }
  exitPromptOpen = true;
  try {
    const choice = await showExitChoice(window);
    if (choice === 2) {
      return;
    }
    if (choice === 1) {
      await sessionHostClient.stopAll();
    }
    allowClose = true;
    app.quit();
  } catch (error) {
    const options: MessageBoxOptions = {
      type: "error",
      title: "无法退出 Claude Workspace",
      message: "处理后台会话时发生错误，客户端尚未退出。",
      detail: error instanceof Error ? error.message : String(error),
      buttons: ["确定"],
      noLink: true,
    };
    if (window && !window.isDestroyed()) {
      await dialog.showMessageBox(window, options);
    } else {
      await dialog.showMessageBox(options);
    }
  } finally {
    exitPromptOpen = false;
  }
}

function cleanupApplication(): void {
  if (cleanupStarted) {
    return;
  }
  cleanupStarted = true;
  wecomBridge?.dispose();
  removeIpcHandlers?.();
  sessionHostClient?.close();
}

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
    if (allowClose || !sessionHostClient?.hasRunningSessions()) {
      return;
    }
    event.preventDefault();
    void requestApplicationExit(window);
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

  const claudeLocator = new ClaudeLocator(projectStore);
  await claudeLocator.initialize();
  const { client } = await connectSessionHost({
    userDataPath: app.getPath("userData"),
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    developmentExecutablePath: process.execPath,
    developmentHostScriptPath: join(__dirname, "session-host/process.js"),
  });
  sessionHostClient = client;
  const hostSnapshot = await client.initialize(
    claudeLocator.getState().path,
    projectStore.listSessions(),
  );
  await projectStore.replaceSessions(hostSnapshot.sessions);

  wecomBridge = new WeComBridge(
    client,
    () => projectStore.listProjects(),
    undefined,
    undefined,
    hostSnapshot.hookAvailabilityError,
  );
  const forwardClaudeHook = (event: ClaudeHookEvent) =>
    wecomBridge?.handleClaudeHook(event);
  client.once("disconnected", (error) => {
    if (allowClose || cleanupStarted) {
      return;
    }
    dialog.showErrorBox(
      "Session Host 连接已中断",
      error?.message ??
        "后台会话服务已停止。正在运行的终端可能已经中断，请重新启动客户端确认会话状态。",
    );
  });
  const wecomSettingsService = new WeComSettingsService(
    projectStore,
    wecomBridge,
    safeStorage,
  );
  wecomSettingsService.initialize();
  client.on("claudeHook", forwardClaudeHook);
  for (const event of client.drainQueuedHooks()) {
    forwardClaudeHook(event);
  }

  mainWindow = createWindow();
  const temporaryWorkspace = new TemporaryWorkspace(
    join(app.getPath("userData"), "temporary-workspaces"),
  );
  removeIpcHandlers = registerIpcHandlers({
    window: mainWindow,
    projectStore,
    claudeLocator,
    sessionManager: client,
    setSessionExecutable: (executablePath) =>
      client.setExecutable(executablePath),
    temporaryWorkspace,
    wecomBridge,
    wecomSettingsService,
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
  if (!allowClose && sessionHostClient?.hasRunningSessions()) {
    event.preventDefault();
    void requestApplicationExit(
      mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined,
    );
    return;
  }
  allowClose = true;
  cleanupApplication();
});
