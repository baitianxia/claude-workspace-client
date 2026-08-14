import { app, BrowserWindow, dialog, shell } from "electron";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ClaudeLocator } from "./claude-locator";
import { registerIpcHandlers } from "./ipc";
import { ProjectStore } from "./project-store";
import { SessionManager } from "./session-manager";
import { TemporaryWorkspace } from "./temporary-workspace";

let mainWindow: BrowserWindow | null = null;
let sessionManager: SessionManager | null = null;
let removeIpcHandlers: (() => void) | null = null;
let allowClose = false;

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
    if (allowClose || !sessionManager?.hasRunningSessions()) {
      return;
    }
    const choice = dialog.showMessageBoxSync(window, {
      type: "warning",
      title: "仍有会话正在运行",
      message: "关闭客户端会终止所有正在运行的 Claude Code 会话。",
      detail: "Claude Code 会保存对话记录，之后仍可通过 /resume 恢复。",
      buttons: ["取消", "关闭并终止会话"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (choice === 0) {
      event.preventDefault();
      return;
    }
    allowClose = true;
    sessionManager.dispose();
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
  sessionManager = new SessionManager(
    () => claudeLocator.requireExecutable(),
    undefined,
    process.platform,
    projectStore.listSessions(),
  );
  await projectStore.replaceSessions(sessionManager.listSessions());

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

app.on("before-quit", () => {
  allowClose = true;
  sessionManager?.dispose();
  removeIpcHandlers?.();
});
