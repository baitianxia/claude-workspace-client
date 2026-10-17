import { describe, expect, it } from "vitest";
import {
  splitMarkdownByBytes,
  splitUtf8ByBytes,
} from "../src/main/wecom-message-chunks";

const MAX_BYTES = 18_000;

function fenceLines(chunk: string): number {
  return chunk.split("\n").filter((line) => /^ {0,3}(```|~~~)/u.test(line))
    .length;
}

describe("WeCom message chunks", () => {
  it("returns short content unchanged", () => {
    expect(splitMarkdownByBytes("你好", MAX_BYTES)).toEqual(["你好"]);
  });

  it("splits long plain text losslessly within the byte limit", () => {
    const content = "🙂中文".repeat(6_100);
    const chunks = splitMarkdownByBytes(content, MAX_BYTES);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(content);
    expect(
      chunks.every((chunk) => Buffer.byteLength(chunk, "utf8") <= MAX_BYTES),
    ).toBe(true);
    expect(chunks.every((chunk) => !/^[\uDC00-\uDFFF]/u.test(chunk))).toBe(true);
  });

  it("prefers paragraph boundaries", () => {
    const content = Array.from(
      { length: 400 },
      (_, index) => `第 ${index} 段：${"内容".repeat(30)}`,
    ).join("\n\n");
    const chunks = splitMarkdownByBytes(content, MAX_BYTES);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(content);
    expect(chunks.slice(0, -1).every((chunk) => chunk.endsWith("\n\n"))).toBe(
      true,
    );
  });

  it("closes and reopens a fenced code block that spans chunks", () => {
    const content =
      "说明\n\n```ts\n" +
      Array.from(
        { length: 2_000 },
        (_, index) => `const value${index} = "示例文本${index}";`,
      ).join("\n") +
      "\n```\n\n结尾";
    const chunks = splitMarkdownByBytes(content, MAX_BYTES);

    expect(chunks.length).toBeGreaterThan(2);
    expect(
      chunks.every((chunk) => Buffer.byteLength(chunk, "utf8") <= MAX_BYTES),
    ).toBe(true);
    // Every chunk renders as balanced Markdown on its own.
    expect(chunks.every((chunk) => fenceLines(chunk) % 2 === 0)).toBe(true);
    expect(chunks.slice(1).every((chunk) => chunk.startsWith("```ts\n"))).toBe(
      true,
    );
    expect(chunks.at(-1)?.endsWith("\n```\n\n结尾")).toBe(true);
  });

  it("falls back to byte splitting for very small limits", () => {
    expect(splitMarkdownByBytes("abcdef", 4)).toEqual(splitUtf8ByBytes("abcdef", 4));
  });
});
