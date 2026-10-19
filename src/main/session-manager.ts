import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { IPty, IPtyForkOptions } from "node-pty";
import { spawn as spawnPty } from "node-pty";
import type {
  SessionRecord,
  TerminalDataEvent,
  TerminalSnapshot,
  TerminalVisibleLinesRequest,
} from "../shared/contracts";
import {
  TERMINAL_PASTE_CHUNK_DELAY_MS,
  shouldThrottleTerminalInput,
  splitTerminalPaste,
} from "../shared/terminal-paste";
import { createClaudeLaunchSpec } from "./claude-executable";
import {
  CLAUDE_RESUME_NOT_FOUND_PATTERN,
  stripAnsi,
  type ClaudeTranscriptLookup,
} from "./claude-session-files";
import { terminateProcessTree } from "./process-tree";
import { nextSessionTitle } from "./session-title";
import { TerminalBuffer } from "./terminal-buffer";

const MAX_TERMINAL_BUFFER_LENGTH = 2_000_000;
// Only the beginning of a resumed launch can contain Claude's "No
// conversation found" error, and the probe keeps a short rolling window so a
// message split across PTY chunks still matches.
const RESUME_PROBE_WINDOW_LENGTH = 1_024;
const RESUME_PROBE_MAX_OUTPUT_LENGTH = 16_000;
// A real resume failure prints the error and exits immediately with a
// non-zero code. Requiring both keeps a resumed conversation that merely
// *mentions* the error text (in its rendered history) from being discarded.
const RESUME_FAILURE_EXIT_WINDOW_MS = 30_000;
// Claude Code's Ink picker reads one keypress per PTY write. A short gap keeps
// consecutive arrow/Enter events distinct on Windows ConPTY and Unix PTYs.
const REMOTE_INPUT_KEY_DELAY_MS = 35;
// Upper bound for waiting on a terminated PTY to report its exit.
const PROCESS_EXIT_WAIT_MS = 3_000;

function waitForPtyExit(processHandle: IPty, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      subscription.dispose();
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    timer.unref?.();
    const subscription = processHandle.onExit(finish);
  });
}

interface ManagedSession {
  record: SessionRecord;
  process: IPty | null;
  launchId: string | null;
  terminal: TerminalBuffer;
  sequence: number;
  /** How the current process was launched; used to detect a failed resume. */
  launchMode?: ClaudeSessionLaunchMode;
  launchStartedAt?: number;
  resumeProbe?: string;
  resumeProbeLength?: number;
  resumeNotFound?: boolean;
  /**
   * Set when a resume launch reported that Claude no longer has the
   * conversation. The next restart starts a new Claude session instead of
   * repeating the failing `--resume`. Kept in memory only: after a client
   * restart the transcript lookup runs again.
   */
  forceNewOnRestart?: boolean;
}

interface InputQueueItem {
  run: () => boolean | Promise<boolean>;
  resolve: (value: boolean) => void;
  reject: (reason: unknown) => void;
}

interface InputQueue {
  items: InputQueueItem[];
  running: boolean;
  cancelled: boolean;
}

export interface SessionInputEvent {
  sessionId: string;
  source: "local" | "remote";
  data: string;
}

export interface ClaudeSessionLaunchOptions {
  args: string[];
  env?: NodeJS.ProcessEnv;
}

export type ClaudeSessionLaunchOptionsProvider = (
  sessionId: string,
  launchId: string,
) => ClaudeSessionLaunchOptions;

type ClaudeSessionLaunchMode = "new" | "resume";

export type SessionProcessTreeTerminator = (pid: number) => Promise<void>;

export interface SessionManagerEvents {
  data: [event: TerminalDataEvent];
  changed: [session: SessionRecord];
  input: [event: SessionInputEvent];
  terminalVisibleLines: [request: TerminalVisibleLinesRequest];
}

export type PtySpawner = (
  file: string,
  args: string[] | string,
  options: IPtyForkOptions,
) => IPty;

export interface SessionWorkspace {
  projectId: string | null;
  cwd: string;
}

function stringEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function restoredTerminalMessage(record: SessionRecord): string {
  const stateMessage =
    record.status === "interrupted"
      ? "客户端上次关闭时，这个会话仍在运行。原进程已经结束。"
      : "这是上次保留的会话标签，终端内容不会写入本地配置。";
  const resumeMessage = record.claudeSessionId
    ? "已绑定 Claude Code 会话；点击“重启会话”会自动恢复这段对话。"
    : "尚未绑定 Claude Code 会话；重启会启动新的 Claude Code 会话，不会自动选择历史对话。需要恢复旧对话时，请使用 /resume 手动选择。";
  return (
    `\r\n\x1b[38;2;217;119;87mClaude Workspace\x1b[0m\r\n\r\n` +
    `  ${stateMessage}\r\n` +
    `  ${resumeMessage}\r\n`
  );
}

type RestartKind = "resume" | "unbound" | "transcript-missing";

function restartingTerminalMessage(kind: RestartKind): string {
  const header = "\r\n\x1b[38;2;217;119;87mClaude Workspace\x1b[0m\r\n\r\n";
  switch (kind) {
    case "resume":
      return (
        header +
        "  正在原工作目录重新启动 Claude Code，并恢复已绑定的对话…\r\n" +
        "  Claude Code 会使用已保存的会话 ID。\r\n\r\n"
      );
    case "transcript-missing":
      return (
        header +
        "  正在原工作目录重新启动 Claude Code，并启动新的会话…\r\n" +
        "  原来绑定的对话记录已不存在：可能还没有发送过消息，或已超过 Claude Code 的保留期被自动清理。\r\n\r\n"
      );
    case "unbound":
      return (
        header +
        "  正在原工作目录重新启动 Claude Code，并启动新的会话…\r\n" +
        "  旧记录没有绑定 ID，Claude Code 不会自动选择当前目录中的历史对话；需要恢复时请在终端执行 /resume。\r\n\r\n"
      );
  }
}

const RESUME_NOT_FOUND_TERMINAL_MESSAGE =
  "\r\n\x1b[38;2;217;119;87mClaude Workspace\x1b[0m\r\n\r\n" +
  "  Claude Code 找不到原来绑定的对话记录（可能还没有发送过消息，或已超过保留期被自动清理）。\r\n" +
  "  点击“重启会话”会在原工作目录启动新的对话。\r\n";

export function describeClaudeSpawnError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const errorCode =
    typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : "";
  const isBadExecutableFormat =
    errorCode === "193" ||
    /error code:\s*193|not a valid win32 application|exec format error/iu.test(
      message,
    );

  if (isBadExecutableFormat) {
    return (
      "选中的文件不是可运行的 Windows Claude Code CLI（Windows 错误 193）。" +
      "请勿选择 Claude Desktop、WindowsApps 中的 Claude.exe 或 WSL/Linux 版 claude；" +
      "请重新自动检测，或选择 %USERPROFILE%\\.local\\bin\\claude.exe。"
    );
  }
  return message;
}

export class SessionManager extends EventEmitter<SessionManagerEvents> {
  private readonly sessions = new Map<string, ManagedSession>();
  /**
   * Rows currently visible in each renderer xterm. The PTY buffer contains
   * control sequences and cannot reliably reconstruct Claude Code's menu.
   */
  private readonly visibleTerminalLines = new Map<
    string,
    TerminalVisibleLinesRequest
  >();
  /**
   * PTY input is serialized per session. A paste may take a few milliseconds
   * per chunk, and a later keystroke or remote reply must not overtake it.
   */
  private readonly inputQueues = new Map<string, InputQueue>();
  private readonly terminateTree: SessionProcessTreeTerminator;

