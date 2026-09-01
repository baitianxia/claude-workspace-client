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

export interface AutomationJobRecord {
  id: string;
  name: string;
  enabled: boolean;
  projectId: string;
  /** Five-field cron expression evaluated in the computer's local timezone. */
  schedule: string;
  /** Project-relative path to the MCP JSON loaded for this job. */
  mcpConfigPath: string;
  allowedMcpServers: string[];
  prompt: string;
  emailRecipients: string[];
  /** Automation bot profile used for all WeCom targets on this job. */
  wecomBotProfileId?: string;
  wecomTargetIds: string[];
  /** User IDs allowed to start follow-up runs; "*" explicitly allows the group. */
  allowedWecomUserIds: string[];
  timeoutMinutes: number;
  maxTurns: number;
  createdAt: number;
  updatedAt: number;
}

export type AutomationRunTrigger = "scheduled" | "manual" | "wecom";

export type AutomationRunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "timed-out"
  | "cancelled"
  | "skipped";

export type AutomationDeliveryStatus =
  | "pending"
  | "sending"
  | "sent"
  | "failed"
  | "skipped";

export interface AutomationDeliveryRecord {
  /** Missing only on legacy records created before automation bot profiles. */
  botProfileId?: string;
  targetId: string;
  status: AutomationDeliveryStatus;
  attempts: number;
  sentAt?: number;
  nextAttemptAt?: number;
  error?: string;
}

export interface AutomationEvidence {
  title: string;
  url: string;
}

export type AutomationEmailStatus =
  | "not-requested"
  | "sent"
  | "failed";

export interface AutomationRunOutput {
  outcome: "notify" | "no-change";
  summary: string;
  wecomMarkdown: string;
  evidence: AutomationEvidence[];
  email: {
    status: AutomationEmailStatus;
    recipients: string[];
    detail: string;
  };
}

export interface AutomationRunRecord {
  id: string;
  reportCode: string;
  jobId: string;
  jobName: string;
  trigger: AutomationRunTrigger;
  status: AutomationRunStatus;
  attempt: number;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  scheduledFor?: number;
  triggerMessageId?: string;
  sourceRunId?: string;
  requestedBy?: string;
  requestText?: string;
  quoteText?: string;
  sessionId?: string;
  exitCode?: number;
  result?: AutomationRunOutput;
  error?: string;
  diagnostic?: string;
  deliveries: AutomationDeliveryRecord[];
}

export interface DiscoveredWeComGroup {
  /** Missing only on legacy records discovered through the management bot. */
  botProfileId?: string;
  chatId: string;
  alias?: string;
  discoveredAt: number;
  lastSeenAt: number;
}

export interface AutomationWeComBotProfile {
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

export interface AutomationSnapshot {
  jobs: AutomationJobRecord[];
  runs: AutomationRunRecord[];
  wecomBots: AutomationWeComBotProfile[];
  discoveredWeComGroups: DiscoveredWeComGroup[];
  runningJobIds: string[];
  schedulerActive: boolean;
  lastSchedulerCheckAt?: number;
}

export interface AppSnapshot {
  projects: ProjectRecord[];
  sessions: SessionRecord[];
  claudeExecutable: ClaudeExecutableState;
  wecom: WeComState;
  automation: AutomationSnapshot;
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

export interface AutomationStateChangedEvent {
  state: AutomationSnapshot;
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

export interface UpsertAutomationJobRequest {
  id?: string;
  name: string;
  enabled: boolean;
  projectId: string;
  schedule: string;
  mcpConfigPath: string;
  allowedMcpServers: string[];
  prompt: string;
  emailRecipients: string[];
  wecomBotProfileId?: string;
  wecomTargetIds: string[];
  allowedWecomUserIds: string[];
  timeoutMinutes: number;
  maxTurns: number;
}

export interface UpsertAutomationWeComBotRequest {
  id?: string;
  name: string;
  enabled: boolean;
  botId: string;
  /** Empty or omitted keeps the previously saved Secret. */
  secret?: string;
}

export interface UpdateAutomationWeComGroupAliasRequest {
  botProfileId: string;
  chatId: string;
  /** Empty text clears the locally assigned alias. */
  alias: string;
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
  upsertAutomationJob(
    request: UpsertAutomationJobRequest,
  ): Promise<AutomationJobRecord>;
  upsertAutomationWeComBot(
    request: UpsertAutomationWeComBotRequest,
  ): Promise<AutomationWeComBotProfile>;
  deleteAutomationWeComBot(botProfileId: string): Promise<void>;
  updateAutomationWeComGroupAlias(
    request: UpdateAutomationWeComGroupAliasRequest,
  ): Promise<DiscoveredWeComGroup>;
  deleteAutomationJob(jobId: string): Promise<void>;
  runAutomationJob(jobId: string): Promise<AutomationRunRecord>;
  retryAutomationRun(runId: string): Promise<AutomationRunRecord>;
  cancelAutomationRun(runId: string): Promise<void>;
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
  onAutomationStateChanged(
    listener: (event: AutomationStateChangedEvent) => void,
  ): () => void;
}
