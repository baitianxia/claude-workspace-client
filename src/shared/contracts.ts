export type SessionStatus =
  | "starting"
  | "running"
  | "exited"
  | "failed"
  | "interrupted";

export interface ProjectRecord {
  id: string;
  name: string;
  alias?: string;
  pinned: boolean;
  rootPath: string;
  createdAt: number;
  lastOpenedAt: number;
}

export interface SessionRecord {
  id: string;
  projectId: string;
  title: string;
  cwd: string;
  status: SessionStatus;
  createdAt: number;
  exitCode?: number;
  error?: string;
}

export interface ClaudeExecutableState {
  path: string | null;
  source: "custom" | "detected" | "missing";
  error?: string;
}

export interface AppSnapshot {
  projects: ProjectRecord[];
  sessions: SessionRecord[];
  claudeExecutable: ClaudeExecutableState;
}

export interface TerminalDataEvent {
  sessionId: string;
  data: string;
  sequence: number;
}

export interface TerminalSnapshot {
  data: string;
  lastSequence: number;
}

export interface SessionChangedEvent {
  session: SessionRecord;
}

export interface CreateSessionRequest {
  projectId: string;
  title?: string;
}

export interface RenameSessionRequest {
  sessionId: string;
  title: string;
}

export interface UpdateProjectRequest {
  projectId: string;
  alias?: string | null;
  pinned?: boolean;
}

export interface SessionNotificationRequest {
  sessionId: string;
  title: string;
  body: string;
}

export interface ResizeTerminalRequest {
  sessionId: string;
  columns: number;
  rows: number;
}

export interface WriteTerminalRequest {
  sessionId: string;
  data: string;
}

export interface DesktopApi {
  getSnapshot(): Promise<AppSnapshot>;
  selectProjectDirectory(): Promise<ProjectRecord | null>;
  updateProject(request: UpdateProjectRequest): Promise<ProjectRecord>;
  removeProject(projectId: string): Promise<void>;
  selectClaudeExecutable(): Promise<ClaudeExecutableState | null>;
  autoDetectClaudeExecutable(): Promise<ClaudeExecutableState>;
  createSession(request: CreateSessionRequest): Promise<SessionRecord>;
  renameSession(request: RenameSessionRequest): Promise<SessionRecord>;
  removeSession(sessionId: string): Promise<void>;
  stopSession(sessionId: string): Promise<void>;
  readClipboardText(): Promise<string>;
  writeClipboardText(text: string): Promise<void>;
  showSessionNotification(request: SessionNotificationRequest): Promise<void>;
  writeTerminal(request: WriteTerminalRequest): void;
  resizeTerminal(request: ResizeTerminalRequest): void;
  getTerminalSnapshot(sessionId: string): Promise<TerminalSnapshot>;
  onTerminalData(listener: (event: TerminalDataEvent) => void): () => void;
  onSessionChanged(listener: (event: SessionChangedEvent) => void): () => void;
}
