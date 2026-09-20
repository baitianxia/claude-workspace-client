import { describe, expect, it, vi } from "vitest";
import type { IPty } from "node-pty";
import {
  SessionManager,
  type PtySpawner,
  type SessionWorkspace,
} from "../src/main/session-manager";
import {
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_START,
  utf8ByteLength,
} from "../src/shared/terminal-paste";

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

  it("only skips permissions for the session that explicitly opts in", () => {
    const spawner = vi.fn(() => fakePty().process) as PtySpawner;
    const manager = new SessionManager(
      () => "/usr/local/bin/claude",
      spawner,
      "darwin",
    );

    const optedIn = manager.createSession(project(), undefined, true);
    const defaultSession = manager.createSession(project());
    const normalSession = manager.createSession(project(), undefined, false);

    expect(optedIn.skipPermissions).toBe(true);
    expect(defaultSession.skipPermissions).not.toBe(true);
    expect(normalSession.skipPermissions).not.toBe(true);
    expect(spawner).toHaveBeenNthCalledWith(
      1,
      "/usr/local/bin/claude",
      ["--dangerously-skip-permissions"],
      expect.objectContaining({ cwd: optedIn.cwd }),
    );
    for (const call of [2, 3]) {
      expect(spawner).toHaveBeenNthCalledWith(
        call,
        "/usr/local/bin/claude",
        [],
        expect.objectContaining({ cwd: defaultSession.cwd }),
      );
    }
  });

  it("writes remote picker keys as separate PTY events", async () => {
    const fake = fakePty();
    const manager = new SessionManager(
      () => "C:\\Tools\\claude.exe",
      (() => fake.process) as PtySpawner,
      "win32",
    );
    const session = manager.createSession(project());

    await expect(
      manager.writeRemoteReplySequence(session.id, ["\x1b[B", "\r", "\r"]),
    ).resolves.toBe(true);
    expect(fake.writes).toEqual(["\x1b[B", "\r", "\r"]);
  });

  it("throttles large bracketed pastes without dropping Unicode text", async () => {
    const fake = fakePty();
    const manager = new SessionManager(
      () => "C:\\Tools\\claude.exe",
      (() => fake.process) as PtySpawner,
      "win32",
    );
    const session = manager.createSession(project());
    const pasted = `${BRACKETED_PASTE_START}${"第一行🙂\r第二行\r".repeat(
      90,
    )}${BRACKETED_PASTE_END}`;

    manager.write(session.id, pasted);
    await new Promise<void>((resolve) => setTimeout(resolve, 120));

    expect(fake.writes.join("")).toBe(pasted);
    expect(fake.writes[0]).toBe(BRACKETED_PASTE_START);
    expect(fake.writes.at(-1)).toBe(BRACKETED_PASTE_END);
    expect(
      fake.writes
        .filter(
          (chunk) =>
            chunk !== BRACKETED_PASTE_START && chunk !== BRACKETED_PASTE_END,
        )
        .every((chunk) => utf8ByteLength(chunk) <= 512),
    ).toBe(true);
  });

  it("uses the same lossless chunks for terminals without bracketed paste", async () => {
    const fake = fakePty();
    const manager = new SessionManager(
      () => "C:\\Tools\\claude.exe",
      (() => fake.process) as PtySpawner,
      "win32",
    );
    const session = manager.createSession(project());
    const pasted = "a".repeat(2_048);

    manager.write(session.id, pasted);
    await new Promise<void>((resolve) => setTimeout(resolve, 80));

    expect(fake.writes.join("")).toBe(pasted);
    expect(fake.writes.every((chunk) => utf8ByteLength(chunk) <= 512)).toBe(
      true,
    );
  });

  it("keeps keystrokes queued behind an in-flight paste", async () => {
    const fake = fakePty();
    const manager = new SessionManager(
      () => "C:\\Tools\\claude.exe",
      (() => fake.process) as PtySpawner,
      "win32",
    );
    const session = manager.createSession(project());
    const pasted = `${BRACKETED_PASTE_START}${"x".repeat(1_600)}${BRACKETED_PASTE_END}`;

    manager.write(session.id, pasted);
    manager.write(session.id, "after");
    await new Promise<void>((resolve) => setTimeout(resolve, 120));

    expect(fake.writes.join("")).toBe(`${pasted}after`);
    expect(fake.writes.at(-1)).toBe("after");
  });

  it("does not replay a cancelled paste into a restarted process", async () => {
    const first = fakePty();
    const second = fakePty();
    const spawner = vi
      .fn()
      .mockReturnValueOnce(first.process)
      .mockReturnValueOnce(second.process) as unknown as PtySpawner;
    const manager = new SessionManager(
      () => "C:\\Tools\\claude.exe",
      spawner,
      "win32",
    );
    const session = manager.createSession(project());
    const pasted = `${BRACKETED_PASTE_START}${"x".repeat(4_096)}${BRACKETED_PASTE_END}`;

    manager.write(session.id, pasted);
    first.emitExit(0);
    manager.restartSession(session.id);
    await new Promise<void>((resolve) => setTimeout(resolve, 80));

    expect(second.writes).toEqual([]);
  });

  it.each([false, true])(
    "applies per-launch Claude arguments and environment on restart with skipPermissions=%s",
    (skipPermissions) => {
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

      const created = manager.createSession(project(), undefined, skipPermissions);
      first.emitExit(0);
      const restarted = manager.restartSession(created.id);
      const permissionArgs = skipPermissions
        ? ["--dangerously-skip-permissions"]
        : [];

      expect(launchIds).toHaveLength(2);
      expect(launchIds[0]).not.toBe(launchIds[1]);
      expect(restarted.skipPermissions === true).toBe(skipPermissions);
      expect(spawner).toHaveBeenNthCalledWith(
        1,
        "C:\\Tools\\claude.exe",
        ["--settings", launchIds[0], ...permissionArgs],
        expect.objectContaining({
          env: expect.objectContaining({
            CLAUDE_WORKSPACE_HOOK_TOKEN: `token-${launchIds[0]}`,
          }),
        }),
      );
      expect(spawner).toHaveBeenNthCalledWith(
        2,
        "C:\\Tools\\claude.exe",
        ["--settings", launchIds[1], ...permissionArgs],
        expect.objectContaining({
          env: expect.objectContaining({
            CLAUDE_WORKSPACE_HOOK_TOKEN: `token-${launchIds[1]}`,
          }),
        }),
      );
    },
  );

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

  it("terminates the complete Windows process tree during shutdown", async () => {
    const fake = fakePty();
    const terminateTree = vi.fn(async () => undefined);
    const manager = new SessionManager(
      () => "C:\\Tools\\claude.exe",
      (() => fake.process) as PtySpawner,
      "win32",
      [],
      undefined,
      terminateTree,
    );
    manager.createSession(project());

    await manager.dispose();

    expect(terminateTree).toHaveBeenCalledExactlyOnceWith(42);
    expect(fake.killed).toBe(true);
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

  it.each([undefined, false, true])(
    "restores persisted labels and permission mode with skipPermissions=%s",
    (skipPermissions) => {
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
            ...(skipPermissions === undefined ? {} : { skipPermissions }),
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

      const restarted = manager.restartSession("persisted-session");

      expect(restarted.skipPermissions).toBe(skipPermissions);
      expect(spawner).toHaveBeenCalledWith(
        "C:\\Tools\\claude.exe",
        skipPermissions === true ? ["--dangerously-skip-permissions"] : [],
        expect.objectContaining({ cwd: "C:\\work\\mall" }),
      );
    },
  );
});
