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
