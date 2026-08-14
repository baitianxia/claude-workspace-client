import { describe, expect, it, vi } from "vitest";
import type { IPty } from "node-pty";
import type { ProjectRecord } from "../src/shared/contracts";
import {
  SessionManager,
  type PtySpawner,
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

function project(): ProjectRecord {
  return {
    id: "project-one",
    name: "mall",
    pinned: false,
    rootPath: "C:\\work\\mall",
    createdAt: 1,
    lastOpenedAt: 1,
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

  it("forwards terminal input, output, resize and exit state", () => {
    const fake = fakePty();
    const manager = new SessionManager(
      () => "/usr/local/bin/claude",
      (() => fake.process) as PtySpawner,
      "darwin",
    );
    const changed = vi.fn();
    manager.on("changed", changed);
    const session = manager.createSession(project());

    manager.write(session.id, "hello\r");
    manager.resize(session.id, 10, 999);
    fake.emitData("Claude Code\r\n");

    expect(fake.writes).toEqual(["hello\r"]);
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
