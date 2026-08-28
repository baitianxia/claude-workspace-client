import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IPty } from "node-pty";
import { describe, expect, it, vi } from "vitest";
import { ClaudeHookServer } from "../src/main/claude-hook-server";
import { SessionHostClient } from "../src/main/session-host/client";
import { resolveSessionHostPaths } from "../src/main/session-host/launcher";
import { SessionHostServer } from "../src/main/session-host/server";
import type { PtySpawner } from "../src/main/session-manager";

interface FakePtyController {
  process: IPty;
  emitData(data: string): void;
  emitExit(exitCode: number): void;
  writes: string[];
  killed: boolean;
}

function fakePty(): FakePtyController {
  let dataListener: (data: string) => void = () => undefined;
  let exitListener: (event: { exitCode: number; signal?: number }) => void = () =>
    undefined;
  const writes: string[] = [];
  const controller: FakePtyController = {
    process: {
      pid: 42,
      process: "claude",
      cols: 120,
      rows: 36,
      handleFlowControl: false,
      onData: (listener) => {
        dataListener = listener;
        return { dispose: () => undefined };
      },
      onExit: (listener) => {
        exitListener = listener;
        return { dispose: () => undefined };
      },
      write: (data) => writes.push(String(data)),
      resize: () => undefined,
      clear: () => undefined,
      pause: () => undefined,
      resume: () => undefined,
      kill: () => {
        controller.killed = true;
      },
    },
    emitData: (data) => dataListener(data),
    emitExit: (exitCode) => exitListener({ exitCode, signal: 0 }),
    writes,
    killed: false,
  };
  return controller;
}

function stubHookServer(): ClaudeHookServer {
  const hookServer = new ClaudeHookServer();
  vi.spyOn(hookServer, "start").mockResolvedValue(undefined);
  vi.spyOn(hookServer, "stop").mockResolvedValue(undefined);
  vi.spyOn(hookServer, "hookLaunchOptions").mockReturnValue({
    args: [],
    env: {},
  });
  return hookServer;
}

describe("Session Host", () => {
  it("keeps a PTY alive across client disconnect and reconnect", async () => {
    const directory = await mkdtemp(join(tmpdir(), "workspace-host-"));
    const endpoint = join(directory, "host.sock");
    const token = "test-token-that-is-long-enough";
    const fake = fakePty();
    const spawner = vi.fn(() => fake.process) as PtySpawner;
    const server = new SessionHostServer({
      endpoint,
      token,
      statePath: join(directory, "state.json"),
      platform: "darwin",
      ptySpawner: spawner,
      hookServer: stubHookServer(),
      idleShutdownDelayMs: 60_000,
    });
    let firstClient: SessionHostClient | null = null;
    let secondClient: SessionHostClient | null = null;
    try {
      await server.start();
      firstClient = await SessionHostClient.connect(endpoint, token);
      await firstClient.initialize("/usr/local/bin/claude", []);
      const created = await firstClient.createSession({
        projectId: "project-one",
        cwd: "/work/mall",
      });

      const firstOutput = new Promise<void>((resolveOutput) =>
        firstClient?.once("data", () => resolveOutput()),
      );
      fake.emitData("still running\r\n");
      await firstOutput;
      firstClient.close();
      firstClient = null;

      expect(fake.killed).toBe(false);

      secondClient = await SessionHostClient.connect(endpoint, token);
      const reconnected = await secondClient.initialize(
        "/usr/local/bin/claude",
        [],
      );
      expect(reconnected.sessions).toContainEqual(
        expect.objectContaining({ id: created.id, status: "running" }),
      );
      await expect(secondClient.getTerminalSnapshot(created.id)).resolves.toEqual({
        data: "still running\r\n",
        lastSequence: 1,
      });
      await expect(
        secondClient.writeRemoteReply(created.id, "continue\r"),
      ).resolves.toBe(true);
      expect(fake.writes).toEqual(["continue\r"]);

      await secondClient.stopAll();
      expect(fake.killed).toBe(true);
    } finally {
      firstClient?.close();
      secondClient?.close();
      await server.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects clients with the wrong per-user token", async () => {
    const directory = await mkdtemp(join(tmpdir(), "workspace-host-auth-"));
    const endpoint = join(directory, "host.sock");
    const server = new SessionHostServer({
      endpoint,
      token: "correct-token",
      statePath: join(directory, "state.json"),
      platform: "darwin",
      hookServer: stubHookServer(),
      idleShutdownDelayMs: 60_000,
    });
    try {
      await server.start();
      await expect(
        SessionHostClient.connect(endpoint, "wrong-token", {
          connectTimeoutMs: 500,
        }),
      ).rejects.toThrow();
    } finally {
      await server.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("uses a stable per-user Windows named pipe outside the install path", () => {
    const first = resolveSessionHostPaths(
      "C:\\Users\\dev\\AppData\\Roaming\\Claude Workspace",
      "win32",
    );
    const second = resolveSessionHostPaths(
      "C:\\Users\\dev\\AppData\\Roaming\\Claude Workspace",
      "win32",
    );

    expect(first.endpoint).toBe(second.endpoint);
    expect(first.endpoint).toMatch(
      /^\\\\\.\\pipe\\claude-workspace-session-[a-f0-9]{24}$/u,
    );
    expect(first.runtimePath).toContain("session-host");
    expect(first.runtimePath).not.toContain("Program Files");
  });
});
