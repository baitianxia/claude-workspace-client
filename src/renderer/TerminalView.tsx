import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef } from "react";
import type { SessionRecord, TerminalDataEvent } from "../shared/contracts";
import { consumeTerminalShortcut } from "../shared/terminal-shortcuts";

interface TerminalViewProps {
  session: SessionRecord;
  active: boolean;
}

export function TerminalView({ session, active }: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);

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
      theme: {
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
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(container);
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

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
      terminal.write(event.data);
    });

    void window.claudeWorkspace
      .getTerminalSnapshot(session.id)
      .then((snapshot) => {
        if (disposed) {
          return;
        }
        terminal.write(snapshot.data);
        lastSequence = snapshot.lastSequence;
        initialized = true;
        pendingEvents
          .sort((left, right) => left.sequence - right.sequence)
          .forEach((event) => {
            if (event.sequence > lastSequence) {
              lastSequence = event.sequence;
              terminal.write(event.data);
            }
          });
        pendingEvents.length = 0;
      })
      .catch((error: unknown) => {
        if (!disposed) {
          terminal.writeln(`\r\n\x1b[31m无法读取终端内容：${String(error)}\x1b[0m`);
        }
      });

    const inputDisposable = terminal.onData((data) => {
      window.claudeWorkspace.writeTerminal({ sessionId: session.id, data });
    });

    const copySelection = () => {
      const selection = terminal.getSelection();
      if (!selection) {
        return;
      }
      void window.claudeWorkspace
        .writeClipboardText(selection)
        .catch(() => undefined);
    };

    const pasteClipboard = () => {
      void window.claudeWorkspace
        .readClipboardText()
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
      inputDisposable.dispose();
      unsubscribe();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [session.id]);

  useEffect(() => {
    if (!active) {
      return;
    }
    const timer = window.setTimeout(() => {
      const terminal = terminalRef.current;
      const fitAddon = fitAddonRef.current;
      const container = containerRef.current;
      if (!terminal || !fitAddon || !container || container.clientWidth < 40) {
        return;
      }
      fitAddon.fit();
      window.claudeWorkspace.resizeTerminal({
        sessionId: session.id,
        columns: terminal.cols,
        rows: terminal.rows,
      });
      terminal.focus();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [active, session.id]);

  return (
    <div
      className={`terminal-view ${active ? "terminal-view--active" : ""}`}
      aria-hidden={!active}
    >
      <div
        className="terminal-canvas"
        ref={containerRef}
        title="选中文本后按 Ctrl+C 或右键复制；按 Ctrl+V 粘贴"
      />
      {session.status !== "running" && session.status !== "starting" ? (
        <div className="terminal-status-banner">
          {session.status === "failed"
            ? `启动失败：${session.error ?? "未知错误"}`
            : session.status === "interrupted"
              ? "客户端上次关闭后，该会话已中断。Claude Code 对话仍可通过 /resume 恢复。"
              : `会话已退出${session.exitCode === undefined ? "" : `（代码 ${session.exitCode}）`}`}
        </div>
      ) : null}
    </div>
  );
}
