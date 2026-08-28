import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { createConnection, type Socket } from "node:net";
import type {
  SessionRecord,
  TerminalDataEvent,
  TerminalSnapshot,
} from "../../shared/contracts";
import type { ClaudeHookEvent } from "../claude-hook-server";
import type {
  SessionInputEvent,
  SessionRuntime,
  SessionRuntimeEvents,
  SessionWorkspace,
} from "../session-runtime";
import { JsonLinePeer } from "./json-line-peer";
import {
  SESSION_HOST_PROTOCOL_VERSION,
  type SessionHostClientMessage,
  type SessionHostRequestMethod,
  type SessionHostServerMessage,
  type SessionHostSnapshot,
} from "./protocol";
import { normalizeSessionRecord } from "./state-store";

const DEFAULT_CONNECT_TIMEOUT_MS = 3_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const MAX_PENDING_REQUESTS = 2_048;
const MAX_QUEUED_HOOKS = 256;

interface SessionHostClientEvents extends SessionRuntimeEvents {
  claudeHook: [event: ClaudeHookEvent];
  disconnected: [error?: Error];
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

interface HelloResult {
  runtimeVersion: string;
  hostPid: number;
}

function readableError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value as Record<string, unknown>;
}

function parseSession(value: unknown): SessionRecord {
  const session = normalizeSessionRecord(value);
  if (!session) {
    throw new Error("Session Host returned an invalid session.");
  }
  return session;
}

function parseSnapshot(value: unknown): SessionHostSnapshot {
  const candidate = requireObject(value, "Session Host snapshot");
  if (!Array.isArray(candidate.sessions)) {
    throw new Error("Session Host returned an invalid session list.");
  }
  const sessions = candidate.sessions.map(parseSession);
  const rawLaunchIds = requireObject(
    candidate.launchIds,
    "Session Host launch map",
  );
  const launchIds: Record<string, string> = {};
  for (const [sessionId, launchId] of Object.entries(rawLaunchIds)) {
    if (
      !sessions.some((session) => session.id === sessionId) ||
      typeof launchId !== "string" ||
      !launchId ||
      launchId.length > 200
    ) {
      throw new Error("Session Host returned an invalid launch map.");
    }
    launchIds[sessionId] = launchId;
  }
  if (
    candidate.hookAvailabilityError !== undefined &&
    typeof candidate.hookAvailabilityError !== "string"
  ) {
    throw new Error("Session Host returned an invalid Hook status.");
  }
  return {
    sessions,
    launchIds,
    ...(candidate.hookAvailabilityError
      ? { hookAvailabilityError: candidate.hookAvailabilityError }
      : {}),
  };
}

function parseTerminalSnapshot(value: unknown): TerminalSnapshot {
  const candidate = requireObject(value, "Terminal snapshot");
  if (
    typeof candidate.data !== "string" ||
    !Number.isInteger(candidate.lastSequence) ||
    (candidate.lastSequence as number) < 0
  ) {
    throw new Error("Session Host returned an invalid terminal snapshot.");
  }
  return {
    data: candidate.data,
    lastSequence: candidate.lastSequence as number,
  };
}

