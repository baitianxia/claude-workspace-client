/**
 * Split text into chunks whose UTF-8 encoded size is at most maxBytes.
 * Iterating over the string (rather than indexing UTF-16 code units) keeps
 * surrogate pairs together, so no chunk contains a partial Unicode code point.
 */
export function splitUtf8ByBytes(value: string, maxBytes: number): string[] {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error("maxBytes must be a positive safe integer.");
  }

  if (value.length === 0) {
    return [""];
  }

  const chunks: string[] = [];
  let chunk = "";
  let chunkBytes = 0;

  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (characterBytes > maxBytes) {
      throw new Error("maxBytes is smaller than one UTF-8 code point.");
    }
    if (chunk && chunkBytes + characterBytes > maxBytes) {
      chunks.push(chunk);
      chunk = "";
      chunkBytes = 0;
    }
    chunk += character;
    chunkBytes += characterBytes;
  }

  if (chunk || chunks.length === 0) {
    chunks.push(chunk);
  }
  return chunks;
}

const FENCE_PATTERN = /^ {0,3}(`{3,}|~{3,})(.*)$/u;
// Room kept in every chunk for a closing fence ("\n" + up to 15 markers).
const FENCE_CLOSE_RESERVE_BYTES = 16;
// Smallest size for which Markdown-aware splitting is attempted.
const MIN_MARKDOWN_CHUNK_BYTES = 256;

interface OpenFence {
  /** The opening line, re-emitted at the top of the next chunk. */
  opener: string;
  /** The fence characters, e.g. "```" or "~~~~". */
  marker: string;
}

/** Return the fence that is still open after `text`, starting from `open`. */
function fenceStateAfter(text: string, open: OpenFence | null): OpenFence | null {
  let state = open;
  for (const line of text.split("\n")) {
    const match = FENCE_PATTERN.exec(line);
    if (!match) {
      continue;
    }
    const [, marker, rest] = match;
    if (!state) {
      state = { opener: line.trim(), marker };
    } else if (
      marker[0] === state.marker[0] &&
      marker.length >= state.marker.length &&
      rest.trim() === ""
    ) {
      state = null;
    }
  }
  return state;
}

/**
 * Split Markdown for WeCom's per-message size limit.
 *
 * Cuts prefer a blank line, then a line break, within the second half of
 * each chunk, so paragraphs and list items stay intact. When a cut falls
 * inside a fenced code block the chunk closes the fence and the next chunk
 * re-opens it with the same opener, so both render as code instead of the
 * remainder of the reply turning into one broken block. Text without fences
 * is split losslessly: joining the chunks returns the original content.
 */
export function splitMarkdownByBytes(value: string, maxBytes: number): string[] {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error("maxBytes must be a positive safe integer.");
  }
  if (Buffer.byteLength(value, "utf8") <= maxBytes) {
    return [value];
  }
  if (maxBytes < MIN_MARKDOWN_CHUNK_BYTES) {
    return splitUtf8ByBytes(value, maxBytes);
  }

  const characters = [...value];
  const chunks: string[] = [];
  let index = 0;
  let openFence: OpenFence | null = null;

  while (index < characters.length) {
    const prefix: string = openFence ? `${openFence.opener}\n` : "";
    const budget =
      maxBytes - Buffer.byteLength(prefix, "utf8") - FENCE_CLOSE_RESERVE_BYTES;
    let end = index;
    let bytes = 0;
    while (end < characters.length) {
      const characterBytes = Buffer.byteLength(characters[end], "utf8");
      if (bytes + characterBytes > budget) {
        break;
      }
      bytes += characterBytes;
      end += 1;
    }
    if (end === index) {
      // A single code point never exceeds the budget at these sizes; keep the
      // loop finite regardless.
      end = index + 1;
    }
    if (end < characters.length) {
      const earliest = index + Math.floor((end - index) / 2);
      let cut = -1;
      for (let position = end; position > earliest; position -= 1) {
        if (
          characters[position - 1] === "\n" &&
          characters[position - 2] === "\n"
        ) {
          cut = position;
          break;
        }
      }
      if (cut < 0) {
        for (let position = end; position > earliest; position -= 1) {
          if (characters[position - 1] === "\n") {
            cut = position;
            break;
          }
        }
      }
      if (cut > index) {
        end = cut;
      }
    }

    const body = characters.slice(index, end).join("");
    const fenceAtCut = fenceStateAfter(body, openFence);
    const isLast = end >= characters.length;
    let chunk = `${prefix}${body}`;
    if (fenceAtCut && !isLast) {
      chunk += `${chunk.endsWith("\n") ? "" : "\n"}${fenceAtCut.marker}`;
    }
    chunks.push(chunk);
    openFence = isLast ? null : fenceAtCut;
    index = end;
  }
  return chunks;
}