  constructor(
    private readonly getClaudeExecutable: () => string,
    private readonly ptySpawner: PtySpawner = spawnPty,
    private readonly platform: NodeJS.Platform = process.platform,
    initialSessions: SessionRecord[] = [],
    private readonly getLaunchOptions?: ClaudeSessionLaunchOptionsProvider,
    terminateTree?: SessionProcessTreeTerminator,
    /**
     * Looks up Claude's transcript before `--resume`. The default reports
     * "unknown" so callers that do not opt in keep resuming as before; the
     * application passes the real file-system lookup.
     */
    private readonly findTranscript: (
      claudeSessionId: string,
    ) => ClaudeTranscriptLookup = () => "unknown",
  ) {
    super();
    this.terminateTree =
      terminateTree ??
      (platform === "win32"
        ? (pid) => terminateProcessTree(pid, { platform })
        : async () => undefined);
    for (const initial of initialSessions) {
      if (this.sessions.has(initial.id)) {
        continue;
      }
      const record: SessionRecord = {
        ...initial,
        status:
          initial.status === "running" || initial.status === "starting"
            ? "interrupted"
            : initial.status,
      };
      this.sessions.set(record.id, {
        record,
        process: null,
        launchId: null,
        terminal: new TerminalBuffer(
          MAX_TERMINAL_BUFFER_LENGTH,
          restoredTerminalMessage(record),
        ),
        sequence: 0,
      });
    }
  }

  listSessions(): SessionRecord[] {
    return [...this.sessions.values()]
      .map(({ record }) => ({ ...record }))
      .sort((left, right) => left.createdAt - right.createdAt);
  }

  createSession(
    workspace: SessionWorkspace,
    requestedTitle?: string,
    skipPermissions = false,
  ): SessionRecord {
    const executablePath = this.getClaudeExecutable();
    const workspaceSessions = this.listSessions().filter(
      (session) => session.projectId === workspace.projectId,
    );
    const title = requestedTitle?.trim() || nextSessionTitle(workspaceSessions);
    const sessionId = randomUUID();
    const record: SessionRecord = {
      id: sessionId,
      projectId: workspace.projectId,
      title,
      cwd: workspace.cwd,
      status: "starting",
      createdAt: Date.now(),
      // Allocate Claude's ID before starting the process. This makes the
      // workbench-to-Claude mapping durable even when the SessionStart Hook is
      // unavailable or the client is closed immediately after launch.
      claudeSessionId: randomUUID(),
      ...(skipPermissions === true ? { skipPermissions: true } : {}),
    };

    const launchId = randomUUID();
    try {
      const launchOptions = this.getLaunchOptions?.(sessionId, launchId);
      const launch = createClaudeLaunchSpec(
        executablePath,
        this.claudeArguments(record, launchOptions?.args ?? [], "new"),
        {
          platform: this.platform,
          env: { ...process.env, ...launchOptions?.env },
        },
      );
      const processHandle = this.spawnProcess(workspace.cwd, launch);
      const managed: ManagedSession = {
        record,
        process: processHandle,
        launchId,
        terminal: new TerminalBuffer(MAX_TERMINAL_BUFFER_LENGTH),
        sequence: 0,
      };
      this.sessions.set(sessionId, managed);

      this.attachProcess(sessionId, managed, processHandle);

      managed.record.status = "running";
      this.emitChanged(managed.record);
      return { ...managed.record };
    } catch (error) {
      delete record.claudeSessionId;
      record.status = "failed";
      record.error = describeClaudeSpawnError(error);
      const managed: ManagedSession = {
        record,
        process: null,
        launchId: null,
        terminal: new TerminalBuffer(
          MAX_TERMINAL_BUFFER_LENGTH,
          restoredTerminalMessage(record),
        ),
        sequence: 0,
      };
      this.sessions.set(sessionId, managed);
      this.emitChanged(record);
      throw new Error(`无法启动 Claude Code：${record.error}`);
    }
  }

  restartSession(sessionId: string): SessionRecord {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error("会话不存在或已经被移除。");
    }
    if (
      session.record.status === "running" ||
      session.record.status === "starting"
    ) {
      throw new Error("会话仍在运行，不能重启。");
    }

