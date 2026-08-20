import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { request } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  ClaudeHookServer,
  type ClaudeHookEvent,
} from "../src/main/claude-hook-server";

const servers: ClaudeHookServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
});

function postJson(
  url: string,
  authorization: string,
  body: unknown,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const outgoing = request(
      url,
      {
        method: "POST",
        headers: {
          Authorization: authorization,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode ?? 0));
      },
    );
    outgoing.once("error", reject);
    outgoing.end(payload);
  });
}

describe("ClaudeHookServer", () => {
  it("injects supported Claude Code hooks and authenticates loopback callbacks", async () => {
    const server = new ClaudeHookServer();
    servers.push(server);
    await server.start();

    const launch = server.hookLaunchOptions("workspace-session", "launch-id");
    const settings = JSON.parse(await readFile(launch.args[1], "utf8")) as {
      hooks: {
        PermissionRequest: Array<{
          hooks: Array<{ url: string; headers: { Authorization: string } }>;
        }>;
        PreToolUse: Array<{ matcher: string }>;
        Stop: Array<{ matcher: string }>;
        Notification: Array<{ matcher: string }>;
      };
    };
    expect(launch.args[0]).toBe("--settings");
    expect(launch.args[1]).toMatch(/settings-[a-f0-9]{32}\.json$/u);
    expect(settings.hooks.PreToolUse[0].matcher).toContain("AskUserQuestion");
    expect(settings.hooks.Stop).toHaveLength(1);
    expect(settings.hooks.Notification[0].matcher).toContain("idle_prompt");
    expect(settings.hooks.Notification[0].matcher).toContain(
      "agent_needs_input",
    );
    expect(settings.hooks.PermissionRequest).toHaveLength(1);

    const url = settings.hooks.PermissionRequest[0].hooks[0].url;
    const token = launch.env.CLAUDE_WORKSPACE_HOOK_TOKEN;
    expect(token).toBeTruthy();
    const received = once(server, "hook") as Promise<[ClaudeHookEvent]>;
    const status = await postJson(url, `Bearer ${token}`, {
      session_id: "claude-session",
      transcript_path: "C:\\Claude\\transcript.jsonl",
      cwd: "C:\\work\\mall",
      hook_event_name: "PermissionRequest",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
    });

    expect(status).toBe(200);
    await expect(received).resolves.toEqual([
      expect.objectContaining({
        workspaceSessionId: "workspace-session",
        launchId: "launch-id",
        payload: expect.objectContaining({
          session_id: "claude-session",
          tool_name: "Bash",
        }),
      }),
    ]);

    const stopReceived = once(server, "hook") as Promise<[ClaudeHookEvent]>;
    expect(
      await postJson(url, `Bearer ${token}`, {
        session_id: "claude-session",
        transcript_path: "C:\\Claude\\transcript.jsonl",
        cwd: "C:\\work\\mall",
        hook_event_name: "Stop",
        stop_hook_active: false,
        last_assistant_message: "修复已完成，测试全部通过。",
        background_tasks: [],
      }),
    ).toBe(200);
    await expect(stopReceived).resolves.toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          hook_event_name: "Stop",
          last_assistant_message: "修复已完成，测试全部通过。",
        }),
      }),
    ]);
  });

  it("rejects callbacks without the per-application bearer token", async () => {
    const server = new ClaudeHookServer();
    servers.push(server);
    await server.start();
    const launch = server.hookLaunchOptions("workspace-session", "launch-id");
    const settings = JSON.parse(await readFile(launch.args[1], "utf8")) as {
      hooks: {
        PermissionRequest: Array<{ hooks: Array<{ url: string }> }>;
      };
    };
    const url = settings.hooks.PermissionRequest[0].hooks[0].url;

    expect(
      await postJson(url, "Bearer wrong-token", {
        session_id: "claude-session",
        transcript_path: "transcript.jsonl",
        cwd: "C:\\work",
        hook_event_name: "Notification",
      }),
    ).toBe(404);
  });

  it("removes generated settings files when the hook server stops", async () => {
    const server = new ClaudeHookServer();
    servers.push(server);
    await server.start();
    const settingsPath = server.hookLaunchOptions(
      "workspace-session",
      "launch-id",
    ).args[1];

    await server.stop();

    await expect(readFile(settingsPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
