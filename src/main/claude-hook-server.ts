import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
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
  tool_name?: string;
  tool_input?: unknown;
  permission_suggestions?: unknown;
}

export interface ClaudeHookEvent {
  workspaceSessionId: string;
  launchId: string;
  payload: ClaudeHookPayload;
}

interface ClaudeHookServerEvents {
  hook: [event: ClaudeHookEvent];
}

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
    (candidate.tool_name !== undefined &&
      typeof candidate.tool_name !== "string")
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

export class ClaudeHookServer extends EventEmitter<ClaudeHookServerEvents> {
  private readonly token = randomBytes(32).toString("base64url");
  private server: Server | null = null;
  private port: number | null = null;
  private settingsDirectory: string | null = null;

  async start(): Promise<void> {
    if (this.server) {
      return;
    }

    const server = createServer((request, response) => {
      void this.handleRequest(request)
        .then((event) => {
          if (event) {
            this.emit("hook", event);
          }
          response.writeHead(event ? 200 : 404, {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
          });
          response.end("{}");
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
    const settings = {
      hooks: {
        PermissionRequest: [
          {
            matcher: "",
            hooks: [handler],
          },
        ],
        PreToolUse: [
          {
            matcher: "AskUserQuestion|ExitPlanMode",
            hooks: [handler],
          },
        ],
        Notification: [
          {
            matcher:
              "idle_prompt|elicitation_dialog|elicitation_url_dialog|agent_needs_input",
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