    this.cancelQueuedInput(sessionId);
    this.visibleTerminalLines.delete(sessionId);
    session.process = null;
    session.launchId = null;
    session.record.status = "starting";
    delete session.record.exitCode;
    delete session.record.error;
    const previousClaudeSessionId = session.record.claudeSessionId;
    // `--resume <id>` exits immediately with "No conversation found" when
    // Claude has no transcript for the ID: the session never received a
    // message, or Claude removed it after its retention period. Restarting
    // would then fail forever, so start a new Claude session instead.
    const transcriptMissing =
      previousClaudeSessionId !== undefined &&
      (session.forceNewOnRestart === true ||
        this.findTranscript(previousClaudeSessionId) === "missing");
    const resumeClaudeSessionId = transcriptMissing
      ? undefined
      : previousClaudeSessionId;
    this.appendTerminalData(
      session,
      restartingTerminalMessage(
        resumeClaudeSessionId
          ? "resume"
          : transcriptMissing
            ? "transcript-missing"
            : "unbound",
      ),
    );
    if (!resumeClaudeSessionId) {
      // Never let an unbound legacy record fall back to --continue: that
      // selects the newest conversation in the directory and can make
      // multiple workbench records point at the same Claude session. Start a
      // fresh Claude session instead; /resume can bind the intended history.
      session.record.claudeSessionId = randomUUID();
    }
    this.emitChanged(session.record);

