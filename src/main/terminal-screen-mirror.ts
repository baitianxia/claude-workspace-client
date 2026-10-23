/**
 * A main-process mirror of what each Claude Code terminal shows.
 *
 * Remote replies, menu capture and the Hook fallback all need the rows the
 * terminal is displaying *now*. Reading them from the renderer's xterm works
 * only while a window exists and its timers run, and it arrives through IPC
 * some time after the output did. Feeding the same PTY bytes into a headless
 * xterm in the main process gives the same rows (same parser, same size,
 * same Unicode tables) without that dependency, and in the same tick the
 * bytes are parsed.
 *
 * `@xterm/headless` is loaded lazily: when it is not installed the session
 * manager keeps using the renderer's reports, so the feature degrades
 * instead of breaking the app.
 */

export interface MirroredScreen {
  lines: string[];
  viewportY: number;
  rows: number;
  columns: number;
}

/** The slice of @xterm/headless's Terminal that the mirror relies on. */
export interface ScreenMirrorTerminal {
  readonly rows: number;
  readonly cols: number;
  readonly buffer: {
    readonly active: {
      readonly baseY: number;
      getLine(y: number):
        | { translateToString(trimRight?: boolean): string }
        | undefined;
    };
  };
  write(data: string, callback?: () => void): void;
  resize(columns: number, rows: number): void;
  dispose(): void;
}

export type ScreenMirrorFactory = (
  columns: number,
  rows: number,
) => ScreenMirrorTerminal;

/**
 * Create terminals with @xterm/headless, or return null when the package is
 * not installed. The renderer's xterm must be configured the same way for
 * both to lay text out identically (see TerminalView: no Unicode 11 addon,
 * convertEol off).
 */
export function loadHeadlessTerminalFactory(): ScreenMirrorFactory | null {
  const moduleName = "@xterm/headless";
  let headless: { Terminal: new (options: Record<string, unknown>) => ScreenMirrorTerminal };
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    headless = require(moduleName) as typeof headless;
  } catch {
    return null;
  }
  if (typeof headless?.Terminal !== "function") {
    return null;
  }
  return (columns, rows) =>
    new headless.Terminal({
      cols: columns,
      rows,
      // Menus are at the bottom of the screen; history is not needed.
      scrollback: 500,
      allowProposedApi: false,
      convertEol: false,
    });
}

export class TerminalScreenMirror {
  private disposed = false;

  constructor(private readonly terminal: ScreenMirrorTerminal) {}

  /**
   * Feed PTY output. `onParsed` runs once these bytes have been applied to
   * the screen, with the rows as they are at that moment.
   */
  write(data: string, onParsed: (screen: MirroredScreen) => void): void {
    if (this.disposed) {
      return;
    }
    this.terminal.write(data, () => {
      if (!this.disposed) {
        onParsed(this.snapshot());
      }
    });
  }

  resize(columns: number, rows: number): void {
    if (this.disposed) {
      return;
    }
    if (this.terminal.cols !== columns || this.terminal.rows !== rows) {
      this.terminal.resize(columns, rows);
    }
  }

  /** The bottom screen, where Claude Code draws its prompts. */
  snapshot(): MirroredScreen {
    const buffer = this.terminal.buffer.active;
    const viewportY = Math.max(0, buffer.baseY);
    const rows = this.terminal.rows;
    const lines = Array.from(
      { length: rows },
      (_, offset) => buffer.getLine(viewportY + offset)?.translateToString(true) ?? "",
    );
    return { lines, viewportY, rows, columns: this.terminal.cols };
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    try {
      this.terminal.dispose();
    } catch (error) {
      console.error("Failed to dispose terminal screen mirror", error);
    }
  }
}