export class SessionHostClient
  extends EventEmitter<SessionHostClientEvents>
  implements SessionRuntime
{
  private readonly peer: JsonLinePeer<
    SessionHostServerMessage,
    SessionHostClientMessage
  >;
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly launchIds = new Map<string, string>();
  private readonly queuedHooks: ClaudeHookEvent[] = [];
  private helloResolve: ((result: HelloResult) => void) | null = null;
  private helloReject: ((error: Error) => void) | null = null;
  private closed = false;
  private helloComplete = false;
  private _runtimeVersion = "";
  private _hostPid = 0;
  private _hookAvailabilityError: string | undefined;

  private constructor(
    socket: Socket,
    private readonly requestTimeoutMs: number,
  ) {
    super();
    this.peer = new JsonLinePeer(socket);
    this.peer.on("message", (message) => this.handleMessage(message));
    this.peer.on("error", (error) => {
      this.handleDisconnect(error);
      this.peer.destroy();
    });
    this.peer.once("close", () => this.handleDisconnect());
  }

  static async connect(
    endpoint: string,
    token: string,
    options: {
      connectTimeoutMs?: number;
      requestTimeoutMs?: number;
    } = {},
  ): Promise<SessionHostClient> {
    const socket = createConnection(endpoint);
    const client = new SessionHostClient(
      socket,
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    );
    try {
      await client.completeHello(
        token,
        options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
      );
      return client;
    } catch (error) {
      client.destroy();
      throw error;
    }
  }

  get runtimeVersion(): string {
    return this._runtimeVersion;
  }

  get hostPid(): number {
    return this._hostPid;
  }

  get hookAvailabilityError(): string | undefined {
    return this._hookAvailabilityError;
  }

  async initialize(
    executablePath: string | null,
    initialSessions: SessionRecord[],
  ): Promise<SessionHostSnapshot> {
    const snapshot = parseSnapshot(
      await this.request("initialize", { executablePath, initialSessions }),
    );
    this.applySnapshot(snapshot);
    return snapshot;
  }

  async refreshSnapshot(): Promise<SessionHostSnapshot> {
    const snapshot = parseSnapshot(await this.request("snapshot"));
    this.applySnapshot(snapshot);
    return snapshot;
  }

  async setExecutable(executablePath: string | null): Promise<void> {
    await this.request("setExecutable", { executablePath });
  }

  listSessions(): SessionRecord[] {
    return [...this.sessions.values()]
      .map((session) => ({ ...session }))
      .sort((left, right) => left.createdAt - right.createdAt);
  }

  async createSession(
    workspace: SessionWorkspace,
    requestedTitle?: string,
  ): Promise<SessionRecord> {
    return parseSession(
      await this.request("createSession", { workspace, requestedTitle }),
    );
  }

  async restartSession(sessionId: string): Promise<SessionRecord> {
    return parseSession(await this.request("restartSession", { sessionId }));
  }

  async renameSession(
    sessionId: string,
    requestedTitle: string,
  ): Promise<SessionRecord> {
    return parseSession(
      await this.request("renameSession", { sessionId, requestedTitle }),
    );
  }

  write(sessionId: string, data: string): void {
    void this.request("write", { sessionId, data }).catch(() => undefined);
  }

  async writeRemoteReply(sessionId: string, data: string): Promise<boolean> {
    const result = await this.request("writeRemoteReply", { sessionId, data });
    if (typeof result !== "boolean") {
      throw new Error("Session Host returned an invalid write result.");
    }
    return result;
  }

  resize(sessionId: string, columns: number, rows: number): void {
    void this.request("resize", { sessionId, columns, rows }).catch(
      () => undefined,
    );
  }

  async stop(sessionId: string): Promise<void> {
    await this.request("stopSession", { sessionId });
  }

  async stopAll(): Promise<void> {
    await this.request("stopAll");
  }

  async removeSession(sessionId: string): Promise<SessionRecord> {
    const removed = parseSession(
      await this.request("removeSession", { sessionId }),
    );
    this.sessions.delete(sessionId);
    this.launchIds.delete(sessionId);
    return removed;
  }

  async removeProjectSessions(projectId: string): Promise<void> {
    await this.request("removeProjectSessions", { projectId });
    for (const session of this.sessions.values()) {
      if (session.projectId === projectId) {
        this.sessions.delete(session.id);
        this.launchIds.delete(session.id);
      }
    }
  }

  hasRunningSessions(): boolean {
    return [...this.sessions.values()].some(
      (session) =>
        session.status === "running" || session.status === "starting",
    );
  }

  async getTerminalSnapshot(sessionId: string): Promise<TerminalSnapshot> {
    return parseTerminalSnapshot(
      await this.request("getTerminalSnapshot", { sessionId }),
    );
  }

  isCurrentLaunch(sessionId: string, launchId: string): boolean {
    return (
      this.sessions.get(sessionId)?.status === "running" &&
      this.launchIds.get(sessionId) === launchId
    );
  }

  async shutdownIfIdle(): Promise<boolean> {
    const result = await this.request("shutdownIfIdle");
    if (typeof result !== "boolean") {
      throw new Error("Session Host returned an invalid shutdown result.");
    }
    return result;
  }

  drainQueuedHooks(): ClaudeHookEvent[] {
    return this.queuedHooks.splice(0);
  }

  close(): void {
    this.peer.close();
  }

  destroy(): void {
    this.peer.destroy();
  }

  private completeHello(token: string, timeoutMs: number): Promise<HelloResult> {
    return new Promise<HelloResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.helloResolve = null;
        this.helloReject = null;
        reject(new Error("Timed out connecting to Session Host."));
      }, timeoutMs);
      this.helloResolve = (result) => {
        clearTimeout(timer);
        resolve(result);
      };
      this.helloReject = (error) => {
        clearTimeout(timer);
        reject(error);
      };
      try {
        this.peer.send({
          type: "hello",
          protocolVersion: SESSION_HOST_PROTOCOL_VERSION,
          token,
        });
      } catch (error) {
        clearTimeout(timer);
        this.helloResolve = null;
        this.helloReject = null;
        reject(readableError(error));
      }
    });
  }

  private request(
    method: SessionHostRequestMethod,
    params?: unknown,
  ): Promise<unknown> {
    if (this.closed || !this.helloComplete) {
      return Promise.reject(new Error("Session Host connection is closed."));
    }
    if (this.pendingRequests.size >= MAX_PENDING_REQUESTS) {
      return Promise.reject(new Error("Session Host request queue is full."));
    }
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Session Host request timed out: ${method}`));
      }, this.requestTimeoutMs);
      timer.unref();
      this.pendingRequests.set(id, { resolve, reject, timer });
      try {
        this.peer.send({ type: "request", id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pendingRequests.delete(id);
        reject(readableError(error));
      }
    });
  }

  private handleMessage(message: SessionHostServerMessage): void {
    try {
      if (!message || typeof message !== "object") {
        throw new Error("Session Host sent an invalid message.");
      }
      if (message.type === "hello") {
        if (
          this.helloComplete ||
          message.protocolVersion !== SESSION_HOST_PROTOCOL_VERSION ||
          typeof message.runtimeVersion !== "string" ||
          !message.runtimeVersion ||
          !Number.isInteger(message.hostPid)
        ) {
          throw new Error("Session Host protocol is incompatible.");
        }
        this.helloComplete = true;
        this._runtimeVersion = message.runtimeVersion;
        this._hostPid = message.hostPid;
        const resolve = this.helloResolve;
        this.helloResolve = null;
        this.helloReject = null;
        resolve?.({
          runtimeVersion: message.runtimeVersion,
          hostPid: message.hostPid,
        });
        return;
      }
      if (!this.helloComplete) {
        throw new Error("Session Host did not complete authentication.");
      }
      if (message.type === "response") {
        if (
          typeof message.id !== "string" ||
          !message.id ||
          message.id.length > 200 ||
          typeof message.ok !== "boolean" ||
          (!message.ok && typeof message.error !== "string")
        ) {
          throw new Error("Session Host sent an invalid response.");
        }
        const pending = this.pendingRequests.get(message.id);
        if (!pending) {
          return;
        }
        clearTimeout(pending.timer);
        this.pendingRequests.delete(message.id);
        if (message.ok) {
          pending.resolve(message.result);
        } else {
          pending.reject(new Error(message.error));
        }
        return;
      }
      if (message.type === "event") {
        this.handleEvent(message);
        return;
      }
      throw new Error("Session Host sent an unsupported message.");
    } catch (error) {
      this.handleDisconnect(readableError(error));
      this.peer.destroy();
    }
  }

  private handleEvent(
    message: Extract<SessionHostServerMessage, { type: "event" }>,
  ): void {
    switch (message.event) {
      case "terminalData": {
        const payload = message.payload as TerminalDataEvent;
        if (
          !payload ||
          typeof payload.sessionId !== "string" ||
          typeof payload.data !== "string" ||
          !Number.isInteger(payload.sequence) ||
          payload.sequence < 1
        ) {
          throw new Error("Session Host sent invalid terminal data.");
        }
        this.emit("data", payload);
        return;
      }
      case "sessionChanged": {
        const session = parseSession(message.payload?.session);
        const launchId = message.payload?.launchId;
        if (launchId !== null && typeof launchId !== "string") {
          throw new Error("Session Host sent an invalid launch ID.");
        }
        this.sessions.set(session.id, session);
        if (launchId) {
          this.launchIds.set(session.id, launchId);
        } else {
          this.launchIds.delete(session.id);
        }
        this.emit("changed", { ...session });
        return;
      }
      case "sessionInput": {
        const payload = message.payload as SessionInputEvent;
        if (
          !payload ||
          typeof payload.sessionId !== "string" ||
          (payload.source !== "local" && payload.source !== "remote") ||
          typeof payload.data !== "string"
        ) {
          throw new Error("Session Host sent invalid session input.");
        }
        this.emit("input", payload);
        return;
      }
      case "claudeHook":
        if (
          !message.payload ||
          typeof message.payload.workspaceSessionId !== "string" ||
          typeof message.payload.launchId !== "string" ||
          !message.payload.payload ||
          typeof message.payload.payload !== "object"
        ) {
          throw new Error("Session Host sent an invalid Claude Hook event.");
        }
        if (this.listenerCount("claudeHook") > 0) {
          this.emit("claudeHook", message.payload);
        } else {
          this.queuedHooks.push(message.payload);
          if (this.queuedHooks.length > MAX_QUEUED_HOOKS) {
            this.queuedHooks.shift();
          }
        }
        return;
    }
  }

  private applySnapshot(snapshot: SessionHostSnapshot): void {
    this.sessions.clear();
    this.launchIds.clear();
    for (const session of snapshot.sessions) {
      this.sessions.set(session.id, { ...session });
    }
    for (const [sessionId, launchId] of Object.entries(snapshot.launchIds)) {
      this.launchIds.set(sessionId, launchId);
    }
    this._hookAvailabilityError = snapshot.hookAvailabilityError;
  }

  private handleDisconnect(error?: Error): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const disconnectError =
      error ?? new Error("Session Host connection was closed.");
    this.helloReject?.(disconnectError);
    this.helloResolve = null;
    this.helloReject = null;
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(disconnectError);
    }
    this.pendingRequests.clear();
    this.emit("disconnected", error);
  }
}
