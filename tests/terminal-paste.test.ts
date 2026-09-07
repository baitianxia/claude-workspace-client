import { describe, expect, it } from "vitest";
import {
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_START,
  shouldThrottleTerminalInput,
  splitTerminalPaste,
  utf8ByteLength,
} from "../src/shared/terminal-paste";

describe("terminal paste transport", () => {
  it("counts UTF-8 bytes without splitting Unicode code points", () => {
    expect(utf8ByteLength("abc你好🙂")).toBe(3 + 6 + 4);
    const value = "a🙂b你好c";
    const chunks = splitTerminalPaste(value, 5);

    expect(chunks.join("")).toBe(value);
    expect(chunks).toEqual(["a🙂", "b你", "好c"]);
    expect(chunks.every((chunk) => utf8ByteLength(chunk) <= 5)).toBe(true);
  });

  it("keeps bracketed-paste delimiters as ordered atomic writes", () => {
    const value = `${BRACKETED_PASTE_START}第一行\r第二行${BRACKETED_PASTE_END}`;

    expect(splitTerminalPaste(value, 6)).toEqual([
      BRACKETED_PASTE_START,
      "第一",
      "行\r",
      "第二",
      "行",
      BRACKETED_PASTE_END,
    ]);
  });

  it("does not split ANSI escape sequences copied from a terminal", () => {
    const value = "\u001b[38;5;196mred\u001b[0m and text";
    const chunks = splitTerminalPaste(value, 4);

    expect(chunks.join("")).toBe(value);
    expect(chunks).toContain("\u001b[38;5;196m");
    expect(chunks).toContain("\u001b[0m");
  });

  it("detects bracketed and large plain input, but not ordinary typing", () => {
    expect(shouldThrottleTerminalInput("short input")).toBe(false);
    expect(shouldThrottleTerminalInput(BRACKETED_PASTE_START + "x")).toBe(
      true,
    );
    expect(shouldThrottleTerminalInput("x".repeat(1_025))).toBe(true);
  });
});
