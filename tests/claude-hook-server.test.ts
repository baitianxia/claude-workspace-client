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
  return postJsonWithBody(url, authorization, body).then((result) => result.status);
}

function postJsonWithBody(
  url: string,
  authorization: string,
  body: unknown,
): Promise<{ status: number; body: string }> {
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
        let data = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          data += chunk;
        });
        response.once("end", () =>
          resolve({ status: response.statusCode ?? 0, body: data }),
        );
      },
    );
    outgoing.once("error", reject);
    outgoing.end(payload);
  });
}

const permissionPayload = {
  session_id: "claude-session",
  transcript_path: "C:\\Claude\\transcript.jsonl",
  cwd: "C:\\work\\mall",
  hook_event_name: "PermissionRequest",
  tool_name: "Bash",
  tool_input: { command: "npm test" },
};

async function startedServerUrl(): Promise<{
  server: ClaudeHookServer;
  url: string;
  token: string;
}> {
  const server = new ClaudeHookServer();
  servers.push(server);
  await server.start();
  const launch = server.hookLaunchOptions("workspace-session", "launch-id");
  const settings = JSON.parse(await readFile(launch.args[1], "utf8")) as {
    hooks: { PermissionRequest: Array<{ hooks: Array<{ url: string }> }> };
  };
  return {
    server,
    url: settings.hooks.PermissionRequest[0].hooks[0].url,
    token: `Bearer ${launch.env.CLAUDE_WORKSPACE_HOOK_TOKEN}`,
  };
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
        StopFailure: Array<{ matcher: string }>;
        Notification: Array<{ matcher: string }>;
        SessionStart: Array<{
          matcher: string;
          hooks: Array<{ type: string; command: string; shell: string }>;
        }>;
      };
    };
    expect(launch.args[0]).toBe("--settings");
    expect(launch.args[1]).toMatch(/settings-[a-f0-9]{32}\.json$/u);
    expect(settings.hooks.PreToolUse[0].matcher).toContain("AskUserQuestion");
    expect(settings.hooks.Stop).toHaveLength(1);
    expect(settings.hooks.Notification[0].matcher).toBe("");
    expect(settings.hooks.StopFailure[0].matcher).toBe("");
    expect(settings.hooks.PermissionRequest).toHaveLength(1);
    expect(settings.hooks.SessionStart[0].matcher).toBe("");
    expect(settings.hooks.SessionStart[0].hooks[0]).toMatchObject({
      type: "command",
      shell: process.platform === "win32" ? "powershell" : "bash",
    });
    expect(settings.hooks.SessionStart[0].hooks[0].command).toContain(
      "127.0.0.1",
    );

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

  it("lets a listener hold a decision Hook and answer it later", async () => {
    const { server, url, token } = await startedServerUrl();
    let held: ClaudeHookEvent | null = null;
    server.once("hook", (event) => {
      expect(event.decision).toBeDefined();
      event.decision!.hold();
      held = event;
    });
    const response = postJsonWithBody(url, token, permissionPayload);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(held).not.toBeNull();
    expect(held!.decision!.held).toBe(true);
    expect(held!.decision!.settled).toBe(false);

    const settledReasons: string[] = [];
    held!.decision!.onSettled((reason) => settledReasons.push(reason));
    expect(
      held!.decision!.respond({
        hookSpecificOutput: {
          hookEventName: "PermissionRequest",
          decision: { behavior: "allow" },
        },
      }),
    ).toBe(true);
    const result = await response;
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "allow" },
      },
    });
    expect(settledReasons).toEqual(["responded"]);
    expect(held!.decision!.settled).toBe(true);
    // Nothing can be sent twice.
    expect(held!.decision!.release()).toBe(false);
  });

  it("answers {} at once when nobody holds the Hook, and releases on demand", async () => {
    const { server, url, token } = await startedServerUrl();
    // Not held: Claude Code gets "{}" right after the listeners ran.
    const seen: ClaudeHookEvent[] = [];
    server.once("hook", (event) => seen.push(event));
    const immediate = await postJsonWithBody(url, token, permissionPayload);
    expect(immediate.body).toBe("{}");
    expect(seen[0].decision?.settled).toBe(true);

    // Notification-style Hooks carry no decision handle at all.
    server.once("hook", (event) => seen.push(event));
    await postJson(url, token, {
      ...permissionPayload,
      hook_event_name: "Stop",
      last_assistant_message: "done",
    });
    expect(seen[1].decision).toBeUndefined();

    // Held, then released: still "{}", so Claude Code shows its own dialog.
    let decision: ClaudeHookEvent["decision"];
    server.once("hook", (event) => {
      event.decision!.hold();
      decision = event.decision;
    });
    const pendingResponse = postJsonWithBody(url, token, permissionPayload);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(decision?.held).toBe(true);
    expect(decision!.release()).toBe(true);
    const released = await pendingResponse;
    expect(released.status).toBe(200);
    expect(released.body).toBe("{}");
    expect(decision?.settled).toBe(true);
  });

  it("reports a Hook Claude Code stopped waiting for as closed", async () => {
    const { server, url, token } = await startedServerUrl();
    const reasons: string[] = [];
    let decision: ClaudeHookEvent["decision"];
    server.once("hook", (event) => {
      event.decision!.hold();
      event.decision!.onSettled((reason) => reasons.push(reason));
      decision = event.decision;
    });
    const payload = JSON.stringify(permissionPayload);
    const outgoing = request(url, {
      method: "POST",
      headers: {
        Authorization: token,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
      },
    });
    outgoing.on("error", () => undefined);
    outgoing.end(payload);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(decision?.held).toBe(true);
    // Claude Code gives up (timeout) and drops the connection.
    outgoing.destroy();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(reasons).toEqual(["closed"]);
    expect(decision?.settled).toBe(true);
    expect(decision?.respond({})).toBe(false);
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

  it("uses a PowerShell stdin forwarder for SessionStart on Windows", async () => {
    const server = new ClaudeHookServer("win32");
    servers.push(server);
    await server.start();

    const launch = server.hookLaunchOptions("workspace-session", "launch-id");
    const settings = JSON.parse(await readFile(launch.args[1], "utf8")) as {
      hooks: {
        SessionStart: Array<{
          hooks: Array<{
            type: string;
            command: string;
            shell: string;
          }>;
        }>;
      };
    };
    const hook = settings.hooks.SessionStart[0].hooks[0];

    expect(hook.type).toBe("command");
    expect(hook.shell).toBe("powershell");
    expect(hook.command).toContain("[Console]::In.ReadToEnd()");
    expect(hook.command).toContain("$env:CLAUDE_WORKSPACE_HOOK_TOKEN");
    expect(hook.command).toContain("Invoke-RestMethod");
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
