import { FitAddon } from "@xterm/addon-fit";
import { Terminal, type ITheme } from "@xterm/xterm";
import { useEffect, useRef } from "react";
import type {
  AppTheme,
  SessionRecord,
  TerminalDataEvent,
} from "../shared/contracts";
import { consumeTerminalShortcut } from "../shared/terminal-shortcuts";
import { TerminalOutputScheduler } from "./terminal-output-scheduler";

interface TerminalViewProps {
  session: SessionRecord;
  active: boolean;
  focusRequest: number;
  theme: AppTheme;
}

const TERMINAL_THEMES: Record<AppTheme, ITheme> = {
  dark: {
    background: "#171614",
    foreground: "#e7e1d8",
    cursor: "#d97757",
    cursorAccent: "#171614",
    selectionBackground: "#66504688",
    black: "#26231f",
    red: "#d2685e",
    green: "#8fa66b",
    yellow: "#d3a254",
    blue: "#7797b7",
    magenta: "#a783a5",
    cyan: "#72a6a0",
    white: "#ddd7ce",
    brightBlack: "#706a62",
    brightRed: "#e27b70",
    brightGreen: "#a4bc7c",
    brightYellow: "#e5b76b",
    brightBlue: "#8eafd0",
    brightMagenta: "#bd99bb",
    brightCyan: "#8abdb6",
    brightWhite: "#f7f2eb",
  },
  light: {
    background: "#ffffff",
    foreground: "#292724",
    cursor: "#a94f2f",
    cursorAccent: "#ffffff",
    selectionBackground: "#c9d8e8",
    black: "#292724",
    red: "#b33b32",
    green: "#4c712e",
    yellow: "#8a5a05",
    blue: "#2d5f92",
    magenta: "#7a4d7d",
    cyan: "#1f6d6a",
    white: "#f4f2ee",
    brightBlack: "#6f6a64",
    brightRed: "#c24c42",
    brightGreen: "#5e873b",
    brightYellow: "#a36d09",
    brightBlue: "#3d73ad",
    brightMagenta: "#955e98",
    brightCyan: "#2a8580",
    brightWhite: "#ffffff",
  },
};

