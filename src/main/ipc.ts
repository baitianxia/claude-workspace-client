import {
  clipboard,
  dialog,
  ipcMain,
  Notification,
  type BrowserWindow,
} from "electron";
import type {
  AppSnapshot,
  CreateSessionRequest,
  RenameSessionRequest,
  ResizeTerminalRequest,
  SessionNotificationRequest,
  SessionRecord,
  TerminalDataEvent,
  UpdateProjectRequest,
  WriteTerminalRequest,
} from "../shared/contracts";
import { IPC_CHANNELS } from "../shared/ipc-channels";
import type { ClaudeLocator } from "./claude-locator";
import type { ProjectStore } from "./project-store";
import type { SessionManager } from "./session-manager";
import type { TemporaryWorkspace } from "./temporary-workspace";

const MAX_CLIPBOARD_PASTE_LENGTH = 100_000;
const MAX_CLIPBOARD_COPY_LENGTH = 2_000_000;

function requireIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 200) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function requireTerminalData(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Terminal data must be a string.");
  }
  return value;
}

function requireClipboardText(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Clipboard text must be a string.");
  }
  if (value.length > MAX_CLIPBOARD_COPY_LENGTH) {
    throw new Error("复制内容超过 2,000,000 个字符的限制。");
  }
  return value;
}

