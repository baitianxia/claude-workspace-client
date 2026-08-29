const SYNCHRONIZED_OUTPUT_END = "\u001b[?2026l";

export interface TerminalOutputTarget {
  write(data: string, callback: () => void): void;
}

export type FrameScheduler = (callback: () => void) => void;

function trailingMarkerPrefixLength(data: string): number {
  const maximum = Math.min(data.length, SYNCHRONIZED_OUTPUT_END.length - 1);
  for (let length = maximum; length > 0; length -= 1) {
    if (SYNCHRONIZED_OUTPUT_END.startsWith(data.slice(-length))) {
      return length;
    }
  }
  return 0;
}

/**
 * Keeps the start of a new synchronized-output frame from overtaking the
 * browser paint requested by the previous frame's DEC 2026 close sequence.
 *
 * xterm 6.0 defers that paint to requestAnimationFrame. If Claude Code starts
 * its next frame first, xterm drops the paint while synchronization is active,
 * which can leave input edits and the cursor stale until its one-second safety
 * timeout. PTY chunks can split the close sequence, so the boundary detector
 * also retains a possible marker suffix until the following chunk arrives.
 */
export class TerminalOutputScheduler {
  private pending = "";
  private writing = false;
  private waitingForFrame = false;
  private disposed = false;

  constructor(
    private readonly target: TerminalOutputTarget,
    private readonly scheduleFrame: FrameScheduler,
    private readonly shouldWaitForFrame: () => boolean,
  ) {}

  write(data: string): void {
    if (this.disposed || !data) {
      return;
    }
    this.pending += data;
    this.flush();
  }

  dispose(): void {
    this.disposed = true;
    this.pending = "";
  }

  private flush(): void {
    if (
      this.disposed ||
      this.writing ||
      this.waitingForFrame ||
      !this.pending
    ) {
      return;
    }

    const waitForFrame = this.shouldWaitForFrame();
    const markerIndex = waitForFrame
      ? this.pending.indexOf(SYNCHRONIZED_OUTPUT_END)
      : -1;
    let endsSynchronizedFrame = false;
    let writeLength: number;

    if (markerIndex >= 0) {
      writeLength = markerIndex + SYNCHRONIZED_OUTPUT_END.length;
      endsSynchronizedFrame = true;
    } else {
      writeLength =
        this.pending.length - trailingMarkerPrefixLength(this.pending);
    }

    if (writeLength === 0) {
      return;
    }

    const data = this.pending.slice(0, writeLength);
    this.pending = this.pending.slice(writeLength);
    this.writing = true;
    try {
      this.target.write(data, () => {
        this.writing = false;
        if (this.disposed) {
          return;
        }
        if (endsSynchronizedFrame && this.shouldWaitForFrame()) {
          this.waitingForFrame = true;
          this.scheduleFrame(() => {
            this.waitingForFrame = false;
            this.flush();
          });
          return;
        }
        this.flush();
      });
    } catch (error) {
      this.writing = false;
      throw error;
    }
  }
}
