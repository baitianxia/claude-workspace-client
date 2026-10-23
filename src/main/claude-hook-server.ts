import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAX_HOOK_BODY_BYTES = 256_000;

export interface ClaudeHookPayload {
  session_id: string;
  transcript_path: string;
  cwd: string;
  hook_event_name: string;
  permission_mode?: string;
  message?: string;
  title?: string;
  notification_type?: string;
  error?: string;
  error_details?: string;
  tool_name?: string;
  tool_input?: unknown;
  permission_suggestions?: unknown;
  stop_hook_active?: boolean;
  last_assistant_message?: string;
  background_tasks?: unknown;
  session_crons?: unknown;
}

/**
 * Lets a 'hook' listener answer a Hook through its HTTP response instead of
 * letting Claude Code fall through to its own dialog. PermissionRequest and
 * PreToolUse hooks accept a decision this way, so a remote reply can allow,
 * deny or answer a prompt without the terminal menu being drawn at all.
 *
 * `hold()` must be called synchronously while the 'hook' event is being
 * emitted; otherwise the server answers `{}` right away (Claude Code then
 * shows its dialog as usual).
 */
export interface ClaudeHookDecision {
  /** Keep the request open; the caller promises to respond or release. */
  hold(): void;
  /** Whether the request is held and still open. */
  readonly held: boolean;
  /** Whether a response has been sent or the request is gone. */
  readonly settled: boolean;
  /** Send a hook output object as the response. False if already settled. */
  respond(output: Record<string, unknown>): boolean;
  /** Send `{}`: Claude Code proceeds as if the hook had nothing to say. */
  release(): boolean;
  /**
   * Called once when the request can no longer be answered: Claude Code
   * timed out, exited, or the response was sent.
   */
  onSettled(listener: (reason: "responded" | "released" | "closed") => void): void;
}

export interface ClaudeHookEvent {
  workspaceSessionId: string;
  launchId: string;
  payload: ClaudeHookPayload;
  /**
   * Present for Hooks whose response Claude Code reads as a decision
   * (PermissionRequest, PreToolUse). Absent for notification-style Hooks.
   */
  decision?: ClaudeHookDecision;
}

interface ClaudeHookServerEvents {
  hook: [event: ClaudeHookEvent];
}

/** Hooks whose JSON response Claude Code reads as a decision. */
const DECISION_HOOK_EVENTS = new Set(["PermissionRequest", "PreToolUse"]);

/**
 * How long Claude Code waits for a decision Hook before giving up and showing
 * its own dialog. A held request is released long before that whenever the
 * owner comes back to the computer; the limit only bounds the damage if this
 * process hangs. A crash closes the connection and Claude Code continues at
 * once.
 */
export const DECISION_HOOK_TIMEOUT_SECONDS = 3_600;

function isNonEmptyString(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= maxLength
  );
}

function normalizeHookPayload(value: unknown): ClaudeHookPayload | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as Partial<ClaudeHookPayload>;
  if (
    !isNonEmptyString(candidate.session_id, 200) ||
    !isNonEmptyString(candidate.transcript_path, 32_000) ||
    !isNonEmptyString(candidate.cwd, 32_000) ||
    !isNonEmptyString(candidate.hook_event_name, 100)
  ) {
    return null;
  }
  if (
    (candidate.permission_mode !== undefined &&
      typeof candidate.permission_mode !== "string") ||
    (candidate.message !== undefined && typeof candidate.message !== "string") ||
    (candidate.title !== undefined && typeof candidate.title !== "string") ||
    (candidate.notification_type !== undefined &&
      typeof candidate.notification_type !== "string") ||
    (candidate.error !== undefined && typeof candidate.error !== "string") ||
    (candidate.error_details !== undefined &&
      typeof candidate.error_details !== "string") ||
    (candidate.tool_name !== undefined &&
      typeof candidate.tool_name !== "string") ||
    (candidate.stop_hook_active !== undefined &&
      typeof candidate.stop_hook_active !== "boolean") ||
    (candidate.last_assistant_message !== undefined &&
      typeof candidate.last_assistant_message !== "string")
  ) {
    return null;
  }
  return candidate as ClaudeHookPayload;
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > MAX_HOOK_BODY_BYTES) {
      throw new Error("Hook body is too large.");
    }
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

