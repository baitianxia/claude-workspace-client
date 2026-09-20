import { contextBridge, ipcRenderer } from "electron";
import type {
  AssistantStateChangedEvent,
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
  setTheme: "workspace:set-theme",
  selectProjectDirectory: "workspace:select-project-directory",
  selectAssistantProjectDirectory: "workspace:select-assistant-project-directory",
  updateProject: "workspace:update-project",
  removeProject: "workspace:remove-project",
  selectClaudeExecutable: "workspace:select-claude-executable",
  autoDetectClaudeExecutable: "workspace:auto-detect-claude-executable",
  updateWeComConfig: "workspace:update-wecom-config",
  upsertAssistantProfile: "workspace:upsert-assistant-profile",
  deleteAssistantProfile: "workspace:delete-assistant-profile",
  sendAssistantMessage: "workspace:send-assistant-message",
  resetAssistantConversation: "workspace:reset-assistant-conversation",
  closeAssistantConversation: "workspace:close-assistant-conversation",
  cancelAssistantTurn: "workspace:cancel-assistant-turn",
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
  assistantStateChanged: "workspace:assistant-state-changed",
};

const api: DesktopApi = {
  getSnapshot: () => ipcRenderer.invoke(IPC_CHANNELS.getSnapshot),
  setTheme: (theme) => ipcRenderer.invoke(IPC_CHANNELS.setTheme, theme),
  selectProjectDirectory: () =>
    ipcRenderer.invoke(IPC_CHANNELS.selectProjectDirectory),
  selectAssistantProjectDirectory: () =>
    ipcRenderer.invoke(IPC_CHANNELS.selectAssistantProjectDirectory),
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
  upsertAssistantProfile: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.upsertAssistantProfile, request),
  deleteAssistantProfile: (assistantId) =>
    ipcRenderer.invoke(IPC_CHANNELS.deleteAssistantProfile, assistantId),
  sendAssistantMessage: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.sendAssistantMessage, request),
  resetAssistantConversation: (assistantId) =>
    ipcRenderer.invoke(IPC_CHANNELS.resetAssistantConversation, assistantId),
  closeAssistantConversation: (assistantId) =>
    ipcRenderer.invoke(IPC_CHANNELS.closeAssistantConversation, assistantId),
  cancelAssistantTurn: (conversationId, turnId) =>
    ipcRenderer.invoke(IPC_CHANNELS.cancelAssistantTurn, conversationId, turnId),
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
  onAssistantStateChanged: (listener) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      payload: AssistantStateChangedEvent,
    ) => listener(payload);
    ipcRenderer.on(IPC_CHANNELS.assistantStateChanged, handler);
    return () => ipcRenderer.off(IPC_CHANNELS.assistantStateChanged, handler);
  },
};

contextBridge.exposeInMainWorld("claudeWorkspace", api);
