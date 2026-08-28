import type {
  SessionRecord,
  TerminalDataEvent,
  TerminalSnapshot,
} from "../../shared/contracts";
import type { ClaudeHookEvent } from "../claude-hook-server";
import type { SessionInputEvent, SessionWorkspace } from "../session-runtime";

export const SESSION_HOST_PROTOCOL_VERSION = 1;
export const SESSION_HOST_RUNTIME_VERSION = "1";
export const SESSION_HOST_EXECUTABLE_FILENAME =
  "Claude Workspace Session Host.exe";
export const SESSION_HOST_MAX_MESSAGE_BYTES = 8_000_000;
export const SESSION_HOST_ENDPOINT_ENV = "CLAUDE_WORKSPACE_HOST_ENDPOINT";
export const SESSION_HOST_TOKEN_ENV = "CLAUDE_WORKSPACE_HOST_TOKEN";
export const SESSION_HOST_STATE_PATH_ENV = "CLAUDE_WORKSPACE_HOST_STATE_PATH";
export const SESSION_HOST_LOG_PATH_ENV = "CLAUDE_WORKSPACE_HOST_LOG_PATH";

export interface SessionHostSnapshot {
  sessions: SessionRecord[];
  launchIds: Record<string, string>;
  hookAvailabilityError?: string;
}

export interface SessionHostInitializeRequest {
  executablePath: string | null;
  initialSessions: SessionRecord[];
}

export type SessionHostRequestMethod =
  | "initialize"
  | "snapshot"
  | "setExecutable"
  | "createSession"
  | "restartSession"
  | "renameSession"
  | "write"
  | "writeRemoteReply"
  | "resize"
  | "stopSession"
  | "stopAll"
  | "removeSession"
  | "removeProjectSessions"
  | "getTerminalSnapshot"
  | "shutdownIfIdle";

export type SessionHostEvent =
  | { event: "terminalData"; payload: TerminalDataEvent }
  | {
      event: "sessionChanged";
      payload: { session: SessionRecord; launchId: string | null };
    }
  | { event: "sessionInput"; payload: SessionInputEvent }
  | { event: "claudeHook"; payload: ClaudeHookEvent };

export type SessionHostClientMessage =
  | {
      type: "hello";
      protocolVersion: number;
      token: string;
    }
  | {
      type: "request";
      id: string;
      method: SessionHostRequestMethod;
      params?: unknown;
    };

export type SessionHostServerMessage =
  | {
      type: "hello";
      protocolVersion: number;
      runtimeVersion: string;
      hostPid: number;
    }
  | {
      type: "response";
      id: string;
      ok: true;
      result?: unknown;
    }
  | {
      type: "response";
      id: string;
      ok: false;
      error: string;
    }
  | ({ type: "event" } & SessionHostEvent);

export interface CreateSessionParams {
  workspace: SessionWorkspace;
  requestedTitle?: string;
}

export interface RenameSessionParams {
  sessionId: string;
  requestedTitle: string;
}

export interface WriteSessionParams {
  sessionId: string;
  data: string;
}

export interface ResizeSessionParams {
  sessionId: string;
  columns: number;
  rows: number;
}

export interface SessionIdParams {
  sessionId: string;
}

export interface ProjectIdParams {
  projectId: string;
}

export type SessionHostMethodResult =
  | SessionHostSnapshot
  | SessionRecord
  | TerminalSnapshot
  | boolean
  | null;
