import { describe, expect, it, vi } from "vitest";
import type { IPty } from "node-pty";
import {
  SessionManager,
  type PtySpawner,
  type SessionWorkspace,
} from "../src/main/session-manager";

interface FakePtyController {
  process: IPty;
  emitData(data: string): void;
  emitExit(exitCode: number): void;
  writes: string[];
  sizes: Array<[number, number]>;
  killed: boolean;
}

function fakePty(): FakePtyController {
  let dataListener: (data: string) => void = () => undefined;
  let exitListener: (event: { exitCode: number; signal?: number }) => void = () =>
    undefined;
  const writes: string[] = [];
  const sizes: Array<[number, number]> = [];
  const controller: FakePtyController = {
    process: {
      pid: 42,
      process: "claude.exe",
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
      write: (data) => {
        writes.push(typeof data === "string" ? data : data.toString());
      },
      resize: (columns, rows) => {
        sizes.push([columns, rows]);
      },
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
    sizes,
    killed: false,
  };
  return controller;
}

function project(): SessionWorkspace {
  return {
    projectId: "project-one",
    cwd: "C:\\work\\mall",
  };
}

describe("SessionManager", () => {
  it("starts Claude Code with the selected project as cwd", () => {
    const fake = fakePty();
    const spawner = vi.fn(() => fake.process) as PtySpawner;
    const manager = new SessionManager(
      () => "C:\\Tools\\claude.exe",
      spawner,
      "win32",
    );

    const session = manager.createSession(project());

    expect(session.status).toBe("running");
    expect(session.cwd).toBe("C:\\work\\mall");
    expect(spawner).toHaveBeenCalledWith(
      "C:\\Tools\\claude.exe",
      [],
      expect.objectContaining({ cwd: "C:\\work\\mall" }),
    );
  });

  it("starts a temporary session without a project association", () => {
    const fake = fakePty();
    const spawner = vi.fn(() => fake.process) as PtySpawner;
    const manager = new SessionManager(
      () => "C:\\Tools\\claude.exe",
      spawner,
      "win32",
    );

    const session = manager.createSession({
      projectId: null,
      cwd: "C:\\Users\\dev\\AppData\\Roaming\\Claude Workspace\\temporary-workspaces\\session-one",
    });

    expect(session).toMatchObject({
      projectId: null,
      status: "running",
    });
    expect(spawner).toHaveBeenCalledWith(
      "C:\\Tools\\claude.exe",
      [],
      expect.objectContaining({ cwd: session.cwd }),
    );
  });

  it("applies per-launch Claude arguments and environment on restart", () => {
    const first = fakePty();
    const second = fakePty();
    const spawner = vi
      .fn()
      .mockReturnValueOnce(first.process)
      .mockReturnValueOnce(second.process) as unknown as PtySpawner;
    const launchIds: string[] = [];
    const manager = new SessionManager(
      () => "C:\\Tools\\claude.exe",
      spawner,
      "win32",
      [],
      (_sessionId, launchId) => {
        launchIds.push(launchId);
        return {
          args: ["--settings", launchId],
          env: { CLAUDE_WORKSPACE_HOOK_TOKEN: `token-${launchId}` },
        };
      },
    );

    const created = manager.createSession(project());
    first.emitExit(0);
    manager.restartSession(created.id);

    expect(launchIds).toHaveLength(2);
    expect(launchIds[0]).not.toBe(launchIds[1]);
    expect(spawner).toHaveBeenNthCalledWith(
      1,
      "C:\\Tools\\claude.exe",
      ["--settings", launchIds[0]],
      expect.objectContaining({
        env: expect.objectContaining({
          CLAUDE_WORKSPACE_HOOK_TOKEN: `token-${launchIds[0]}`,
        }),
      }),
    );
    expect(spawner).toHaveBeenNthCalledWith(
      2,
      "C:\\Tools\\claude.exe",
      ["--settings", launchIds[1]],
      expect.objectContaining({
        env: expect.objectContaining({
          CLAUDE_WORKSPACE_HOOK_TOKEN: `token-${launchIds[1]}`,
        }),
      }),
    );
  });

  it("forwards terminal input, output, resize and exit state", () => {
    const fake = fakePty();
    const manager = new SessionManager(
      () => "/usr/local/bin/claude",
      (() => fake.process) as PtySpawner,
      "darwin",
    );
    const changed = vi.fn();
    const input = vi.fn();
    manager.on("changed", changed);
    manager.on("input", input);
    const session = manager.createSession(project());

    manager.write(session.id, "hello\r");
    manager.resize(session.id, 10, 999);
    fake.emitData("Claude Code\r\n");

    expect(fake.writes).toEqual(["hello\r"]);
    expect(input).toHaveBeenCalledWith({
      sessionId: session.id,
      source: "local",
      data: "hello\r",
    });
    expect(fake.sizes).toEqual([[20, 200]]);
    expect(manager.getTerminalSnapshot(session.id)).toEqual({
      data: "Claude Code\r\n",
      lastSequence: 1,
    });

    fake.emitExit(7);
    manager.write(session.id, "ignored");
    expect(manager.listSessions()[0]).toMatchObject({
      status: "exited",
      exitCode: 7,
    });
    expect(changed).toHaveBeenCalledTimes(2);
    expect(fake.writes).toEqual(["hello\r"]);
  });

  it("restarts an exited session in place and ignores stale process events", () => {
    const first = fakePty();
    const second = fakePty();
    const spawner = vi
      .fn()
      .mockReturnValueOnce(first.process)
      .mockReturnValueOnce(second.process) as unknown as PtySpawner;
    const manager = new SessionManager(
      () => "/usr/local/bin/claude",
      spawner,
      "darwin",
    );
    const changed = vi.fn();
    manager.on("changed", changed);
    const created = manager.createSession(project(), "登录排查");

    expect(() => manager.restartSession(created.id)).toThrow("仍在运行");
    first.emitData("first process\r\n");
    first.emitExit(7);
    changed.mockClear();

    const restarted = manager.restartSession(created.id);

    expect(restarted).toMatchObject({
      id: created.id,
      projectId: created.projectId,
      title: "登录排查",
      cwd: created.cwd,
      status: "running",
      createdAt: created.createdAt,
    });
    expect(restarted).not.toHaveProperty("exitCode");
    expect(changed.mock.calls.map(([session]) => session.status)).toEqual([
      "starting",
      "running",
    ]);
    expect(spawner).toHaveBeenNthCalledWith(
      2,
      "/usr/local/bin/claude",
      [],
      expect.objectContaining({ cwd: created.cwd }),
    );
    expect(manager.getTerminalSnapshot(created.id).data).toContain(
      "正在原工作目录重新启动 Claude Code",
    );

    manager.write(created.id, "after restart\r");
    first.emitData("stale output");
    first.emitExit(99);
    second.emitData("second process\r\n");

    expect(first.writes).toEqual([]);
    expect(second.writes).toEqual(["after restart\r"]);
    expect(manager.listSessions()[0].status).toBe("running");
    expect(manager.getTerminalSnapshot(created.id).data).not.toContain(
      "stale output",
    );
    expect(manager.getTerminalSnapshot(created.id).data).toContain(
      "second process",
    );
  });

  it("keeps a session restartable after a restart attempt fails", () => {
    const first = fakePty();
    const recovered = fakePty();
    const spawner = vi
      .fn()
      .mockReturnValueOnce(first.process)
      .mockImplementationOnce(() => {
        throw new Error("spawn denied");
      })
      .mockReturnValueOnce(recovered.process) as unknown as PtySpawner;
    const manager = new SessionManager(
      () => "/usr/local/bin/claude",
      spawner,
      "darwin",
    );
    const created = manager.createSession(project());
    first.emitExit(1);

    expect(() => manager.restartSession(created.id)).toThrow(
      "无法重新启动 Claude Code：spawn denied",
    );
    expect(manager.listSessions()[0]).toMatchObject({
      status: "failed",
      error: "spawn denied",
    });
    expect(manager.listSessions()[0]).not.toHaveProperty("exitCode");

    const restarted = manager.restartSession(created.id);

    expect(restarted.status).toBe("running");
    expect(restarted).not.toHaveProperty("error");
  });

  it("terminates and removes sessions when a project is removed", () => {
    const fake = fakePty();
    const manager = new SessionManager(
      () => "/usr/local/bin/claude",
      (() => fake.process) as PtySpawner,
      "darwin",
    );
    manager.createSession(project());

    manager.removeProjectSessions("project-one");

    expect(fake.killed).toBe(true);
    expect(manager.listSessions()).toEqual([]);
  });

  it("terminates and removes an individual session", () => {
    const fake = fakePty();
    const manager = new SessionManager(
      () => "/usr/local/bin/claude",
      (() => fake.process) as PtySpawner,
      "darwin",
    );
    const created = manager.createSession(project());

    manager.removeSession(created.id);

    expect(fake.killed).toBe(true);
    expect(manager.listSessions()).toEqual([]);
    expect(() => manager.removeSession(created.id)).toThrow("已经被移除");
  });

  it("renames a session and publishes the updated record", () => {
    const fake = fakePty();
    const manager = new SessionManager(
      () => "/usr/local/bin/claude",
      (() => fake.process) as PtySpawner,
      "darwin",
    );
    const changed = vi.fn();
    manager.on("changed", changed);
    const created = manager.createSession(project());
    changed.mockClear();

    const renamed = manager.renameSession(created.id, "  修复登录问题  ");

    expect(renamed.title).toBe("修复登录问题");
    expect(manager.listSessions()[0].title).toBe("修复登录问题");
    expect(changed).toHaveBeenCalledWith(
      expect.objectContaining({ id: created.id, title: "修复登录问题" }),
    );
  });

  it("rejects empty and oversized session names", () => {
    const fake = fakePty();
    const manager = new SessionManager(
      () => "/usr/local/bin/claude",
      (() => fake.process) as PtySpawner,
      "darwin",
    );
    const created = manager.createSession(project());

    expect(() => manager.renameSession(created.id, "   ")).toThrow(
      "会话名称不能为空",
    );
    expect(() => manager.renameSession(created.id, "名".repeat(81))).toThrow(
      "不能超过 80 个字符",
    );
    expect(() => manager.createSession(project(), "名".repeat(81))).toThrow(
      "不能超过 80 个字符",
    );
    expect(manager.listSessions()).toHaveLength(1);
  });

  it("explains Windows error 193 as an invalid Claude Code executable", () => {
    const spawner = (() => {
      throw new Error("Cannot create process, error code: 193");
    }) as PtySpawner;
    const manager = new SessionManager(
      () => "C:\\Users\\dev\\AppData\\Local\\Microsoft\\WindowsApps\\Claude.exe",
      spawner,
      "win32",
    );

    expect(() => manager.createSession(project())).toThrow(
      /Windows 错误 193.*WindowsApps/u,
    );
    expect(manager.listSessions()).toEqual([
      expect.objectContaining({ status: "failed", projectId: "project-one" }),
    ]);
  });

  it("restores persisted labels and marks previously running sessions interrupted", () => {
    const fake = fakePty();
    const spawner = vi.fn(() => fake.process) as PtySpawner;
    const manager = new SessionManager(
      () => "C:\\Tools\\claude.exe",
      spawner,
      "win32",
      [
        {
          id: "persisted-session",
          projectId: "project-one",
          title: "历史会话",
          cwd: "C:\\work\\mall",
          status: "running",
          createdAt: 12,
        },
      ],
    );

    expect(spawner).not.toHaveBeenCalled();
    expect(manager.listSessions()).toEqual([
      expect.objectContaining({
        id: "persisted-session",
        title: "历史会话",
        status: "interrupted",
      }),
    ]);
    expect(manager.getTerminalSnapshot("persisted-session").data).toContain(
      "/resume",
    );
    expect(manager.renameSession("persisted-session", "继续排查").title).toBe(
      "继续排查",
    );
  });
});