interface DecisionHandleInternals {
  handle: ClaudeHookDecision;
  finish(reason: "responded" | "released" | "closed"): void;
}

function createDecisionHandle(
  response: ServerResponse,
  send: (status: number, body: string) => boolean,
): DecisionHandleInternals {
  let held = false;
  let settled = false;
  const listeners: Array<(reason: "responded" | "released" | "closed") => void> = [];
  const finish = (reason: "responded" | "released" | "closed") => {
    if (settled) {
      return;
    }
    settled = true;
    held = false;
    for (const listener of listeners.splice(0)) {
      try {
        listener(reason);
      } catch (error) {
        console.error("Claude Code Hook decision listener failed", error);
      }
    }
  };
  // Claude Code gives up (timeout) or exits: the connection closes before a
  // response was written. (IncomingMessage's own 'close' fires as soon as the
  // body has been read, so it cannot be used for this.)
  response.once("close", () => {
    if (!settled && !response.writableEnded) {
      finish("closed");
    }
  });
  const handle: ClaudeHookDecision = {
    hold() {
      if (!settled) {
        held = true;
      }
    },
    get held() {
      return held && !settled;
    },
    get settled() {
      return settled;
    },
    respond(output) {
      if (settled) {
        return false;
      }
      const sent = send(200, JSON.stringify(output));
      finish(sent ? "responded" : "closed");
      return sent;
    },
    release() {
      if (settled) {
        return false;
      }
      const sent = send(200, "{}");
      finish(sent ? "released" : "closed");
      return sent;
    },
    onSettled(listener) {
      if (settled) {
        return;
      }
      listeners.push(listener);
    },
  };
  return { handle, finish };
}

