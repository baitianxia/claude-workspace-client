import { timingSafeEqual } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmod, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import type { PtySpawner } from "../session-manager";
import { SessionManager } from "../session-manager";
import { ClaudeHookServer, type ClaudeHookEvent } from "../claude-hook-server";
import { JsonLinePeer } from "./json-line-peer";
import {
  SESSION_HOST_PROTOCOL_VERSION,
  SESSION_HOST_RUNTIME_VERSION,
  type CreateSessionParams,
  type ProjectIdParams,
  type RenameSessionParams,
  type ResizeSessionParams,
  type SessionHostClientMessage,
  type SessionHostEvent,
  type SessionHostInitializeRequest,
  type SessionHostRequestMethod,
  type SessionHostServerMessage,
  type SessionHostSnapshot,
  type SessionIdParams,
  type WriteSessionParams,
} from "./protocol";
import {
  normalizeSessionRecord,
  SessionHostStateStore,
} from "./state-store";

const MAX_QUEUED_HOOKS = 256;
const IDLE_SHUTDOWN_DELAY_MS = 60_000;

interface SessionHostServerEvents {
  idle: [];
}

interface ConnectedPeer {
  peer: JsonLinePeer<SessionHostClientMessage, SessionHostServerMessage>;
  authenticated: boolean;
}

export interface SessionHostServerOptions {
  endpoint: string;
  token: string;
  statePath: string;
  platform?: NodeJS.Platform;
  ptySpawner?: PtySpawner;
  hookServer?: ClaudeHookServer;
  idleShutdownDelayMs?: number;
}

