import { contextBridge, ipcRenderer } from "electron";
import type {
  AutomationStateChangedEvent,
  DesktopApi,
  SessionChangedEvent,
  TerminalDataEvent,
  WeComStateChangedEvent,
} from "../shared/contracts";

type IpcChannelMap = typeof import("../shared/ipc-channels").IPC_CHANNELS;

// Keep the sandboxed preload self-contained. The type import above verifies that
// this map stays aligned with the main process without generating a local require().
const IPC_CHANNELS: IpcChannelMap = {
  getSnapshot: "workspace:get-snapshot",
  selectProjectDirectory: "workspace:select-project-directory",
  updateProject: "workspace:update-project",
  removeProject: "workspace:remove-project",
  selectClaudeExecutable: "workspace:select-claude-executable",
  autoDetectClaudeExecutable: "workspace:auto-detect-claude-executable",
  updateWeComConfig: "workspace:update-wecom-config",
  upsertAutomationJob: "workspace:upsert-automation-job",
  deleteAutomationJob: "workspace:delete-automation-job",
  runAutomationJob: "workspace:run-automation-job",
  retryAutomationRun: "workspace:retry-automation-run",
  cancelAutomationRun: "workspace:cancel-automation-run",
  createSession: "workspace:create-session",
  restartSession: "workspace:restart-session",
  renameSession: "workspace:rename-session",
  removeSession: "workspace:remove-session",
  stopSession: "workspace:stop-session",
  readClipboardText: "workspace:read-clipboard-text",
  writeClipboardText: "workspace:write-clipboard-text",
  showSessionNotification: "workspace:show-session-notification",
  writeTerminal: "workspace:write-terminal",
  resizeTerminal: "workspace:resize-terminal",
  getTerminalSnapshot: "workspace:get-terminal-snapshot",
  listWorkspaceChanges: "workspace:list-changes",
  readWorkspaceFile: "workspace:read-file",
  terminalData: "workspace:terminal-data",
  sessionChanged: "workspace:session-changed",
  wecomStateChanged: "workspace:wecom-state-changed",
  automationStateChanged: "workspace:automation-state-changed",
};

const api: DesktopApi = {
  getSnapshot: () => ipcRenderer.invoke(IPC_CHANNELS.getSnapshot),
  selectProjectDirectory: () =>
    ipcRenderer.invoke(IPC_CHANNELS.selectProjectDirectory),
  updateProject: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.updateProject, request),
  removeProject: (projectId) =>
    ipcRenderer.invoke(IPC_CHANNELS.removeProject, projectId),
  selectClaudeExecutable: () =>
    ipcRenderer.invoke(IPC_CHANNELS.selectClaudeExecutable),
  autoDetectClaudeExecutable: () =>
    ipcRenderer.invoke(IPC_CHANNELS.autoDetectClaudeExecutable),
  updateWeComConfig: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.updateWeComConfig, request),
  upsertAutomationJob: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.upsertAutomationJob, request),
  deleteAutomationJob: (jobId) =>
    ipcRenderer.invoke(IPC_CHANNELS.deleteAutomationJob, jobId),
  runAutomationJob: (jobId) =>
    ipcRenderer.invoke(IPC_CHANNELS.runAutomationJob, jobId),
  retryAutomationRun: (runId) =>
    ipcRenderer.invoke(IPC_CHANNELS.retryAutomationRun, runId),
  cancelAutomationRun: (runId) =>
    ipcRenderer.invoke(IPC_CHANNELS.cancelAutomationRun, runId),
  createSession: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.createSession, request),
  restartSession: (sessionId) =>
    ipcRenderer.invoke(IPC_CHANNELS.restartSession, sessionId),
  renameSession: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.renameSession, request),
  removeSession: (sessionId) =>
    ipcRenderer.invoke(IPC_CHANNELS.removeSession, sessionId),
  stopSession: (sessionId) =>
    ipcRenderer.invoke(IPC_CHANNELS.stopSession, sessionId),
  readClipboardText: () =>
    ipcRenderer.invoke(IPC_CHANNELS.readClipboardText),
  writeClipboardText: (text) =>
    ipcRenderer.invoke(IPC_CHANNELS.writeClipboardText, text),
  showSessionNotification: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.showSessionNotification, request),
  writeTerminal: (request) =>
    ipcRenderer.send(IPC_CHANNELS.writeTerminal, request),
  resizeTerminal: (request) =>
    ipcRenderer.send(IPC_CHANNELS.resizeTerminal, request),
  getTerminalSnapshot: (sessionId) =>
    ipcRenderer.invoke(IPC_CHANNELS.getTerminalSnapshot, sessionId),
  listWorkspaceChanges: (projectId) =>
    ipcRenderer.invoke(IPC_CHANNELS.listWorkspaceChanges, projectId),
  readWorkspaceFile: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.readWorkspaceFile, request),
  onTerminalData: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: TerminalDataEvent) =>
      listener(payload);
    ipcRenderer.on(IPC_CHANNELS.terminalData, handler);
    return () => ipcRenderer.off(IPC_CHANNELS.terminalData, handler);
  },
  onSessionChanged: (listener) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      payload: SessionChangedEvent,
    ) => listener(payload);
    ipcRenderer.on(IPC_CHANNELS.sessionChanged, handler);
    return () => ipcRenderer.off(IPC_CHANNELS.sessionChanged, handler);
  },
  onWeComStateChanged: (listener) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      payload: WeComStateChangedEvent,
    ) => listener(payload);
    ipcRenderer.on(IPC_CHANNELS.wecomStateChanged, handler);
    return () => ipcRenderer.off(IPC_CHANNELS.wecomStateChanged, handler);
  },
  onAutomationStateChanged: (listener) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      payload: AutomationStateChangedEvent,
    ) => listener(payload);
    ipcRenderer.on(IPC_CHANNELS.automationStateChanged, handler);
    return () => ipcRenderer.off(IPC_CHANNELS.automationStateChanged, handler);
  },
};

contextBridge.exposeInMainWorld("claudeWorkspace", api);
