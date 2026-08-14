import { contextBridge, ipcRenderer } from "electron";
import type {
  DesktopApi,
  SessionChangedEvent,
  TerminalDataEvent,
} from "../shared/contracts";

type IpcChannelMap = typeof import("../shared/ipc-channels").IPC_CHANNELS;

// Keep the sandboxed preload self-contained. The type import above verifies that
// this map stays aligned with the main process without generating a local require().
const IPC_CHANNELS: IpcChannelMap = {
  getSnapshot: "workspace:get-snapshot",
  selectProjectDirectory: "workspace:select-project-directory",
  removeProject: "workspace:remove-project",
  selectClaudeExecutable: "workspace:select-claude-executable",
  autoDetectClaudeExecutable: "workspace:auto-detect-claude-executable",
  createSession: "workspace:create-session",
  renameSession: "workspace:rename-session",
  removeSession: "workspace:remove-session",
  stopSession: "workspace:stop-session",
  readClipboardText: "workspace:read-clipboard-text",
  writeClipboardText: "workspace:write-clipboard-text",
  writeTerminal: "workspace:write-terminal",
  resizeTerminal: "workspace:resize-terminal",
  getTerminalSnapshot: "workspace:get-terminal-snapshot",
  terminalData: "workspace:terminal-data",
  sessionChanged: "workspace:session-changed",
};

const api: DesktopApi = {
  getSnapshot: () => ipcRenderer.invoke(IPC_CHANNELS.getSnapshot),
  selectProjectDirectory: () =>
    ipcRenderer.invoke(IPC_CHANNELS.selectProjectDirectory),
  removeProject: (projectId) =>
    ipcRenderer.invoke(IPC_CHANNELS.removeProject, projectId),
  selectClaudeExecutable: () =>
    ipcRenderer.invoke(IPC_CHANNELS.selectClaudeExecutable),
  autoDetectClaudeExecutable: () =>
    ipcRenderer.invoke(IPC_CHANNELS.autoDetectClaudeExecutable),
  createSession: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.createSession, request),
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
  writeTerminal: (request) =>
    ipcRenderer.send(IPC_CHANNELS.writeTerminal, request),
  resizeTerminal: (request) =>
    ipcRenderer.send(IPC_CHANNELS.resizeTerminal, request),
  getTerminalSnapshot: (sessionId) =>
    ipcRenderer.invoke(IPC_CHANNELS.getTerminalSnapshot, sessionId),
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
};

contextBridge.exposeInMainWorld("claudeWorkspace", api);