function readableError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validToken(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  return (
    actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value as Record<string, unknown>;
}

function requireString(
  value: unknown,
  label: string,
  maxLength = 32_000,
): string {
  if (typeof value !== "string" || !value || value.length > maxLength) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function requireData(value: unknown, label: string, maxLength = 100_000): string {
  if (typeof value !== "string" || value.length > maxLength) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function requireExecutablePath(value: unknown): string {
  if (value === null) {
    return "";
  }
  return requireString(value, "Claude executable");
}

function requireSessionIdParams(value: unknown): SessionIdParams {
  const params = requireObject(value, "Session request");
  return { sessionId: requireString(params.sessionId, "Session ID", 200) };
}

export class SessionHostServer extends EventEmitter<SessionHostServerEvents> {
  private readonly stateStore: SessionHostStateStore;
  private readonly hookServer: ClaudeHookServer;
  private readonly peers = new Set<ConnectedPeer>();
  private readonly queuedHooks: ClaudeHookEvent[] = [];
  private readonly idleShutdownDelayMs: number;
  private manager: SessionManager | null = null;
  private server: Server | null = null;
  private executablePath = "";
  private canAdoptInitialSessions = false;
  private hookAvailabilityError: string | undefined;
  private idleTimer: NodeJS.Timeout | null = null;

  constructor(private readonly options: SessionHostServerOptions) {
    super();
    this.stateStore = new SessionHostStateStore(options.statePath);
    this.hookServer = options.hookServer ?? new ClaudeHookServer();
    this.idleShutdownDelayMs =
      options.idleShutdownDelayMs ?? IDLE_SHUTDOWN_DELAY_MS;
  }

  async start(): Promise<void> {
    if (this.server) {
      return;
    }
    const loaded = await this.stateStore.load();
    this.canAdoptInitialSessions = !loaded.existed;

    try {
      await this.hookServer.start();
    } catch (error) {
      this.hookAvailabilityError = `无法启动本机 Claude Code Hook 服务：${readableError(error)}`;
    }

    this.manager = new SessionManager(
      () => {
        if (!this.executablePath) {
          throw new Error("未找到 Claude Code，请先选择本机 claude.exe。");
        }
        return this.executablePath;
      },
      this.options.ptySpawner,
      this.options.platform,
      loaded.sessions,
      (sessionId, launchId) =>
        this.hookAvailabilityError
          ? { args: [] }
          : this.hookServer.hookLaunchOptions(sessionId, launchId),
    );
    this.attachManager(this.manager);
    this.hookServer.on("hook", this.handleHook);

    const server = createServer((socket) => this.accept(socket));
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.options.endpoint);
    });
    this.server = server;
    if ((this.options.platform ?? process.platform) !== "win32") {
      await chmod(this.options.endpoint, 0o600).catch(() => undefined);
    }
    this.scheduleIdleShutdown();
  }

  async stop(): Promise<void> {
    this.clearIdleTimer();
    const server = this.server;
    this.server = null;
    for (const connected of this.peers) {
      connected.peer.destroy();
    }
    this.peers.clear();
    this.hookServer.off("hook", this.handleHook);
    if (this.manager) {
      await this.persistSessions().catch(() => undefined);
    }
    await this.hookServer.stop().catch(() => undefined);
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if ((this.options.platform ?? process.platform) !== "win32") {
      await rm(this.options.endpoint, { force: true }).catch(() => undefined);
    }
  }

  private attachManager(manager: SessionManager): void {
    manager.on("data", (payload) =>
      this.broadcast({ event: "terminalData", payload }),
    );
    manager.on("input", (payload) =>
      this.broadcast({ event: "sessionInput", payload }),
    );
    manager.on("changed", (session) => {
      void this.persistSessions().catch((error: unknown) =>
        console.error("Failed to persist Session Host state", error),
      );
      this.broadcast({
        event: "sessionChanged",
        payload: { session, launchId: manager.getLaunchId(session.id) },
      });
      this.scheduleIdleShutdown();
    });
  }

  private readonly handleHook = (payload: ClaudeHookEvent) => {
    if (this.authenticatedPeerCount() === 0) {
      this.queuedHooks.push(payload);
      if (this.queuedHooks.length > MAX_QUEUED_HOOKS) {
        this.queuedHooks.shift();
      }
      return;
    }
    this.broadcast({ event: "claudeHook", payload });
  };

  private accept(socket: Socket): void {
    this.clearIdleTimer();
    const connected: ConnectedPeer = {
      peer: new JsonLinePeer(socket),
      authenticated: false,
    };
    this.peers.add(connected);
    connected.peer.on("message", (message) =>
      void this.handleMessage(connected, message),
    );
    connected.peer.on("error", () => connected.peer.destroy());
    connected.peer.once("close", () => {
      this.peers.delete(connected);
      this.scheduleIdleShutdown();
    });
  }

  private async handleMessage(
    connected: ConnectedPeer,
    message: SessionHostClientMessage,
  ): Promise<void> {
    if (!connected.authenticated) {
      if (
        !message ||
        message.type !== "hello" ||
        message.protocolVersion !== SESSION_HOST_PROTOCOL_VERSION ||
        typeof message.token !== "string" ||
        !validToken(message.token, this.options.token)
      ) {
        connected.peer.destroy();
        return;
      }
      connected.authenticated = true;
      connected.peer.send({
        type: "hello",
        protocolVersion: SESSION_HOST_PROTOCOL_VERSION,
        runtimeVersion: SESSION_HOST_RUNTIME_VERSION,
        hostPid: process.pid,
      });
      for (const hook of this.queuedHooks.splice(0)) {
        connected.peer.send({
          type: "event",
          event: "claudeHook",
          payload: hook,
        });
      }
      return;
    }

    if (
      !message ||
      message.type !== "request" ||
      typeof message.id !== "string" ||
      !message.id ||
      message.id.length > 200
    ) {
      connected.peer.destroy();
      return;
    }
    try {
      const result = await this.dispatch(message.method, message.params);
      connected.peer.send({ type: "response", id: message.id, ok: true, result });
    } catch (error) {
      try {
        connected.peer.send({
          type: "response",
          id: message.id,
          ok: false,
          error: readableError(error),
        });
      } catch {
        connected.peer.destroy();
      }
    }
  }

  private async dispatch(
    method: SessionHostRequestMethod,
    rawParams: unknown,
  ): Promise<unknown> {
    const manager = this.requireManager();
    switch (method) {
      case "initialize": {
        const params = requireObject(rawParams, "Initialize request");
        const executablePath = requireExecutablePath(params.executablePath);
        if (!Array.isArray(params.initialSessions)) {
          throw new Error("Initial session list is invalid.");
        }
        const initialSessions = params.initialSessions.map(
          normalizeSessionRecord,
        );
        if (
          initialSessions.some((session) => session === null) ||
          new Set(initialSessions.map((session) => session?.id)).size !==
            initialSessions.length
        ) {
          throw new Error("Initial session list is invalid.");
        }
        this.executablePath = executablePath;
        if (this.canAdoptInitialSessions) {
          manager.adoptInitialSessions(
            initialSessions as SessionHostInitializeRequest["initialSessions"],
          );
          this.canAdoptInitialSessions = false;
          await this.persistSessions();
        }
        return this.snapshot();
      }
      case "snapshot":
        return this.snapshot();
      case "setExecutable": {
        const params = requireObject(rawParams, "Executable request");
        this.executablePath = requireExecutablePath(params.executablePath);
        return null;
      }
      case "createSession": {
        const params = requireObject(
          rawParams,
          "Create session request",
        ) as unknown as CreateSessionParams;
        if (!params.workspace || typeof params.workspace !== "object") {
          throw new Error("Session workspace is invalid.");
        }
        const cwd = requireString(params.workspace.cwd, "Session cwd");
        const projectId =
          params.workspace.projectId === null
            ? null
            : requireString(params.workspace.projectId, "Project ID", 200);
        const requestedTitle =
          params.requestedTitle === undefined
            ? undefined
            : requireData(params.requestedTitle, "Session title", 200);
        const result = manager.createSession({ projectId, cwd }, requestedTitle);
        await this.persistSessions();
        return result;
      }
      case "restartSession": {
        const result = manager.restartSession(
          requireSessionIdParams(rawParams).sessionId,
        );
        await this.persistSessions();
        return result;
      }
      case "renameSession": {
        const params = requireObject(
          rawParams,
          "Rename session request",
        ) as unknown as RenameSessionParams;
        const result = manager.renameSession(
          requireString(params.sessionId, "Session ID", 200),
          requireData(params.requestedTitle, "Session title", 200),
        );
        await this.persistSessions();
        return result;
      }
      case "write": {
        const params = requireObject(
          rawParams,
          "Terminal write request",
        ) as unknown as WriteSessionParams;
        manager.write(
          requireString(params.sessionId, "Session ID", 200),
          requireData(params.data, "Terminal data"),
        );
        return null;
      }
      case "writeRemoteReply": {
        const params = requireObject(
          rawParams,
          "Remote reply request",
        ) as unknown as WriteSessionParams;
        return manager.writeRemoteReply(
          requireString(params.sessionId, "Session ID", 200),
          requireData(params.data, "Remote reply"),
        );
      }
      case "resize": {
        const params = requireObject(
          rawParams,
          "Terminal resize request",
        ) as unknown as ResizeSessionParams;
        manager.resize(
          requireString(params.sessionId, "Session ID", 200),
          params.columns,
          params.rows,
        );
        return null;
      }
      case "stopSession":
        manager.stop(requireSessionIdParams(rawParams).sessionId);
        return null;
      case "stopAll":
        manager.stopAll();
        return null;
      case "removeSession": {
        const result = manager.removeSession(
          requireSessionIdParams(rawParams).sessionId,
        );
        await this.persistSessions();
        return result;
      }
      case "removeProjectSessions": {
        const params = requireObject(
          rawParams,
          "Remove project sessions request",
        ) as unknown as ProjectIdParams;
        manager.removeProjectSessions(
          requireString(params.projectId, "Project ID", 200),
        );
        await this.persistSessions();
        return null;
      }
      case "getTerminalSnapshot":
        return manager.getTerminalSnapshot(
          requireSessionIdParams(rawParams).sessionId,
        );
      case "shutdownIfIdle":
        if (manager.hasRunningSessions()) {
          return false;
        }
        setTimeout(() => this.emit("idle"), 25).unref();
        return true;
      default:
        throw new Error("Unsupported Session Host request.");
    }
  }

  private snapshot(): SessionHostSnapshot {
    const manager = this.requireManager();
    const launchIds = Object.fromEntries(
      manager
        .listSessions()
        .flatMap((session) => {
          const launchId = manager.getLaunchId(session.id);
          return launchId ? [[session.id, launchId]] : [];
        }),
    );
    return {
      sessions: manager.listSessions(),
      launchIds,
      ...(this.hookAvailabilityError
        ? { hookAvailabilityError: this.hookAvailabilityError }
        : {}),
    };
  }

  private broadcast(event: SessionHostEvent): void {
    for (const connected of this.peers) {
      if (!connected.authenticated) {
        continue;
      }
      try {
        connected.peer.send({ type: "event", ...event });
      } catch {
        connected.peer.destroy();
      }
    }
  }

  private authenticatedPeerCount(): number {
    return [...this.peers].filter((peer) => peer.authenticated).length;
  }

  private async persistSessions(): Promise<void> {
    await this.stateStore.persist(this.requireManager().listSessions());
  }

  private requireManager(): SessionManager {
    if (!this.manager) {
      throw new Error("Session Host has not started.");
    }
    return this.manager;
  }

  private scheduleIdleShutdown(): void {
    this.clearIdleTimer();
    if (
      this.authenticatedPeerCount() > 0 ||
      this.manager?.hasRunningSessions()
    ) {
      return;
    }
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (
        this.authenticatedPeerCount() === 0 &&
        !this.manager?.hasRunningSessions()
      ) {
        this.emit("idle");
      }
    }, this.idleShutdownDelayMs);
    this.idleTimer.unref();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }
}