function shellLiteral(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function powershellLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export class ClaudeHookServer extends EventEmitter<ClaudeHookServerEvents> {
  private readonly token = randomBytes(32).toString("base64url");
  private server: Server | null = null;
  private port: number | null = null;
  private settingsDirectory: string | null = null;

  constructor(private readonly platform: NodeJS.Platform = process.platform) {
    super();
  }

  async start(): Promise<void> {
    if (this.server) {
      return;
    }

    const server = createServer((request, response) => {
      void this.handleRequest(request)
        .then((event) => {
          const send = (status: number, body: string) => {
            if (response.writableEnded || response.destroyed) {
              return false;
            }
            response.writeHead(status, {
              "Content-Type": "application/json; charset=utf-8",
              "Cache-Control": "no-store",
            });
            response.end(body);
            return true;
          };
          if (!event) {
            send(404, "{}");
            return;
          }
          const decision = DECISION_HOOK_EVENTS.has(event.payload.hook_event_name)
            ? createDecisionHandle(response, send)
            : null;
          if (decision) {
            event.decision = decision.handle;
          }
          this.emit("hook", event);
          if (!decision || !decision.handle.held) {
            // Nobody wants to decide: let Claude Code show its own dialog.
            decision?.finish("released");
            send(200, "{}");
          }
        })
        .catch((error: unknown) => {
          const tooLarge =
            error instanceof Error && error.message === "Hook body is too large.";
          response.writeHead(tooLarge ? 413 : 400, {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
          });
          response.end("{}");
        });
    });

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
      server.listen(0, "127.0.0.1");
    });

    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("无法获取 Claude Code Hook 服务端口。");
    }

    let settingsDirectory: string;
    try {
      settingsDirectory = mkdtempSync(
        join(tmpdir(), "claude-workspace-hooks-"),
      );
    } catch (error) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      throw new Error(
        `无法创建 Claude Code Hook 配置目录：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    this.server = server;
    this.port = address.port;
    this.settingsDirectory = settingsDirectory;
  }

  hookLaunchOptions(workspaceSessionId: string, launchId: string): {
    args: string[];
    env: NodeJS.ProcessEnv;
  } {
    if (!this.port || !this.settingsDirectory) {
      throw new Error("Claude Code Hook 服务尚未启动。");
    }
    const url =
      `http://127.0.0.1:${this.port}/hooks/` +
      `${encodeURIComponent(workspaceSessionId)}/${encodeURIComponent(launchId)}`;
    const handler = {
      type: "http",
      url,
      timeout: 5,
      headers: {
        Authorization: "Bearer $CLAUDE_WORKSPACE_HOOK_TOKEN",
      },
      allowedEnvVars: ["CLAUDE_WORKSPACE_HOOK_TOKEN"],
    };
    // Decision Hooks may be held open while a remote reply is awaited (see
    // ClaudeHookDecision); Claude Code must not time them out meanwhile.
    const decisionHandler = { ...handler, timeout: DECISION_HOOK_TIMEOUT_SECONDS };
    // Claude Code does not support HTTP hooks for SessionStart. Keep the
    // event on the same authenticated loopback channel by forwarding the
    // hook's stdin through the platform shell instead.
    const sessionStartHook = {
      type: "command",
      command:
        this.platform === "win32"
          ? `$body = [Console]::In.ReadToEnd(); try { Invoke-RestMethod -Method Post -Uri ${powershellLiteral(url)} -Headers @{ Authorization = "Bearer $env:CLAUDE_WORKSPACE_HOOK_TOKEN" } -ContentType "application/json" -Body $body -TimeoutSec 5 -ErrorAction Stop | Out-Null } catch { }`
          : `curl --silent --show-error --max-time 5 --request POST --header "Authorization: Bearer $CLAUDE_WORKSPACE_HOOK_TOKEN" --header "Content-Type: application/json" --data-binary @- ${shellLiteral(url)} >/dev/null 2>&1 || true`,
      shell: this.platform === "win32" ? "powershell" : "bash",
      timeout: 5,
    };
    const settings = {
      hooks: {
        SessionStart: [
          {
            matcher: "",
            hooks: [sessionStartHook],
          },
        ],
        PermissionRequest: [
          {
            matcher: "",
            hooks: [decisionHandler],
          },
        ],
        PreToolUse: [
          {
            matcher: "AskUserQuestion|ExitPlanMode",
            hooks: [decisionHandler],
          },
        ],
        Stop: [
          {
            matcher: "",
            hooks: [handler],
          },
        ],
        Notification: [
          {
            // An empty matcher is intentional: Claude Code adds notification
            // types over time (including permission_prompt), and missing one
            // here makes the remote channel appear connected while silently
            // dropping the corresponding event.
            matcher: "",
            hooks: [handler],
          },
        ],
        StopFailure: [
          {
            matcher: "",
            hooks: [handler],
          },
        ],
      },
    };
    const settingsPath = join(
      this.settingsDirectory,
      `settings-${randomBytes(16).toString("hex")}.json`,
    );
    try {
      writeFileSync(settingsPath, JSON.stringify(settings), {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
    } catch (error) {
      // Only this launch failed. The server and the settings directory are
      // shared by every running Claude Code session, so keep them; just make
      // sure no partial file of this launch is left behind.
      try {
        if ((error as NodeJS.ErrnoException | undefined)?.code !== "EEXIST") {
          rmSync(settingsPath, { force: true });
        }
      } catch (cleanupError) {
        console.error("Failed to remove partial Claude Code Hook settings", cleanupError);
      }
      throw new Error(
        `无法写入 Claude Code Hook 配置：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    return {
      args: ["--settings", settingsPath],
      env: { CLAUDE_WORKSPACE_HOOK_TOKEN: this.token },
    };
  }

  async stop(): Promise<void> {
    const server = this.server;
    const settingsDirectory = this.settingsDirectory;
    this.server = null;
    this.port = null;
    this.settingsDirectory = null;
    try {
      if (server) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    } finally {
      if (settingsDirectory) {
        await rm(settingsDirectory, { recursive: true, force: true });
      }
    }
  }

  private async handleRequest(
    request: IncomingMessage,
  ): Promise<ClaudeHookEvent | null> {
    if (request.method !== "POST") {
      return null;
    }
    if (request.headers.authorization !== `Bearer ${this.token}`) {
      return null;
    }
    const match = /^\/hooks\/([^/]+)\/([^/]+)$/u.exec(request.url ?? "");
    if (!match) {
      return null;
    }
    const workspaceSessionId = decodeURIComponent(match[1]);
    const launchId = decodeURIComponent(match[2]);
    if (
      !isNonEmptyString(workspaceSessionId, 200) ||
      !isNonEmptyString(launchId, 200)
    ) {
      return null;
    }
    const payload = normalizeHookPayload(await readJsonBody(request));
    return payload ? { workspaceSessionId, launchId, payload } : null;
  }
}
