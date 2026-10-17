import { describe, expect, it } from "vitest";
import { TerminalBuffer } from "../src/main/terminal-buffer";

describe("TerminalBuffer", () => {
  it("returns appended output unchanged while within the limit", () => {
    const buffer = new TerminalBuffer(100, "欢迎\r\n");
    buffer.append("\u001b[31m红色\u001b[0m");
    buffer.append("\r\n结束");

    expect(buffer.toString()).toBe("欢迎\r\n\u001b[31m红色\u001b[0m\r\n结束");
    expect(buffer.size).toBe(buffer.toString().length);
  });

  it("drops the oldest output and restarts at a line boundary", () => {
    const buffer = new TerminalBuffer(40);
    buffer.append("第一行内容很长很长很长\r\n");
    // This escape sequence would be cut in half by a plain character slice.
    buffer.append("\u001b[38;2;217;119;87m第二行\u001b[0m\r\n");
    buffer.append("第三行\r\n第四行\r\n");

    const snapshot = buffer.toString();
    expect(snapshot.startsWith("\u001b[0m")).toBe(true);
    const content = snapshot.slice("\u001b[0m".length);
    expect(content.length).toBeLessThanOrEqual(40);
    // Content starts after a newline, never inside "\u001b[38;2;...m".
    expect(content.startsWith(";2;")).toBe(false);
    expect(content.endsWith("第四行\r\n")).toBe(true);
  });

  it("keeps many small writes bounded and in order", () => {
    const buffer = new TerminalBuffer(10_000);
    for (let index = 0; index < 5_000; index += 1) {
      buffer.append(`${index}\n`);
    }

    const content = buffer.toString().replace(/^\u001b\[0m/u, "");
    expect(content.length).toBeLessThanOrEqual(10_000);
    expect(content.endsWith("4999\n")).toBe(true);
    const lines = content.trimEnd().split("\n").map(Number);
    expect(lines.every((value, index) => index === 0 || value === lines[index - 1] + 1)).toBe(true);
  });
});
