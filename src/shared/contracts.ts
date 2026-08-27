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
  projectId: string | null;
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

export type WeComConnectionStatus =
  | "disabled"
  | "connecting"
  | "connected"
  | "error";

export type WeComInboundStatus =
  | "received"
  | "routed"
  | "rejected"
  | "ignored"
  | "failed";

export interface WeComState {
  enabled: boolean;
  configured: boolean;
  hasSecret: boolean;
  botId: string;
  targetUserId: string;
  status: WeComConnectionStatus;
  error?: string;
  lastInboundAt?: number;
  lastInboundStatus?: WeComInboundStatus;
  lastInboundDetail?: string;
}

export interface AppSnapshot {
  projects: ProjectRecord[];
  sessions: SessionRecord[];
  claudeExecutable: ClaudeExecutableState;
  wecom: WeComState;
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

export type WorkspaceFileStatus =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "copied"
  | "untracked"
  | "conflicted";

export interface WorkspaceFileChange {
  path: string;
  previousPath?: string;
  status: WorkspaceFileStatus;
  staged: boolean;
  unstaged: boolean;
}

export interface WorkspaceChangesSnapshot {
  isGitRepository: boolean;
  files: WorkspaceFileChange[];
  truncated: boolean;
}

export type WorkspaceFileViewMode = "latest" | "diff";

export interface ReadWorkspaceFileRequest {
  projectId: string;
  path: string;
  mode: WorkspaceFileViewMode;
}

export type WorkspaceFileContentKind =
  | "text"
  | "binary"
  | "deleted"
  | "too-large";

export interface WorkspaceFileContent {
  path: string;
  mode: WorkspaceFileViewMode;
  kind: WorkspaceFileContentKind;
  content: string;
  size?: number;
}

export interface SessionChangedEvent {
  session: SessionRecord;
}

export interface WeComStateChangedEvent {
  state: WeComState;
}

export type CreateSessionRequest =
  | {
      scope: "project";
      projectId: string;
      title?: string;
    }
  | {
      scope: "temporary";
      title?: string;
    };

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

export interface UpdateWeComConfigRequest {
  enabled: boolean;
  botId: string;
  targetUserId: string;
  /** Empty or omitted keeps the previously saved Secret. */
  secret?: string;
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
  updateWeComConfig(request: UpdateWeComConfigRequest): Promise<WeComState>;
  createSession(request: CreateSessionRequest): Promise<SessionRecord>;
  restartSession(sessionId: string): Promise<SessionRecord>;
  renameSession(request: RenameSessionRequest): Promise<SessionRecord>;
  removeSession(sessionId: string): Promise<void>;
  stopSession(sessionId: string): Promise<void>;
  readClipboardText(): Promise<string>;
  writeClipboardText(text: string): Promise<void>;
  showSessionNotification(request: SessionNotificationRequest): Promise<void>;
  writeTerminal(request: WriteTerminalRequest): void;
  resizeTerminal(request: ResizeTerminalRequest): void;
  getTerminalSnapshot(sessionId: string): Promise<TerminalSnapshot>;
  listWorkspaceChanges(projectId: string): Promise<WorkspaceChangesSnapshot>;
  readWorkspaceFile(
    request: ReadWorkspaceFileRequest,
  ): Promise<WorkspaceFileContent>;
  onTerminalData(listener: (event: TerminalDataEvent) => void): () => void;
  onSessionChanged(listener: (event: SessionChangedEvent) => void): () => void;
  onWeComStateChanged(
    listener: (event: WeComStateChangedEvent) => void,
  ): () => void;
}