function requireShortText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string.`);
  }
  const text = value.trim();
  if (!text || [...text].length > maxLength || /\p{Cc}/u.test(text)) {
    throw new Error(`${label} is invalid.`);
  }
  return text;
}

export function registerIpcHandlers(options: {
  window: BrowserWindow;
  projectStore: ProjectStore;
  claudeLocator: ClaudeLocator;
  sessionManager: SessionManager;
  temporaryWorkspace: TemporaryWorkspace;
}): () => void {
  const {
    window,
    projectStore,
    claudeLocator,
    sessionManager,
    temporaryWorkspace,
  } = options;

  const getSnapshot = (): AppSnapshot => ({
    projects: projectStore.listProjects(),
    sessions: sessionManager.listSessions(),
    claudeExecutable: claudeLocator.getState(),
  });

  ipcMain.handle(IPC_CHANNELS.getSnapshot, getSnapshot);

  ipcMain.handle(IPC_CHANNELS.selectProjectDirectory, async () => {
    const selection = await dialog.showOpenDialog(window, {
      title: "选择工程目录",
      buttonLabel: "添加工程",
      properties: ["openDirectory", "createDirectory"],
    });
    if (selection.canceled || selection.filePaths.length === 0) {
      return null;
    }
    return projectStore.addProject(selection.filePaths[0]);
  });

  ipcMain.handle(
    IPC_CHANNELS.updateProject,
    (_event, request: UpdateProjectRequest) => {
      if (!request || typeof request !== "object") {
        throw new Error("Project update request is invalid.");
      }
      const projectId = requireIdentifier(request.projectId, "Project ID");
      if (
        request.alias !== undefined &&
        request.alias !== null &&
        typeof request.alias !== "string"
      ) {
        throw new Error("Project alias is invalid.");
      }
      if (request.pinned !== undefined && typeof request.pinned !== "boolean") {
        throw new Error("Project pin state is invalid.");
      }
      return projectStore.updateProject({
        projectId,
        ...(request.alias === undefined ? {} : { alias: request.alias }),
        ...(request.pinned === undefined ? {} : { pinned: request.pinned }),
      });
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.removeProject,
    async (_event, projectId: unknown) => {
      const validatedId = requireIdentifier(projectId, "Project ID");
      sessionManager.removeProjectSessions(validatedId);
      await projectStore.removeProject(validatedId);
    },
  );

  ipcMain.handle(IPC_CHANNELS.selectClaudeExecutable, async () => {
    const selection = await dialog.showOpenDialog(window, {
      title: "选择 Claude Code 可执行文件",
      buttonLabel: "使用此文件",
      properties: ["openFile"],
      filters:
        process.platform === "win32"
          ? [
              {
                name: "Claude Code",
                extensions: ["exe", "cmd", "bat", "ps1"],
              },
              { name: "所有文件", extensions: ["*"] },
            ]
          : [{ name: "所有文件", extensions: ["*"] }],
    });
    if (selection.canceled || selection.filePaths.length === 0) {
      return null;
    }
    return claudeLocator.setCustomExecutable(selection.filePaths[0]);
  });

  ipcMain.handle(IPC_CHANNELS.autoDetectClaudeExecutable, () =>
    claudeLocator.autoDetect(),
  );

  ipcMain.handle(
    IPC_CHANNELS.createSession,
    async (_event, request: CreateSessionRequest) => {
      if (!request || typeof request !== "object") {
        throw new Error("Session request is invalid.");
      }
      if (request.title !== undefined && typeof request.title !== "string") {
        throw new Error("Session title is invalid.");
      }
      let projectId: string | null;
      let cwd: string;
      if (request.scope === "project") {
        projectId = requireIdentifier(request.projectId, "Project ID");
        const project = projectStore.getProject(projectId);
        if (!project) {
          throw new Error("工程不存在，请重新选择目录。");
        }
        cwd = project.rootPath;
      } else if (request.scope === "temporary") {
        // Validate before creating the directory so a missing executable cannot
        // leave an orphaned workspace behind.
        claudeLocator.requireExecutable();
        projectId = null;
        cwd = await temporaryWorkspace.createDirectory();
      } else {
        throw new Error("Session scope is invalid.");
      }
      const session = sessionManager.createSession(
        { projectId, cwd },
        request.title,
      );
      await projectStore.replaceSessions(sessionManager.listSessions());
      return session;
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.renameSession,
    async (_event, request: RenameSessionRequest) => {
      if (!request || typeof request !== "object") {
        throw new Error("Session rename request is invalid.");
      }
      const sessionId = requireIdentifier(request.sessionId, "Session ID");
      if (typeof request.title !== "string") {
        throw new Error("Session title is invalid.");
      }
      const session = sessionManager.renameSession(sessionId, request.title);
      await projectStore.replaceSessions(sessionManager.listSessions());
      return session;
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.removeSession,
    async (_event, sessionId: unknown) => {
      const removed = sessionManager.removeSession(
        requireIdentifier(sessionId, "Session ID"),
      );
      await projectStore.replaceSessions(sessionManager.listSessions());
      if (removed.projectId === null) {
        await temporaryWorkspace.removeDirectory(removed.cwd).catch(
          (error: unknown) =>
            console.error("Failed to clean temporary workspace", error),
        );
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.stopSession,
    (_event, sessionId: unknown) => {
      sessionManager.stop(requireIdentifier(sessionId, "Session ID"));
    },
  );

  ipcMain.handle(IPC_CHANNELS.readClipboardText, () =>
    clipboard.readText().slice(0, MAX_CLIPBOARD_PASTE_LENGTH),
  );

  ipcMain.handle(
    IPC_CHANNELS.writeClipboardText,
    (_event, text: unknown) => {
      clipboard.writeText(requireClipboardText(text));
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.showSessionNotification,
    (_event, request: SessionNotificationRequest) => {
      if (!request || typeof request !== "object") {
        throw new Error("Notification request is invalid.");
      }
      const sessionId = requireIdentifier(request.sessionId, "Session ID");
      if (!sessionManager.listSessions().some((session) => session.id === sessionId)) {
        return;
      }
      if (!Notification.isSupported()) {
        return;
      }
      const notification = new Notification({
        title: requireShortText(request.title, "Notification title", 120),
        body: requireShortText(request.body, "Notification body", 240),
      });
      notification.on("click", () => {
        if (window.isMinimized()) {
          window.restore();
        }
        window.show();
        window.focus();
      });
      notification.show();
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.getTerminalSnapshot,
    (_event, sessionId: unknown) =>
      sessionManager.getTerminalSnapshot(
        requireIdentifier(sessionId, "Session ID"),
      ),
  );

  ipcMain.on(
    IPC_CHANNELS.writeTerminal,
    (_event, request: WriteTerminalRequest) => {
      try {
        if (!request || typeof request !== "object") {
          return;
        }
        sessionManager.write(
          requireIdentifier(request.sessionId, "Session ID"),
          requireTerminalData(request.data),
        );
      } catch {
        // A stale renderer event must not terminate the Electron main process.
      }
    },
  );

  ipcMain.on(
    IPC_CHANNELS.resizeTerminal,
    (_event, request: ResizeTerminalRequest) => {
      try {
        if (!request || typeof request !== "object") {
          return;
        }
        sessionManager.resize(
          requireIdentifier(request.sessionId, "Session ID"),
          request.columns,
          request.rows,
        );
      } catch {
        // Ignore late resize events while a terminal tab is being disposed.
      }
    },
  );

  const sendTerminalData = (event: TerminalDataEvent) => {
    if (!window.isDestroyed()) {
      window.webContents.send(IPC_CHANNELS.terminalData, event);
    }
  };
  const sendSessionChanged = (session: SessionRecord) => {
    if (!window.isDestroyed()) {
      window.webContents.send(IPC_CHANNELS.sessionChanged, { session });
    }
    void projectStore
      .replaceSessions(sessionManager.listSessions())
      .catch((error: unknown) => console.error("Failed to persist sessions", error));
  };

  sessionManager.on("data", sendTerminalData);
  sessionManager.on("changed", sendSessionChanged);

  return () => {
    sessionManager.off("data", sendTerminalData);
    sessionManager.off("changed", sendSessionChanged);
    for (const channel of Object.values(IPC_CHANNELS)) {
      ipcMain.removeHandler(channel);
      ipcMain.removeAllListeners(channel);
    }
  };
}