export function TerminalView({
  session,
  active,
  focusRequest,
  theme,
}: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const activeRef = useRef(active);
  const focusPendingRef = useRef(false);
  const themeRef = useRef(theme);
  activeRef.current = active;
  themeRef.current = theme;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const terminal = new Terminal({
      allowProposedApi: false,
      convertEol: false,
      cursorBlink: true,
      cursorStyle: "block",
      fontFamily: '"Cascadia Mono", "SFMono-Regular", Consolas, monospace',
      fontSize: 14,
      lineHeight: 1.28,
      letterSpacing: 0,
      scrollback: 12_000,
      theme: TERMINAL_THEMES[themeRef.current],
      // Claude Code uses bright white and arbitrary ANSI colors for emphasis.
      // Keep those cells readable when the light palette has a white background.
      minimumContrastRatio: themeRef.current === "light" ? 4.5 : 1,
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(container);
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    const outputScheduler = new TerminalOutputScheduler(
      {
        write: (data, callback) => terminal.write(data, callback),
      },
      (callback) => {
        window.requestAnimationFrame(callback);
      },
      () => activeRef.current && !document.hidden,
    );

    let disposed = false;
    let initialized = false;
    let lastSequence = 0;
    const pendingEvents: TerminalDataEvent[] = [];

    const unsubscribe = window.claudeWorkspace.onTerminalData((event) => {
      if (event.sessionId !== session.id || event.sequence <= lastSequence) {
        return;
      }
      if (!initialized) {
        pendingEvents.push(event);
        return;
      }
      lastSequence = event.sequence;
      outputScheduler.write(event.data);
    });

    const initializeLiveOutput = (snapshotSequence: number) => {
      if (disposed) {
        return;
      }
      lastSequence = snapshotSequence;
      initialized = true;
      pendingEvents
        .sort((left, right) => left.sequence - right.sequence)
        .forEach((event) => {
          if (event.sequence > lastSequence) {
            lastSequence = event.sequence;
            outputScheduler.write(event.data);
          }
        });
      pendingEvents.length = 0;
    };

    void window.claudeWorkspace
      .getTerminalSnapshot(session.id)
      .then((snapshot) => {
        if (disposed) {
          return;
        }
        if (!snapshot.data) {
          initializeLiveOutput(snapshot.lastSequence);
          return;
        }
        terminal.write(snapshot.data, () => {
          initializeLiveOutput(snapshot.lastSequence);
        });
      })
      .catch((error: unknown) => {
        if (!disposed) {
          terminal.writeln(
            `\r\n\x1b[31m无法读取终端内容：${String(error)}\x1b[0m`,
            () => initializeLiveOutput(0),
          );
        }
      });

    const inputDisposable = terminal.onData((data) => {
      window.claudeWorkspace.writeTerminal({ sessionId: session.id, data });
    });

    // Clipboard writes are asynchronous in the main process. Serialize them
    // so a quick Ctrl/Cmd+C followed by Ctrl/Cmd+V always reads the new text.
    let clipboardWritePromise: Promise<void> = Promise.resolve();

    const copySelection = () => {
      const selection = terminal.getSelection();
      if (!selection) {
        return;
      }
      clipboardWritePromise = clipboardWritePromise
        .catch(() => undefined)
        .then(() => window.claudeWorkspace.writeClipboardText(selection));
    };

    const pasteClipboard = () => {
      void clipboardWritePromise
        .catch(() => undefined)
        .then(() => window.claudeWorkspace.readClipboardText())
        .then((text) => {
          if (!disposed && text) {
            terminal.paste(text);
          }
        })
        .catch(() => undefined);
    };

    terminal.attachCustomKeyEventHandler((event) => {
      const action = consumeTerminalShortcut(event, terminal.hasSelection());
      if (action === "copy") {
        copySelection();
        return false;
      }
      if (action === "paste") {
        pasteClipboard();
        return false;
      }
      return action !== "suppress";
    });

    const handleContextMenu = (event: MouseEvent) => {
      event.preventDefault();
      if (terminal.hasSelection()) {
        copySelection();
      }
    };
    container.addEventListener("contextmenu", handleContextMenu);

    // xterm normally owns the paste event on its hidden textarea. Capturing it
    // at the canvas keeps multiline clipboard text intact when the browser or
    // an IME dispatches a native paste event before xterm's listener runs.
    const handlePaste = (event: ClipboardEvent) => {
      const text = event.clipboardData?.getData("text/plain") ?? "";
      event.preventDefault();
      event.stopPropagation();
      if (!disposed && text) {
        terminal.paste(text);
      } else if (!disposed) {
        // Some Windows clipboard providers do not expose text on the native
        // event. Fall back to the same serialized read used by Ctrl+V rather
        // than allowing xterm and the browser to race with two paste paths.
        pasteClipboard();
      }
    };
    container.addEventListener("paste", handlePaste, true);

    const resizeTerminal = () => {
      if (container.clientWidth < 40 || container.clientHeight < 40) {
        return;
      }
      try {
        fitAddon.fit();
        window.claudeWorkspace.resizeTerminal({
          sessionId: session.id,
          columns: terminal.cols,
          rows: terminal.rows,
        });
        if (activeRef.current && focusPendingRef.current) {
          terminal.focus();
          focusPendingRef.current = false;
        }
      } catch {
        // Ignore transient layout changes while switching tabs.
      }
    };
    const observer = new ResizeObserver(resizeTerminal);
    observer.observe(container);
    resizeTerminal();

    return () => {
      disposed = true;
      observer.disconnect();
      container.removeEventListener("contextmenu", handleContextMenu);
      container.removeEventListener("paste", handlePaste, true);
      inputDisposable.dispose();
      unsubscribe();
      outputScheduler.dispose();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [session.id]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (terminal) {
      terminal.options.theme = TERMINAL_THEMES[theme];
      terminal.options.minimumContrastRatio = theme === "light" ? 4.5 : 1;
    }
  }, [theme]);

  useEffect(() => {
    if (!active) {
      focusPendingRef.current = false;
      terminalRef.current?.blur();
      return;
    }
    focusPendingRef.current = true;
    const timer = window.setTimeout(() => {
      const terminal = terminalRef.current;
      const fitAddon = fitAddonRef.current;
      const container = containerRef.current;
      if (!terminal || !fitAddon || !container || container.clientWidth < 40) {
        return;
      }
      try {
        fitAddon.fit();
        window.claudeWorkspace.resizeTerminal({
          sessionId: session.id,
          columns: terminal.cols,
          rows: terminal.rows,
        });
        terminal.focus();
        focusPendingRef.current = false;
      } catch {
        // ResizeObserver will retry after transient tab layout changes settle.
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [active, focusRequest, session.id]);

  return (
    <div
      className={`terminal-view ${active ? "terminal-view--active" : ""}`}
      aria-hidden={!active}
    >
      <div
        className="terminal-canvas"
        ref={containerRef}
        title="选中文本后按 Ctrl+C 或右键复制；按 Ctrl+V 粘贴。大段内容可能显示为 [Pasted text #N +… lines]；普通提示提交时仍会保留完整内容。"
      />
      {session.status !== "running" && session.status !== "starting" ? (
        <div className="terminal-status-banner">
          {session.status === "failed"
            ? `启动失败：${session.error ?? "未知错误"}。可在右上角重启此会话。`
            : session.status === "interrupted"
              ? "客户端上次关闭后，该会话已中断。可在右上角重启，并通过 /resume 恢复 Claude Code 对话。"
              : `会话已退出${session.exitCode === undefined ? "" : `（代码 ${session.exitCode}）`}。可在右上角重启此会话。`}
        </div>
      ) : null}
    </div>
  );
}
