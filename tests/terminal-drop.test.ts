import { describe, expect, it } from "vitest";
import { formatDroppedPaths, quoteDroppedPath } from "../src/shared/terminal-drop";

describe("formatDroppedPaths", () => {
  it("keeps simple Windows paths bare and quotes paths with spaces", () => {
    expect(
      formatDroppedPaths(
        ["C:\\work\\a.png", "C:\\My Files\\设计 稿.png"],
        true,
      ),
    ).toBe('C:\\work\\a.png "C:\\My Files\\设计 稿.png" ');
  });

  it("quotes Windows paths with shell-special characters", () => {
    expect(quoteDroppedPath("C:\\a&b\\c(1).txt", true)).toBe('"C:\\a&b\\c(1).txt"');
  });

  it("single-quotes POSIX paths and escapes embedded quotes", () => {
    expect(quoteDroppedPath("/tmp/plain-file.txt", false)).toBe("/tmp/plain-file.txt");
    expect(quoteDroppedPath("/tmp/it's here.txt", false)).toBe("'/tmp/it'\\''s here.txt'");
  });

  it("drops empty paths and paths with line breaks", () => {
    expect(formatDroppedPaths(["", "C:\\a\nb"], true)).toBe("");
    expect(formatDroppedPaths([], false)).toBe("");
  });
});
