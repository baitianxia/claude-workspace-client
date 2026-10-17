// Search this far into the oldest retained output for a safe place to start.
const ALIGN_WINDOW_LENGTH = 64_000;
// Merge chunks occasionally so a long-running session does not keep an
// unbounded array of tiny PTY writes.
const MAX_CHUNK_COUNT = 2_048;
const RESET_ATTRIBUTES = "\u001b[0m";

/**
 * Bounded scrollback for one terminal session.
 *
 * Output is stored as a list of chunks instead of one string that is copied
 * on every PTY write. When the limit is exceeded the oldest output is
 * dropped, and the new start is moved to the next line break (or escape
 * sequence) so a replayed snapshot never begins in the middle of an ANSI
 * escape sequence and shows stray characters.
 */
export class TerminalBuffer {
  private chunks: string[] = [];
  private length = 0;
  private truncated = false;

  constructor(
    private readonly maxLength: number,
    initial = "",
  ) {
    this.append(initial);
  }

  append(data: string): void {
    if (!data) {
      return;
    }
    this.chunks.push(data);
    this.length += data.length;
    if (this.chunks.length > MAX_CHUNK_COUNT) {
      this.chunks = [this.chunks.join("")];
    }
    if (this.length <= this.maxLength) {
      return;
    }
    this.truncated = true;
    while (
      this.chunks.length > 1 &&
      this.length - this.chunks[0].length >= this.maxLength
    ) {
      this.length -= this.chunks.shift()?.length ?? 0;
    }
    if (this.length > this.maxLength) {
      const excess = this.length - this.maxLength;
      this.chunks[0] = this.chunks[0].slice(excess);
      this.length -= excess;
    }
    this.alignStart();
  }

  /** Snapshot for replay into a fresh xterm instance. */
  toString(): string {
    const content = this.chunks.join("");
    if (this.chunks.length > 1) {
      this.chunks = [content];
    }
    return this.truncated ? `${RESET_ATTRIBUTES}${content}` : content;
  }

  /** The last `length` characters, without joining the whole buffer. */
  tail(length: number): string {
    const parts: string[] = [];
    let remaining = Math.max(0, length);
    for (let index = this.chunks.length - 1; index >= 0 && remaining > 0; index -= 1) {
      const chunk = this.chunks[index];
      parts.push(chunk.length <= remaining ? chunk : chunk.slice(-remaining));
      remaining -= chunk.length;
    }
    return parts.reverse().join("");
  }

  get size(): number {
    return this.length;
  }

  private alignStart(): void {
    const first = this.chunks[0];
    if (!first) {
      return;
    }
    const window = first.slice(0, ALIGN_WINDOW_LENGTH);
    const newline = window.indexOf("\n");
    const escape = window.indexOf("\u001b");
    const start =
      newline >= 0 ? newline + 1 : escape > 0 ? escape : 0;
    if (start <= 0) {
      return;
    }
    this.chunks[0] = first.slice(start);
    this.length -= start;
    if (!this.chunks[0] && this.chunks.length > 1) {
      this.chunks.shift();
    }
  }
}
