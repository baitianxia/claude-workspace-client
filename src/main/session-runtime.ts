import type { EventEmitter } from "node:events";
import type {
  SessionRecord,
  TerminalDataEvent,
  TerminalSnapshot,
} from "../shared/contracts";

export type Awaitable<T> = T | Promise<T>;

export interface SessionInputEvent {
  sessionId: string;
  source: "local" | "remote";
  data: string;
}

export interface SessionRuntimeEvents {
  data: [event: TerminalDataEvent];
  changed: [session: SessionRecord];
  input: [event: SessionInputEvent];
}

export interface SessionWorkspace {
  projectId: string | null;
  cwd: string;
}

/**
 * The session API consumed by the Electron main process and WeCom bridge.
 *
 * Local implementations may complete synchronously. A remote Session Host
 * completes mutating operations over its named-pipe request channel.
 */
export interface SessionRuntime extends EventEmitter<SessionRuntimeEvents> {
  listSessions(): SessionRecord[];
  createSession(
    workspace: SessionWorkspace,
    requestedTitle?: string,
  ): Awaitable<SessionRecord>;
  restartSession(sessionId: string): Awaitable<SessionRecord>;
  renameSession(
    sessionId: string,
    requestedTitle: string,
  ): Awaitable<SessionRecord>;
  write(sessionId: string, data: string): void;
  writeRemoteReply(sessionId: string, data: string): Awaitable<boolean>;
  resize(sessionId: string, columns: number, rows: number): void;
  stop(sessionId: string): Awaitable<void>;
  stopAll(): Awaitable<void>;
  removeSession(sessionId: string): Awaitable<SessionRecord>;
  removeProjectSessions(projectId: string): Awaitable<void>;
  hasRunningSessions(): boolean;
  getTerminalSnapshot(sessionId: string): Awaitable<TerminalSnapshot>;
  isCurrentLaunch(sessionId: string, launchId: string): boolean;
}
