import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { IPty, IPtyForkOptions } from "node-pty";
import { spawn as spawnPty } from "node-pty";
import type {
  SessionRecord,
  TerminalDataEvent,
  TerminalSnapshot,
} from "../shared/contracts";
import { createClaudeLaunchSpec } from "./claude-executable";
import { nextSessionTitle } from "./session-title";

const MAX_TERMINAL_BUFFER_LENGTH = 2_000_000;

interface ManagedSession {
  record: SessionRecord;
  process: IPty | null;
  terminalBuffer: string;
  sequence: number;
}

export interface SessionManagerEvents {
  data: [event: TerminalDataEvent];
  changed: [session: SessionRecord];
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

  constructor(
    private readonly getClaudeExecutable: () => string,
    private readonly ptySpawner: PtySpawner = spawnPty,
    private readonly platform: NodeJS.Platform = process.platform,
    initialSessions: SessionRecord[] = [],
  ) {
    super();
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

    const launch = createClaudeLaunchSpec(executablePath, [], {
      platform: this.platform,
      env: process.env,
    });

    try {
      const processHandle = this.ptySpawner(launch.executable, launch.args, {
        name: "xterm-256color",
        cols: 120,
        rows: 36,
        cwd: workspace.cwd,
        env: stringEnvironment(launch.env),
      });
      const managed: ManagedSession = {
        record,
        process: processHandle,
        terminalBuffer: "",
        sequence: 0,
      };
      this.sessions.set(sessionId, managed);

      processHandle.onData((data) => this.handleData(sessionId, data));
      processHandle.onExit(({ exitCode }) => this.handleExit(sessionId, exitCode));

      managed.record.status = "running";
      this.emitChanged(managed.record);
      return { ...managed.record };
    } catch (error) {
      record.status = "failed";
      record.error = describeClaudeSpawnError(error);
      const managed: ManagedSession = {
        record,
        process: null,
        terminalBuffer: restoredTerminalMessage(record),
        sequence: 0,
      };
      this.sessions.set(sessionId, managed);
      this.emitChanged(record);
      throw new Error(`无法启动 Claude Code：${record.error}`);
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
    if (data.length > 100_000) {
      throw new Error("Terminal input is too large.");
    }
    const session = this.sessions.get(sessionId);
    if (!session || session.record.status !== "running") {
      return;
    }
    session.process?.write(data);
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
    if (!session || session.record.status !== "running") {
      return;
    }
    session.process?.kill();
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
      session.process?.kill();
    }
    this.sessions.delete(sessionId);
    return { ...session.record };
  }

  removeProjectSessions(projectId: string): void {
    for (const session of [...this.sessions.values()]) {
      if (session.record.projectId === projectId) {
        this.stop(session.record.id);
        this.sessions.delete(session.record.id);
      }
    }
  }

  hasRunningSessions(): boolean {
    return [...this.sessions.values()].some(
      (session) => session.record.status === "running",
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

  dispose(): void {
    for (const session of this.sessions.values()) {
      if (session.record.status === "running") {
        session.process?.kill();
      }
    }
  }

  private handleData(sessionId: string, data: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }
    session.sequence += 1;
    session.terminalBuffer = `${session.terminalBuffer}${data}`;
    if (session.terminalBuffer.length > MAX_TERMINAL_BUFFER_LENGTH) {
      session.terminalBuffer = session.terminalBuffer.slice(
        session.terminalBuffer.length - MAX_TERMINAL_BUFFER_LENGTH,
      );
    }
    this.emit("data", {
      sessionId,
      data,
      sequence: session.sequence,
    });
  }

  private handleExit(sessionId: string, exitCode: number): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }
    session.record.status = "exited";
    session.record.exitCode = exitCode;
    this.emitChanged(session.record);
  }

  private emitChanged(record: SessionRecord): void {
    this.emit("changed", { ...record });
  }
}