    try {
      const executablePath = this.getClaudeExecutable();
      const launchId = randomUUID();
      const launchOptions = this.getLaunchOptions?.(sessionId, launchId);
      const launch = createClaudeLaunchSpec(
        executablePath,
        this.claudeArguments(
          session.record,
          launchOptions?.args ?? [],
          resumeClaudeSessionId ? "resume" : "new",
        ),
        {
          platform: this.platform,
          env: { ...process.env, ...launchOptions?.env },
        },
      );
      const processHandle = this.spawnProcess(session.record.cwd, launch);
      session.launchId = launchId;
      this.resetResumeProbe(session, resumeClaudeSessionId ? "resume" : "new");
      session.forceNewOnRestart = false;
      this.attachProcess(sessionId, session, processHandle);
      session.record.status = "running";
      this.emitChanged(session.record);
      return { ...session.record };
    } catch (error) {
      session.process = null;
      session.launchId = null;
      if (!resumeClaudeSessionId) {
        // Keep the record exactly as it was before this failed attempt.
        if (previousClaudeSessionId) {
          session.record.claudeSessionId = previousClaudeSessionId;
        } else {
          delete session.record.claudeSessionId;
        }
      }
      session.record.status = "failed";
      session.record.error = describeClaudeSpawnError(error);
      this.emitChanged(session.record);
      throw new Error(`无法重新启动 Claude Code：${session.record.error}`);
    }
  }

  renameSession(sessionId: string, requestedTitle: string): SessionRecord {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error("会话不存在或已经关闭。");
    }

    const title = requestedTitle.trim();
    if (!title) {
      throw new Error("会话名称不能为空。");
    }
    if ([...title].length > 80) {
      throw new Error("会话名称不能超过 80 个字符。");
    }
    if (/\p{Cc}/u.test(title)) {
      throw new Error("会话名称不能包含控制字符。");
    }

    if (session.record.title !== title) {
      session.record.title = title;
      this.emitChanged(session.record);
    }
    return { ...session.record };
  }

  write(sessionId: string, data: string): void {
    this.validateTerminalInput(data);
    const processHandle = this.runningProcess(sessionId);
    if (!processHandle) {
      return;
    }

    // xterm emits bracketed-paste markers when Claude Code enables paste mode.
    // For terminals without that mode, the size check in
    // shouldThrottleTerminalInput is a conservative fallback. In either case
    // the payload is queued so a user's next keystroke cannot be interleaved.
    if (shouldThrottleTerminalInput(data) || this.hasQueuedInput(sessionId)) {
      void this.enqueueInput(sessionId, () =>
        shouldThrottleTerminalInput(data)
          ? this.writePastedInput(
              sessionId,
              processHandle,
              data,
              "local",
            )
          : this.writeInput(sessionId, data, "local", processHandle),
      ).catch(() => undefined);
      return;
    }

    this.writeInput(sessionId, data, "local", processHandle);
  }

  writeRemoteReply(sessionId: string, data: string): boolean {
    this.validateTerminalInput(data);
    const processHandle = this.runningProcess(sessionId);
    if (!processHandle) {
      return false;
    }
    if (this.hasQueuedInput(sessionId)) {
      // This method is intentionally synchronous for the WeCom bridge API.
      // Report that the live process accepted the request, then put it behind
      // any in-flight paste; the expected process guard prevents stale input
      // from being written after a restart.
      void this.enqueueInput(sessionId, () =>
        this.writeInput(sessionId, data, "remote", processHandle),
      ).catch(() => undefined);
      return true;
    }
    return this.writeInput(sessionId, data, "remote", processHandle);
  }

  async writeRemoteReplySequence(
    sessionId: string,
    chunks: string[],
  ): Promise<boolean> {
    if (!Array.isArray(chunks) || chunks.length === 0) {
      return false;
    }
    if (chunks.some((chunk) => typeof chunk !== "string")) {
      throw new Error("Terminal input chunks must be strings.");
    }
    const totalLength = chunks.reduce((total, chunk) => total + chunk.length, 0);
    if (totalLength > 100_000) {
      throw new Error("Terminal input is too large.");
    }
    const processHandle = this.runningProcess(sessionId);
    if (!processHandle) {
      return false;
    }
    const inputChunks = [...chunks];
    return this.enqueueInput(sessionId, () =>
      this.writeInputSequence(
        sessionId,
        processHandle,
        inputChunks,
        "remote",
        REMOTE_INPUT_KEY_DELAY_MS,
      ),
    );
  }

  isCurrentLaunch(sessionId: string, launchId: string): boolean {
    const session = this.sessions.get(sessionId);
    return (
      session?.record.status === "running" && session.launchId === launchId
    );
  }

  /**
   * Bind Claude Code's durable conversation ID to the current workbench
   * launch. SessionStart is delivered by the per-process Hook configuration;
   * the launch guard prevents a stale process from overwriting a restarted
   * session's ID.
   */
  bindClaudeSessionId(
    sessionId: string,
    launchId: string,
    claudeSessionId: string,
  ): boolean {
    if (
      typeof claudeSessionId !== "string" ||
      claudeSessionId.length === 0 ||
      claudeSessionId.length > 200
    ) {
      return false;
    }
    const session = this.sessions.get(sessionId);
    if (
      !session ||
      session.record.status !== "running" ||
      session.launchId !== launchId
    ) {
      return false;
    }
    if (session.record.claudeSessionId === claudeSessionId) {
      return true;
    }
    session.record.claudeSessionId = claudeSessionId;
    this.emitChanged(session.record);
    return true;
  }

  private writeInput(
    sessionId: string,
    data: string,
    source: SessionInputEvent["source"],
    expectedProcess?: IPty,
  ): boolean {
    this.validateTerminalInput(data);
    const session = this.sessions.get(sessionId);
    if (!session || session.record.status !== "running") {
      return false;
    }
    if (!session.process) {
      return false;
    }
    if (expectedProcess && session.process !== expectedProcess) {
      return false;
    }
    session.process.write(data);
    this.emit("input", { sessionId, source, data });
    return true;
  }

  private validateTerminalInput(data: string): void {
    if (typeof data !== "string") {
      throw new Error("Terminal data must be a string.");
    }
    if (data.length > 100_000) {
      throw new Error("Terminal input is too large.");
    }
  }

  private runningProcess(sessionId: string): IPty | null {
    const session = this.sessions.get(sessionId);
    if (!session || session.record.status !== "running" || !session.process) {
      return null;
    }
    return session.process;
  }

  private hasQueuedInput(sessionId: string): boolean {
    const queue = this.inputQueues.get(sessionId);
    return Boolean(
      queue &&
        !queue.cancelled &&
        (queue.running || queue.items.length > 0),
    );
  }

  /** Add one input operation to the session's FIFO and start its drain loop. */
  private enqueueInput(
    sessionId: string,
    run: () => boolean | Promise<boolean>,
  ): Promise<boolean> {
    let queue = this.inputQueues.get(sessionId);
    if (!queue || queue.cancelled) {
      queue = { items: [], running: false, cancelled: false };
      this.inputQueues.set(sessionId, queue);
    }

    const queued = queue;
    const result = new Promise<boolean>((resolve, reject) => {
      queued.items.push({ run, resolve, reject });
    });
    if (!queued.running) {
      queued.running = true;
      void this.drainInputQueue(sessionId, queued);
    }
    return result;
  }

  private async drainInputQueue(
    sessionId: string,
    queue: InputQueue,
  ): Promise<void> {
    while (!queue.cancelled && queue.items.length > 0) {
      const item = queue.items.shift();
      if (!item) {
        continue;
      }
      try {
        item.resolve(await item.run());
      } catch (error) {
        item.reject(error);
      }
    }

    // Requests that were waiting when a process was removed/restarted should
    // resolve as rejected writes rather than remain pending forever.
    if (queue.cancelled) {
      for (const item of queue.items.splice(0)) {
        item.resolve(false);
      }
    }
    queue.running = false;
    if (this.inputQueues.get(sessionId) === queue) {
      this.inputQueues.delete(sessionId);
    }
  }

  private cancelQueuedInput(sessionId: string): void {
    const queue = this.inputQueues.get(sessionId);
    if (!queue) {
      return;
    }
    queue.cancelled = true;
    for (const item of queue.items.splice(0)) {
      item.resolve(false);
    }
    this.inputQueues.delete(sessionId);
  }

  private writePastedInput(
    sessionId: string,
    expectedProcess: IPty,
    data: string,
    source: SessionInputEvent["source"],
  ): Promise<boolean> {
    const chunks = splitTerminalPaste(data);
    return this.writeInputSequence(
      sessionId,
      expectedProcess,
      chunks,
      source,
      TERMINAL_PASTE_CHUNK_DELAY_MS,
    );
  }

  private async writeInputSequence(
    sessionId: string,
    expectedProcess: IPty,
    chunks: string[],
    source: SessionInputEvent["source"],
    delayMs: number,
  ): Promise<boolean> {
    if (chunks.length === 0) {
      return false;
    }
    for (let index = 0; index < chunks.length; index += 1) {
      if (!this.writeInput(sessionId, chunks[index], source, expectedProcess)) {
        return false;
      }
      if (index < chunks.length - 1 && delayMs > 0) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, delayMs);
        });
      }
    }
    return true;
  }

  resize(sessionId: string, columns: number, rows: number): void {
    if (!Number.isInteger(columns) || !Number.isInteger(rows)) {
      throw new Error("Terminal dimensions must be integers.");
    }
    const session = this.sessions.get(sessionId);
    if (!session || session.record.status !== "running") {
      return;
    }
    session.process?.resize(
      Math.min(Math.max(columns, 20), 500),
      Math.min(Math.max(rows, 5), 200),
    );
  }

  stop(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (
      !session ||
      (session.record.status !== "running" &&
        session.record.status !== "starting")
    ) {
      return;
    }
    this.cancelQueuedInput(sessionId);
    if (session.process) {
      void this.terminateSessionProcess(session.process);
    }
  }

  removeSession(sessionId: string): SessionRecord {
    const { record, terminated } = this.detachSession(sessionId);
    void terminated;
    return record;
  }

  /**
   * Remove a session and wait until its process has exited. A temporary
   * workspace can only be deleted once nothing uses it as its working
   * directory; on Windows a running process keeps the directory locked.
   */
  async removeSessionAndWait(sessionId: string): Promise<SessionRecord> {
    const { record, terminated } = this.detachSession(sessionId);
    await terminated;
    return record;
  }

  private detachSession(sessionId: string): {
    record: SessionRecord;
    terminated: Promise<void>;
  } {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error("会话不存在或已经被移除。");
    }
    let terminated: Promise<void> = Promise.resolve();
    if (
      (session.record.status === "running" ||
        session.record.status === "starting") &&
      session.process
    ) {
      const processHandle = session.process;
      const exited = waitForPtyExit(processHandle, PROCESS_EXIT_WAIT_MS);
      terminated = this.terminateSessionProcess(processHandle).then(() => exited);
    }
    this.cancelQueuedInput(sessionId);
    this.sessions.delete(sessionId);
    this.visibleTerminalLines.delete(sessionId);
    return { record: { ...session.record }, terminated };
  }

  removeProjectSessions(projectId: string): void {
    for (const session of [...this.sessions.values()]) {
      if (session.record.projectId === projectId) {
        this.stop(session.record.id);
        this.cancelQueuedInput(session.record.id);
        this.sessions.delete(session.record.id);
        this.visibleTerminalLines.delete(session.record.id);
      }
    }
  }

  hasRunningSessions(): boolean {
    return [...this.sessions.values()].some(
      (session) =>
        session.record.status === "running" ||
        session.record.status === "starting",
    );
  }

  /** Recent PTY output for diagnostics and legacy compatibility callers. */
  getTerminalTail(sessionId: string, length: number): string {
    const session = this.sessions.get(sessionId);
    return session ? session.terminal.tail(length) : "";
  }

  setTerminalVisibleLines(request: TerminalVisibleLinesRequest): void {
    const session = this.sessions.get(request.sessionId);
    if (
      !session ||
      request.sequence > session.sequence ||
      !Number.isSafeInteger(request.sequence) ||
      request.sequence < 0
    ) {
      return;
    }
    const previous = this.visibleTerminalLines.get(request.sessionId);
    if (previous && request.sequence < previous.sequence) {
      return;
    }
    const normalized: TerminalVisibleLinesRequest = {
      sessionId: request.sessionId,
      sequence: request.sequence,
      lines: request.lines.map((line) => line.trimEnd()),
      viewportY: request.viewportY,
      rows: request.rows,
      columns: request.columns,
    };
    this.visibleTerminalLines.set(request.sessionId, {
      ...normalized,
      lines: [...normalized.lines],
    });
    this.emit("terminalVisibleLines", {
      ...normalized,
      lines: [...normalized.lines],
    });
  }

  /** Sequence number of the latest PTY output, without joining the buffer. */
  getTerminalSequence(sessionId: string): number {
    return this.sessions.get(sessionId)?.sequence ?? 0;
  }

  getTerminalVisibleLines(
    sessionId: string,
  ): TerminalVisibleLinesRequest | undefined {
    const snapshot = this.visibleTerminalLines.get(sessionId);
    return snapshot
      ? { ...snapshot, lines: [...snapshot.lines] }
      : undefined;
  }

  /** Wait briefly for xterm to render rows for the current PTY sequence. */
  waitForTerminalVisibleLines(
    sessionId: string,
    minimumSequence: number,
    timeoutMs: number,
    accept: (request: TerminalVisibleLinesRequest) => boolean = () => true,
  ): Promise<TerminalVisibleLinesRequest | null> {
    const current = this.getTerminalVisibleLines(sessionId);
    if (current && current.sequence >= minimumSequence && accept(current)) {
      return Promise.resolve(current);
    }
    return new Promise((resolve) => {
      let settled = false;
      const finish = (request: TerminalVisibleLinesRequest | null) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        this.off("terminalVisibleLines", onReport);
        resolve(request);
      };
      const onReport = (request: TerminalVisibleLinesRequest) => {
        if (
          request.sessionId === sessionId &&
          request.sequence >= minimumSequence &&
          accept(request)
        ) {
          finish(request);
        }
      };
      const timer = setTimeout(() => finish(null), Math.max(0, timeoutMs));
      timer.unref?.();
      this.on("terminalVisibleLines", onReport);
    });
  }

  getTerminalSnapshot(sessionId: string): TerminalSnapshot {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error("Session does not exist.");
    }
    return {
      data: session.terminal.toString(),
      lastSequence: session.sequence,
    };
  }

  async dispose(): Promise<void> {
    const terminations: Promise<void>[] = [];
    for (const session of this.sessions.values()) {
      this.cancelQueuedInput(session.record.id);
      if (
        (session.record.status === "running" ||
          session.record.status === "starting") &&
        session.process
      ) {
        terminations.push(this.terminateSessionProcess(session.process));
      }
    }
    await Promise.allSettled(terminations);
  }

  private async terminateSessionProcess(processHandle: IPty): Promise<void> {
    const pid = Number(processHandle.pid);
    if (this.platform !== "win32") {
      try {
        processHandle.kill();
      } catch {
        // The PTY may have exited already.
      }
      return;
    }
    // On Windows taskkill must see the wrapper before the direct handle is
    // closed, otherwise its Claude descendant can become orphaned.
    if (Number.isInteger(pid) && pid > 0) {
      await this.terminateTree(pid).catch(() => undefined);
    }
    try {
      processHandle.kill();
    } catch {
      // The PTY may have exited while the tree termination command was running.
    }
  }

  private spawnProcess(
    cwd: string,
    launch: ReturnType<typeof createClaudeLaunchSpec>,
  ): IPty {
    return this.ptySpawner(launch.executable, launch.args, {
      name: "xterm-256color",
      cols: 120,
      rows: 36,
      cwd,
      env: stringEnvironment(launch.env),
    });
  }

  private claudeArguments(
    record: SessionRecord,
    launchArgs: string[],
    mode: ClaudeSessionLaunchMode,
  ): string[] {
    if (!record.claudeSessionId) {
      throw new Error("Claude Code 会话 ID 尚未生成。");
    }
    const sessionArguments =
      mode === "resume"
        ? ["--resume", record.claudeSessionId as string]
        : ["--session-id", record.claudeSessionId as string];
    return [
      ...launchArgs,
      ...sessionArguments,
      ...(record.skipPermissions === true
        ? ["--dangerously-skip-permissions"]
        : []),
    ];
  }

  private attachProcess(
    sessionId: string,
    session: ManagedSession,
    processHandle: IPty,
  ): void {
    session.process = processHandle;
    processHandle.onData((data) =>
      this.handleData(sessionId, processHandle, data),
    );
    processHandle.onExit(({ exitCode }) =>
      this.handleExit(sessionId, processHandle, exitCode),
    );
  }

  private handleData(
    sessionId: string,
    processHandle: IPty,
    data: string,
  ): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.process !== processHandle) {
      return;
    }
    this.probeResumeOutput(session, data);
    this.appendTerminalData(session, data);
  }

  private resetResumeProbe(
    session: ManagedSession,
    launchMode: ClaudeSessionLaunchMode,
  ): void {
    session.launchMode = launchMode;
    session.launchStartedAt = Date.now();
    session.resumeProbe = "";
    session.resumeProbeLength = 0;
    session.resumeNotFound = false;
  }

  /**
   * Watch the first output of a `--resume` launch for Claude's "No
   * conversation found" error. A transcript file can exist without any
   * resumable message, so the pre-launch lookup alone is not sufficient.
   */
  private probeResumeOutput(session: ManagedSession, data: string): void {
    if (
      session.launchMode !== "resume" ||
      session.resumeNotFound ||
      (session.resumeProbeLength ?? 0) >= RESUME_PROBE_MAX_OUTPUT_LENGTH
    ) {
      return;
    }
    session.resumeProbeLength = (session.resumeProbeLength ?? 0) + data.length;
    session.resumeProbe = `${session.resumeProbe ?? ""}${stripAnsi(data)}`.slice(
      -RESUME_PROBE_WINDOW_LENGTH,
    );
    if (CLAUDE_RESUME_NOT_FOUND_PATTERN.test(session.resumeProbe)) {
      session.resumeNotFound = true;
    }
  }

  private appendTerminalData(session: ManagedSession, data: string): void {
    session.sequence += 1;
    session.terminal.append(data);
    this.emit("data", {
      sessionId: session.record.id,
      data,
      sequence: session.sequence,
    });
  }

  private handleExit(
    sessionId: string,
    processHandle: IPty,
    exitCode: number,
  ): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.process !== processHandle) {
      return;
    }
    this.cancelQueuedInput(sessionId);
    this.visibleTerminalLines.delete(sessionId);
    session.process = null;
    session.launchId = null;
    session.record.status = "exited";
    session.record.exitCode = exitCode;
    if (
      session.resumeNotFound &&
      exitCode !== 0 &&
      Date.now() - (session.launchStartedAt ?? 0) <= RESUME_FAILURE_EXIT_WINDOW_MS
    ) {
      session.forceNewOnRestart = true;
      this.appendTerminalData(session, RESUME_NOT_FOUND_TERMINAL_MESSAGE);
    }
    session.launchMode = undefined;
    session.launchStartedAt = undefined;
    session.resumeProbe = undefined;
    session.resumeProbeLength = undefined;
    session.resumeNotFound = undefined;
    this.emitChanged(session.record);
  }

  private emitChanged(record: SessionRecord): void {
    this.emit("changed", { ...record });
  }
}
