import { describe, expect, it } from "vitest";
import type { SessionRecord } from "../src/shared/contracts";
import { nextSessionTitle } from "../src/main/session-title";

function session(title: string): SessionRecord {
  return {
    id: title,
    projectId: "project",
    title,
    cwd: "C:\\project",
    status: "running",
    createdAt: 1,
  };
}

describe("nextSessionTitle", () => {
  it("fills the first available numeric session title", () => {
    expect(
      nextSessionTitle(
        [session("会话 1"), session("会话 3 · 08:30"), session("自定义名称")],
        new Date(2026, 7, 14, 9, 7),
      ),
    ).toBe("会话 2 · 09:07");
  });
});
