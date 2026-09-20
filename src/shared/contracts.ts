export type SessionStatus =
  | "starting"
  | "running"
  | "exited"
  | "failed"
  | "interrupted";

/** User-selectable application appearance. Persisted in workspace settings. */
export type AppTheme = "dark" | "light";

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
  /** Most recent local Claude Hook delivery diagnostic. */
  lastClaudeHookAt?: number;
  lastClaudeHookDetail?: string;
}

export interface AssistantWeComBotProfile {
  id: string;
  name: string;
  enabled: boolean;
  configured: boolean;
  hasSecret: boolean;
  botId: string;
  status: WeComConnectionStatus;
  error?: string;
  lastInboundAt?: number;
  lastInboundStatus?: WeComInboundStatus;
  lastInboundDetail?: string;
  createdAt: number;
  updatedAt: number;
}

export interface AssistantProfileRecord {
  id: string;
  name: string;
  enabled: boolean;
  /**
   * Absolute directory used by the assistant's Claude sessions. This is an
   * assistant-owned path and is deliberately independent from ProjectStore.
   */
  projectPath: string;
  /**
   * Legacy workbench project id. Kept only so old assistant.json records can
   * be migrated once; new records must not persist this association.
   */
  projectId?: string;
  instructions: string;
  /** The owner whose WeCom single-chat shares the local desktop conversation. */
  ownerWeComUserId: string;
  /** Optional WeCom business bot used only as a remote entry channel. */
  wecomBotProfileId?: string;
  timeoutMinutes: number;
  maxTurns: number;
  createdAt: number;
  updatedAt: number;
}

export interface AssistantConversationRecord {
  id: string;
  assistantId: string;
  /** The first release only persists the owner's cross-channel conversation. */
  kind: "owner";
  claudeSessionId?: string;
  createdAt: number;
  updatedAt: number;
  lastMessageAt?: number;
}

export type AssistantTurnSource = "desktop" | "wecom";

export type AssistantTurnStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "timed-out"
  | "cancelled";

export interface AssistantTurnRecord {
  id: string;
  assistantId: string;
  conversationId: string;
  source: AssistantTurnSource;
  /** Present for WeCom turns and used for persistent deduplication. */
  messageId?: string;
  /** WeCom entry identity fixed when the turn is accepted. */
  botProfileId?: string;
  userId?: string;
  request: string;
  status: AssistantTurnStatus;
  response?: string;
  error?: string;
  deliveryError?: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
}

export interface AssistantTaskRecord {
  id: string;
  assistantId: string;
  name: string;
  enabled: boolean;
  /** Five-field cron expression evaluated in the computer's local timezone. */
  schedule: string;
  prompt: string;
  timeoutMinutes: number;
  maxTurns: number;
  createdAt: number;
  updatedAt: number;
}

export type AssistantTaskRunTrigger = "scheduled" | "manual";

export type AssistantTaskRunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "timed-out"
  | "cancelled"
  | "skipped";

export interface AssistantTaskRunRecord {
  id: string;
  taskId: string;
  assistantId: string;
  taskName: string;
  trigger: AssistantTaskRunTrigger;
  status: AssistantTaskRunStatus;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  scheduledFor?: number;
  response?: string;
  error?: string;
  deliveryError?: string;
}

export interface AssistantSnapshot {
  profiles: AssistantProfileRecord[];
  conversations: AssistantConversationRecord[];
  turns: AssistantTurnRecord[];
  wecomBots: AssistantWeComBotProfile[];
  tasks: AssistantTaskRecord[];
  taskRuns: AssistantTaskRunRecord[];
  runningConversationIds: string[];
  openConversationIds: string[];
  resumableConversationIds: string[];
  runningTaskIds: string[];
  schedulerActive: boolean;
  lastSchedulerCheckAt?: number;
  schedulerError?: string;
  schedulerErrorAt?: number;
}

export interface AppSnapshot {
  projects: ProjectRecord[];
  sessions: SessionRecord[];
  claudeExecutable: ClaudeExecutableState;
  wecom: WeComState;
  assistant: AssistantSnapshot;
  theme: AppTheme;
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

export interface AssistantStateChangedEvent {
  state: AssistantSnapshot;
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

export interface UpsertAssistantWeComBotRequest {
  id?: string;
  name: string;
  enabled: boolean;
  botId: string;
  /** Empty or omitted keeps the previously saved Secret. */
  secret?: string;
}

/**
 * Bot details entered while creating or configuring one private assistant.
 * The Secret crosses the IPC boundary only to be encrypted by the main
 * process; it is never part of an AssistantProfileRecord or snapshot.
 */
export interface AssistantWeComBotDraft {
  id?: string;
  name: string;
  enabled: boolean;
  botId: string;
  /** Empty or omitted keeps the Secret already stored for `id`. */
  secret?: string;
}

export interface UpsertAssistantProfileRequest {
  id?: string;
  name: string;
  enabled: boolean;
  /** Directory used to run this assistant, independent from workbench projects. */
  projectPath: string;
  /** @deprecated Accepted only for one-time migration of old renderer clients. */
  projectId?: string;
  instructions: string;
  ownerWeComUserId: string;
  /**
   * Direct bot configuration for this assistant. `null` explicitly removes a
   * binding; an omitted value keeps the legacy `wecomBotProfileId` behavior.
   */
  wecomBot?: AssistantWeComBotDraft | null;
  /** @deprecated Use `wecomBot`; accepted for older renderer clients only. */
  wecomBotProfileId?: string;
  timeoutMinutes: number;
  maxTurns: number;
}

export interface SendAssistantMessageRequest {
  assistantId: string;
  text: string;
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
  setTheme(theme: AppTheme): Promise<AppTheme>;
  selectProjectDirectory(): Promise<ProjectRecord | null>;
  selectAssistantProjectDirectory(): Promise<string | null>;
  updateProject(request: UpdateProjectRequest): Promise<ProjectRecord>;
  removeProject(projectId: string): Promise<void>;
  selectClaudeExecutable(): Promise<ClaudeExecutableState | null>;
  autoDetectClaudeExecutable(): Promise<ClaudeExecutableState>;
  updateWeComConfig(request: UpdateWeComConfigRequest): Promise<WeComState>;
  upsertAssistantProfile(
    request: UpsertAssistantProfileRequest,
  ): Promise<AssistantProfileRecord>;
  deleteAssistantProfile(assistantId: string): Promise<void>;
  sendAssistantMessage(
    request: SendAssistantMessageRequest,
  ): Promise<AssistantTurnRecord>;
  resetAssistantConversation(
    assistantId: string,
  ): Promise<AssistantConversationRecord>;
  closeAssistantConversation(assistantId: string): Promise<void>;
  /** Cancel the running turn, or a specific queued turn when turnId is given. */
  cancelAssistantTurn(conversationId: string, turnId?: string): Promise<void>;
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
  onAssistantStateChanged(
    listener: (event: AssistantStateChangedEvent) => void,
  ): () => void;
}
