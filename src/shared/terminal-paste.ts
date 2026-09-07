/**
 * xterm.js wraps clipboard input with these markers when the child terminal
 * has enabled bracketed-paste mode. Keep the markers intact while throttling
 * the payload so ConPTY/node-pty cannot lose a burst of input.
 */
export const BRACKETED_PASTE_START = "\u001b[200~";
export const BRACKETED_PASTE_END = "\u001b[201~";

/**
 * A PTY write is deliberately kept below the size at which Windows terminal
 * input buffers have historically become lossy. The value is measured in
 * UTF-8 bytes, not JavaScript UTF-16 code units.
 */
export const TERMINAL_PASTE_CHUNK_BYTES = 512;

/**
 * A small pause gives ConPTY and Ink a chance to consume each write. This is
 * only used between chunks of a paste; ordinary keystrokes remain immediate.
 */
export const TERMINAL_PASTE_CHUNK_DELAY_MS = 8;

/**
 * Plain input above this size is treated as a paste as a fallback for shells
 * that do not enable bracketed-paste mode.
 */
export const TERMINAL_PASTE_DETECTION_BYTES = 1_024;

function utf8BytesForCodePoint(codePoint: number): number {
  if (codePoint <= 0x7f) {
    return 1;
  }
  if (codePoint <= 0x7ff) {
    return 2;
  }
  if (codePoint <= 0xffff) {
    return 3;
  }
  return 4;
}

function terminalTokenAt(value: string, index: number): string {
  const character = value[index];
  if (character !== "\u001b") {
    const codePoint = value.codePointAt(index) ?? 0;
    return value.slice(index, index + (codePoint > 0xffff ? 2 : 1));
  }

  // Keep CSI/OSC sequences together. Splitting an ANSI sequence between two
  // PTY writes can turn harmless copied styling into an actual key binding.
  const next = value[index + 1];
  if (next === "[") {
    for (let cursor = index + 2; cursor < value.length; cursor += 1) {
      const code = value.charCodeAt(cursor);
      if (code >= 0x40 && code <= 0x7e) {
        return value.slice(index, cursor + 1);
      }
    }
    return value.slice(index);
  }
  if (next === "]") {
    for (let cursor = index + 2; cursor < value.length; cursor += 1) {
      if (value[cursor] === "\u0007") {
        return value.slice(index, cursor + 1);
      }
      if (value[cursor] === "\u001b" && value[cursor + 1] === "\\") {
        return value.slice(index, cursor + 2);
      }
    }
    return value.slice(index);
  }
  if (next === undefined) {
    return character;
  }
  const nextCodePoint = value.codePointAt(index + 1) ?? 0;
  return value.slice(index, index + 1 + (nextCodePoint > 0xffff ? 2 : 1));
}

/** Return the UTF-8 byte length without relying on a Node-only global. */
export function utf8ByteLength(value: string): number {
  let length = 0;
  for (const character of value) {
    length += utf8BytesForCodePoint(character.codePointAt(0) ?? 0);
  }
  return length;
}

export function isBracketedPaste(value: string): boolean {
  return (
    value.includes(BRACKETED_PASTE_START) ||
    value.includes(BRACKETED_PASTE_END)
  );
}

export function shouldThrottleTerminalInput(value: string): boolean {
  return (
    isBracketedPaste(value) ||
    utf8ByteLength(value) > TERMINAL_PASTE_DETECTION_BYTES
  );
}

/**
 * Split a terminal paste into ordered writes.
 *
 * Bracketed-paste delimiters are emitted as their own chunks. Text chunks are
 * split on Unicode code-point boundaries and never exceed `maxBytes` when
 * encoded as UTF-8. This keeps CJK text and emoji intact across PTY writes.
 */
export function splitTerminalPaste(
  value: string,
  maxBytes = TERMINAL_PASTE_CHUNK_BYTES,
): string[] {
  if (!value) {
    return [];
  }
  if (!Number.isInteger(maxBytes) || maxBytes < 1) {
    throw new Error("Terminal paste chunk size must be a positive integer.");
  }

  const chunks: string[] = [];
  const appendText = (text: string) => {
    let current = "";
    let currentBytes = 0;
    let cursor = 0;
    while (cursor < text.length) {
      const token = terminalTokenAt(text, cursor);
      const tokenBytes = utf8ByteLength(token);
      if (current && currentBytes + tokenBytes > maxBytes) {
        chunks.push(current);
        current = "";
        currentBytes = 0;
      }
      current += token;
      currentBytes += tokenBytes;
      cursor += token.length;
    }
    if (current) {
      chunks.push(current);
    }
  };

  let cursor = 0;
  while (cursor < value.length) {
    const start = value.indexOf(BRACKETED_PASTE_START, cursor);
    const end = value.indexOf(BRACKETED_PASTE_END, cursor);
    const markerIndex = [start, end]
      .filter((index) => index >= 0)
      .sort((left, right) => left - right)[0];

    if (markerIndex === undefined) {
      appendText(value.slice(cursor));
      break;
    }
    if (markerIndex > cursor) {
      appendText(value.slice(cursor, markerIndex));
    }

    if (start >= 0 && start === markerIndex && (end < 0 || start < end)) {
      chunks.push(BRACKETED_PASTE_START);
      cursor = start + BRACKETED_PASTE_START.length;
    } else {
      chunks.push(BRACKETED_PASTE_END);
      cursor = end + BRACKETED_PASTE_END.length;
    }
  }

  return chunks;
}
