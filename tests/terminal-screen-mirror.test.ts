import type { IPty } from "node-pty";
import { describe, expect, it, vi } from "vitest";
import { SessionManager, type PtySpawner } from "../src/main/session-manager";
import {
  loadHeadlessTerminalFactory,
  TerminalScreenMirror,
  type ScreenMirrorTerminal,
} from "../src/main/terminal-screen-mirror";

interface FakePty {
  process: IPty;
  emitData(data: string): void;
  emitExit(exitCode: number): void;
  resizes: Array<[number, number]>;
}

function fakePty(): FakePty {
  let dataListener: (data: string) => void = () => undefined;
  let exitListener: (event: { exitCode: number; signal?: number }) => void = () =>
    undefined;
  const resizes: Array<[number, number]> = [];
  return {
    process: {
      pid: 1,
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
      write: () => undefined,
      resize: (columns, rows) => {
        resizes.push([columns, rows]);
      },
      clear: () => undefined,
      pause: () => undefined,
      resume: () => undefined,
      kill: () => undefined,
    },
    emitData: (data) => dataListener(data),
    emitExit: (exitCode) => exitListener({ exitCode, signal: 0 }),
    resizes,
  };
}

/**
 * A tiny line-based stand-in for a headless xterm: "\r\n" starts a new row,
 * everything else is appended to the current row. Enough to check the
 * plumbing; the real terminal is covered below when it is installed.
 */
function fakeTerminal(columns: number, rows: number) {
  const screen: string[] = [""];
  let disposed = false;
  const terminal: ScreenMirrorTerminal & { disposed: () => boolean; resizes: Array<[number, number]> } = {
    rows,
    cols: columns,
    resizes: [],
    disposed: () => disposed,
    buffer: {
      active: {
        get baseY() {
          return Math.max(0, screen.length - terminal.rows);
        },
        getLine: (y: number) =>
          y < screen.length ? { translateToString: () => screen[y] } : undefined,
      },
    },
    write(data, callback) {
      // Parse asynchronously like xterm does.
      setTimeout(() => {
        const parts = data.split("\r\n");
        parts.forEach((part, index) => {
          screen[screen.length - 1] += part;
          if (index < parts.length - 1) {
            screen.push("");
          }
        });
        callback?.();
      }, 0);
    },
    resize(nextColumns, nextRows) {
      terminal.resizes.push([nextColumns, nextRows]);
      (terminal as { cols: number }).cols = nextColumns;
      (terminal as { rows: number }).rows = nextRows;
    },
    dispose() {
      disposed = true;
    },
  };
  return terminal;
}

describe("TerminalScreenMirror in SessionManager", () => {
  it("publishes the mirrored rows for every output and ignores renderer reports", async () => {
    const pty = fakePty();
    const terminals: ReturnType<typeof fakeTerminal>[] = [];
    const manager = new SessionManager(
      () => "claude",
      (() => pty.process) as PtySpawner,
      "linux",
      [],
      undefined,
      undefined,
      undefined,
      (columns, rows) => {
        const terminal = fakeTerminal(columns, rows);
        terminals.push(terminal);
        return terminal;
      },
    );
    const session = manager.createSession({ projectId: null, cwd: "/work" });
    expect(manager.hasScreenMirror(session.id)).toBe(true);
    expect(terminals).toHaveLength(1);

    const reports: number[] = [];
    manager.on("terminalVisibleLines", (request) => reports.push(request.sequence));
    pty.emitData("Do you want to proceed?\r\n❯ 1. Yes\r\n  2. No");
    await vi.waitFor(() => expect(reports).toEqual([1]));
    expect(manager.getTerminalVisibleLines(session.id)).toMatchObject({
      sessionId: session.id,
      sequence: 1,
      lines: expect.arrayContaining(["Do you want to proceed?", "❯ 1. Yes", "  2. No"]),
      columns: 120,
      rows: 36,
    });

    // The renderer's own report is not allowed to override the mirror.
    manager.setTerminalVisibleLines({
      sessionId: session.id,
      sequence: 1,
      lines: ["something else"],
      viewportY: 0,
      rows: 1,
      columns: 80,
    });
    expect(manager.getTerminalVisibleLines(session.id)?.lines).toContain("❯ 1. Yes");

    // Resizes reach the PTY and the mirror alike.
    manager.resize(session.id, 100, 30);
    expect(pty.resizes).toEqual([[100, 30]]);
    expect(terminals[0].resizes).toEqual([[100, 30]]);

    // Waiting for a newer screen resolves as soon as the mirror parsed it.
    const waiting = manager.waitForTerminalVisibleLines(session.id, 2, 1_000);
    pty.emitData("\r\n  3. Maybe");
    await expect(waiting).resolves.toMatchObject({ sequence: 2 });

    pty.emitExit(0);
    expect(terminals[0].disposed()).toBe(true);
    expect(manager.hasScreenMirror(session.id)).toBe(false);
    expect(manager.getTerminalVisibleLines(session.id)).toBeUndefined();
  });

  it("falls back to renderer reports when no mirror factory is available", () => {
    const pty = fakePty();
    const manager = new SessionManager(
      () => "claude",
      (() => pty.process) as PtySpawner,
      "linux",
    );
    const session = manager.createSession({ projectId: null, cwd: "/work" });
    expect(manager.hasScreenMirror(session.id)).toBe(false);
    pty.emitData("❯ 1. Yes\r\n");
    manager.setTerminalVisibleLines({
      sessionId: session.id,
      sequence: 1,
      lines: ["❯ 1. Yes"],
      viewportY: 0,
      rows: 1,
      columns: 120,
    });
    expect(manager.getTerminalVisibleLines(session.id)?.lines).toEqual(["❯ 1. Yes"]);
  });
});

describe("TerminalScreenMirror with @xterm/headless", () => {
  const factory = loadHeadlessTerminalFactory();

  it.skipIf(!factory)("renders Claude Code's menu redraws like the renderer does", async () => {
    const mirror = new TerminalScreenMirror(factory!(60, 8));
    const screens: string[][] = [];
    const written = (data: string) =>
      new Promise<void>((resolve) =>
        mirror.write(data, (screen) => {
          screens.push(screen.lines);
          resolve();
        }),
      );
    await written("Do you want to proceed?\r\n\x1b[36m❯\x1b[39m 1. Yes\r\n  2. No\r\n");
    // Ink redraws the menu in place: move up two rows, clear, draw again.
    await written("\x1b[2A\x1b[2K  1. Yes\r\n\x1b[2K\x1b[36m❯\x1b[39m 2. No\r\n");
    const last = screens[screens.length - 1];
    expect(last.slice(0, 3)).toEqual(["Do you want to proceed?", "  1. Yes", "❯ 2. No"]);
    mirror.dispose();
  });
});
