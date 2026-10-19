import {
  clipboard,
  dialog,
  ipcMain,
  Notification,
  type BrowserWindow,
} from "electron";
import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  AppTheme,
  SendAssistantMessageRequest,
  AppSnapshot,
  CreateSessionRequest,
  ManageAssistantTaskRequest,
  ReadWorkspaceFileRequest,
  RenameSessionRequest,
  ResizeTerminalRequest,
  SessionNotificationRequest,
  SessionRecord,
  TerminalDataEvent,
  TerminalVisibleLinesRequest,
  UpsertAssistantProfileRequest,
  UpdateWeComConfigRequest,
  UpdateProjectRequest,
  WriteTerminalRequest,
} from "../shared/contracts";
import { AssistantService } from "./assistant-service";
import { IPC_CHANNELS } from "../shared/ipc-channels";
import type { ClaudeLocator } from "./claude-locator";
import type { ProjectStore } from "./project-store";
import type { SessionManager } from "./session-manager";
import type { TemporaryWorkspace } from "./temporary-workspace";
import type { WeComBridge } from "./wecom-bridge";
import type { WeComSettingsService } from "./wecom-settings";
import { WorkspaceFiles } from "./workspace-files";

const MAX_CLIPBOARD_PASTE_LENGTH = 100_000;
const MAX_CLIPBOARD_COPY_LENGTH = 2_000_000;
const MAX_TERMINAL_VISIBLE_LINES = 500;
const MAX_TERMINAL_VISIBLE_LINE_LENGTH = 4_000;
const MAX_TERMINAL_VISIBLE_TEXT_LENGTH = 100_000;

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

