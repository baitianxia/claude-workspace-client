import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { IPty, IPtyForkOptions } from "node-pty";
import { spawn as spawnPty } from "node-pty";
import type {
  SessionRecord,
  TerminalDataEvent,
  TerminalSnapshot,
} from "../shared/contracts";
import {
  TERMINAL_PASTE_CHUNK_DELAY_MS,
  shouldThrottleTerminalInput,
  splitTerminalPaste,
} from "../shared/terminal-paste";
import { createClaudeLaunchSpec } from "./claude-executable";
import { terminateProcessTree } from "./process-tree";
import { nextSessionTitle } from "./session-title";

const MAX_TERMINAL_BUFFER_LENGTH = 2_000_000;
// Claude Code's Ink picker reads one keypress per PTY write. A short gap keeps
// consecutive arrow/Enter events distinct on Windows ConPTY and Unix PTYs.
const REMOTE_INPUT_KEY_DELAY_MS = 35;

interface ManagedSession {
  record: SessionRecord;
  process: IPty | null;
  launchId: string | null;
  terminalBuffer: string;
  sequence: number;
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

export type SessionProcessTreeTerminator = (pid: number) => Promise<void>;

export interface SessionManagerEvents {
  data: [event: TerminalDataEvent];
  changed: [session: SessionRecord];
  input: [event: SessionInputEvent];
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
  return (
    `\r\n\x1b[38;2;217;119;87mClaude Workspace\x1b[0m\r\n\r\n` +
    `  ${stateMessage}\r\n` +
    "  新建 Claude Code 会话后，可使用 /resume 恢复 Claude Code 自身保存的对话。\r\n"
  );
}

function restartingTerminalMessage(): string {
  return (
    "\r\n\x1b[38;2;217;119;87mClaude Workspace\x1b[0m\r\n\r\n" +
    "  正在原工作目录重新启动 Claude Code…\r\n" +
    "  如需恢复之前的 Claude Code 对话，请使用 /resume。\r\n\r\n"
  );
}

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
        terminalBuffer: restoredTerminalMessage(record),
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
    };

    const launchId = randomUUID();
    try {
      const launchOptions = this.getLaunchOptions?.(sessionId, launchId);
      const launch = createClaudeLaunchSpec(
        executablePath,
        launchOptions?.args ?? [],
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
        terminalBuffer: "",
        sequence: 0,
      };
      this.sessions.set(sessionId, managed);

      this.attachProcess(sessionId, managed, processHandle);

      managed.record.status = "running";
      this.emitChanged(managed.record);
      return { ...managed.record };
    } catch (error) {
      record.status = "failed";
      record.error = describeClaudeSpawnError(error);
      const managed: ManagedSession = {
        record,
        process: null,
        launchId: null,
        terminalBuffer: restoredTerminalMessage(record),
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
    session.process = null;
    session.launchId = null;
    session.record.status = "starting";
    delete session.record.exitCode;
    delete session.record.error;
    this.appendTerminalData(session, restartingTerminalMessage());
    this.emitChanged(session.record);

    try {
      const executablePath = this.getClaudeExecutable();
      const launchId = randomUUID();
      const launchOptions = this.getLaunchOptions?.(sessionId, launchId);
      const launch = createClaudeLaunchSpec(
        executablePath,
        launchOptions?.args ?? [],
        {
          platform: this.platform,
          env: { ...process.env, ...launchOptions?.env },
        },
      );
      const processHandle = this.spawnProcess(session.record.cwd, launch);
      session.launchId = launchId;
      this.attachProcess(sessionId, session, processHandle);
      session.record.status = "running";
      this.emitChanged(session.record);
      return { ...session.record };
    } catch (error) {
      session.process = null;
      session.launchId = null;
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
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error("会话不存在或已经被移除。");
    }
    if (
      session.record.status === "running" ||
      session.record.status === "starting"
    ) {
      if (session.process) {
        void this.terminateSessionProcess(session.process);
      }
    }
    this.cancelQueuedInput(sessionId);
    this.sessions.delete(sessionId);
    return { ...session.record };
  }

  removeProjectSessions(projectId: string): void {
    for (const session of [...this.sessions.values()]) {
      if (session.record.projectId === projectId) {
        this.stop(session.record.id);
        this.cancelQueuedInput(session.record.id);
        this.sessions.delete(session.record.id);
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

  getTerminalSnapshot(sessionId: string): TerminalSnapshot {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error("Session does not exist.");
    }
    return {
      data: session.terminalBuffer,
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
    this.appendTerminalData(session, data);
  }

  private appendTerminalData(session: ManagedSession, data: string): void {
    session.sequence += 1;
    session.terminalBuffer = `${session.terminalBuffer}${data}`;
    if (session.terminalBuffer.length > MAX_TERMINAL_BUFFER_LENGTH) {
      session.terminalBuffer = session.terminalBuffer.slice(
        session.terminalBuffer.length - MAX_TERMINAL_BUFFER_LENGTH,
      );
    }
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
    session.process = null;
    session.launchId = null;
    session.record.status = "exited";
    session.record.exitCode = exitCode;
    this.emitChanged(session.record);
  }

  private emitChanged(record: SessionRecord): void {
    this.emit("changed", { ...record });
  }
}