function requireTerminalVisibleLines(value: unknown): TerminalVisibleLinesRequest {
  if (!value || typeof value !== "object") {
    throw new Error("Visible terminal rows are invalid.");
  }
  const request = value as Partial<TerminalVisibleLinesRequest>;
  const sessionId = requireIdentifier(request.sessionId, "Session ID");
  if (
    typeof request.sequence !== "number" ||
    !Number.isSafeInteger(request.sequence) ||
    request.sequence < 0
  ) {
    throw new Error("Visible terminal sequence is invalid.");
  }
  if (!Array.isArray(request.lines) || request.lines.length > MAX_TERMINAL_VISIBLE_LINES) {
    throw new Error("Visible terminal rows are invalid.");
  }
  const lines = request.lines.map((line) => {
    if (typeof line !== "string" || line.length > MAX_TERMINAL_VISIBLE_LINE_LENGTH) {
      throw new Error("Visible terminal rows are invalid.");
    }
    return line;
  });
  if (
    lines.reduce((total, line) => total + line.length, 0) >
    MAX_TERMINAL_VISIBLE_TEXT_LENGTH
  ) {
    throw new Error("Visible terminal rows are too large.");
  }
  const isDimension = (number: unknown): number is number =>
    typeof number === "number" && Number.isInteger(number) && number > 0 && number <= 1_000;
  if (!isDimension(request.rows) || !isDimension(request.columns)) {
    throw new Error("Visible terminal dimensions are invalid.");
  }
  if (
    typeof request.viewportY !== "number" ||
    !Number.isInteger(request.viewportY) ||
    request.viewportY < 0
  ) {
    throw new Error("Visible terminal viewport is invalid.");
  }
  return {
    sessionId,
    sequence: request.sequence,
    lines,
    viewportY: request.viewportY,
    rows: request.rows,
    columns: request.columns,
  };
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
  wecomBridge: WeComBridge;
  wecomSettingsService: WeComSettingsService;
  assistantService: AssistantService;
}): () => void {
  const {
    window,
    projectStore,
    claudeLocator,
    sessionManager,
    temporaryWorkspace,
    wecomBridge,
    wecomSettingsService,
    assistantService,
  } = options;
  const workspaceFiles = new WorkspaceFiles();

  const getSnapshot = (): AppSnapshot => ({
    projects: projectStore.listProjects(),
    sessions: sessionManager.listSessions(),
    claudeExecutable: claudeLocator.getState(),
    wecom: wecomBridge.getState(),
    assistant: assistantService.getSnapshot(),
    theme: projectStore.getTheme(),
  });

  ipcMain.handle(IPC_CHANNELS.getSnapshot, getSnapshot);

  ipcMain.handle(
    IPC_CHANNELS.setTheme,
    async (_event, theme: unknown): Promise<AppTheme> => {
      if (theme !== "dark" && theme !== "light") {
        throw new Error("Workspace theme is invalid.");
      }
      await projectStore.setTheme(theme);
      // Keep the native window surface in sync while the renderer applies its
      // scoped palette. This also avoids a dark flash around transparent UI
      // surfaces when the user switches to the light theme.
      window.setBackgroundColor(theme === "light" ? "#f6f6f4" : "#12110f");
      return projectStore.getTheme();
    },
  );

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

  ipcMain.handle(IPC_CHANNELS.selectAssistantProjectDirectory, async () => {
    const selection = await dialog.showOpenDialog(window, {
      title: "选择私人助理运行目录",
      buttonLabel: "使用此目录",
      properties: ["openDirectory", "createDirectory"],
    });
    if (selection.canceled || selection.filePaths.length === 0) {
      return null;
    }
    const absolutePath = resolve(selection.filePaths[0]);
    const details = await stat(absolutePath);
    if (!details.isDirectory()) {
      throw new Error("私人助理运行目录必须是文件夹。");
    }
    return realpath(absolutePath);
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
    IPC_CHANNELS.updateWeComConfig,
    (_event, request: UpdateWeComConfigRequest) =>
      wecomSettingsService.update(request),
  );

  ipcMain.handle(
    IPC_CHANNELS.upsertAssistantProfile,
    (_event, request: UpsertAssistantProfileRequest) =>
      assistantService.upsertProfile(request),
  );

  ipcMain.handle(
    IPC_CHANNELS.deleteAssistantProfile,
    (_event, assistantId: unknown) =>
      assistantService.deleteProfile(
        requireIdentifier(assistantId, "Assistant profile ID"),
      ),
  );

  ipcMain.handle(
    IPC_CHANNELS.sendAssistantMessage,
    (_event, request: SendAssistantMessageRequest) =>
      assistantService.sendDesktopMessage(request),
  );

  ipcMain.handle(
    IPC_CHANNELS.resetAssistantConversation,
    (_event, assistantId: unknown) =>
      assistantService.resetOwnerConversation(
        requireIdentifier(assistantId, "Assistant profile ID"),
      ),
  );

  ipcMain.handle(
    IPC_CHANNELS.cancelAssistantTurn,
    (_event, conversationId: unknown, turnId: unknown) =>
      assistantService.cancelTurn(
        requireIdentifier(conversationId, "Assistant conversation ID"),
        turnId === undefined
          ? undefined
          : requireIdentifier(turnId, "Assistant turn ID"),
      ),
  );

  ipcMain.handle(
    IPC_CHANNELS.closeAssistantConversation,
    (_event, assistantId: unknown) =>
      assistantService.closeOwnerConversation(
        requireIdentifier(assistantId, "Assistant profile ID"),
      ),
  );

  ipcMain.handle(
    IPC_CHANNELS.manageAssistantTask,
    (_event, request: ManageAssistantTaskRequest) => {
      if (!request || typeof request !== "object") {
        throw new Error("定时任务操作请求无效。");
      }
      return assistantService.manageTask({
        assistantId: requireIdentifier(request.assistantId, "Assistant profile ID"),
        taskId: requireIdentifier(request.taskId, "Assistant task ID"),
        action: request.action,
      });
    },
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
      if (
        request.skipPermissions !== undefined &&
        typeof request.skipPermissions !== "boolean"
      ) {
        throw new Error("Session permission mode is invalid.");
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
      let session: SessionRecord;
      try {
        session = sessionManager.createSession(
          { projectId, cwd },
          request.title,
          request.skipPermissions,
        );
      } catch (error) {
        if (projectId === null) {
          await temporaryWorkspace.removeDirectory(cwd).catch((cleanupError: unknown) =>
            console.error("Failed to clean temporary workspace after launch failure", cleanupError),
          );
          // SessionManager records a failed launch so a normal project
          // session can be retried. A temporary session whose directory was
          // just removed must not remain as a restartable record pointing at
          // a path that no longer exists.
          const failedTemporarySession = sessionManager
            .listSessions()
            .find(
              (candidate) =>
                candidate.projectId === null &&
                candidate.cwd === cwd &&
                candidate.status === "failed",
            );
          if (failedTemporarySession) {
            sessionManager.removeSession(failedTemporarySession.id);
            await projectStore
              .replaceSessions(sessionManager.listSessions())
              .catch((persistError: unknown) =>
                console.error(
                  "Failed to persist temporary session cleanup",
                  persistError,
                ),
              );
          }
        }
        throw error;
      }
      await projectStore.replaceSessions(sessionManager.listSessions());
      return session;
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.restartSession,
    async (_event, sessionId: unknown) => {
      const session = sessionManager.restartSession(
        requireIdentifier(sessionId, "Session ID"),
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
      const removed = await sessionManager.removeSessionAndWait(
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
    IPC_CHANNELS.syncTerminalVisibleLines,
    (_event, request: unknown) => {
      try {
        sessionManager.setTerminalVisibleLines(
          requireTerminalVisibleLines(request),
        );
      } catch {
        // Renderer snapshots are best-effort. Ignore stale or malformed
        // updates rather than allowing an IPC payload to terminate the main
        // process or interrupt the PTY session.
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.listWorkspaceChanges,
    (_event, projectId: unknown) => {
      const project = projectStore.getProject(
        requireIdentifier(projectId, "Project ID"),
      );
      if (!project) {
        throw new Error("工程不存在，请重新选择目录。");
      }
      return workspaceFiles.list(project.rootPath);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.readWorkspaceFile,
    (_event, request: ReadWorkspaceFileRequest) => {
      if (!request || typeof request !== "object") {
        throw new Error("文件读取请求无效。");
      }
      const project = projectStore.getProject(
        requireIdentifier(request.projectId, "Project ID"),
      );
      if (!project) {
        throw new Error("工程不存在，请重新选择目录。");
      }
      if (typeof request.path !== "string") {
        throw new Error("文件路径无效。");
      }
      if (request.mode !== "latest" && request.mode !== "diff") {
        throw new Error("不支持的文件查看方式。");
      }
      return workspaceFiles.read(project.rootPath, request.path, request.mode);
    },
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
  const sendWeComStateChanged = () => {
    if (!window.isDestroyed()) {
      window.webContents.send(IPC_CHANNELS.wecomStateChanged, {
        state: wecomBridge.getState(),
      });
    }
  };
  const sendAssistantStateChanged = () => {
    if (!window.isDestroyed()) {
      window.webContents.send(IPC_CHANNELS.assistantStateChanged, {
        state: assistantService.getSnapshot(),
      });
    }
  };

  sessionManager.on("data", sendTerminalData);
  sessionManager.on("changed", sendSessionChanged);
  wecomBridge.on("stateChanged", sendWeComStateChanged);
  assistantService.on("stateChanged", sendAssistantStateChanged);

  return () => {
    sessionManager.off("data", sendTerminalData);
    sessionManager.off("changed", sendSessionChanged);
    wecomBridge.off("stateChanged", sendWeComStateChanged);
    assistantService.off("stateChanged", sendAssistantStateChanged);
    for (const channel of Object.values(IPC_CHANNELS)) {
      ipcMain.removeHandler(channel);
      ipcMain.removeAllListeners(channel);
    }
  };
}
