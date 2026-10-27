import { describe, expect, it } from "vitest";
import {
  bindConfirmedRow,
  bindOutOfRangeSelection,
  bindPermissionSelection,
  bindPositionalSelection,
  bindQuestionSelections,
  bindRowByText,
  describeVisibleMenu,
  screenShowsRequest,
  stageForBoundRow,
} from "../src/main/remote-menu-binding";
import type { PendingRemoteReply } from "../src/main/remote-reply-router";
import { parseVisibleMenu, type VisibleMenu } from "../src/shared/terminal-menu";

function pending(overrides: Partial<PendingRemoteReply>): PendingRemoteReply {
  return {
    workspaceSessionId: "session",
    launchId: "launch",
    claudeSessionId: "claude",
    kind: "permission",
    title: "Claude Code 需要权限确认",
    body: "",
    inputMode: "menu",
    code: "ABCDE",
    userId: "zhangsan",
    createdAt: 0,
    fingerprint: "",
    ...overrides,
  };
}

function menu(labels: string[], pointerIndex = 0): VisibleMenu {
  return {
    options: labels.map((label, index) => ({ label, number: index + 1 })),
    pointerIndex,
  };
}

const hookPermission = pending({
  permissionOptionLabels: ["允许：仅运行本次命令", "拒绝：不运行本次命令"],
  permissionMenuSource: "hook",
  permissionSuggestionCount: 0,
  identityProbes: ["npm test"],
});

describe("permission binding", () => {
  const fourRows = menu([
    "Yes",
    "Yes, and don't ask again for npm test commands in this project",
    "Yes, and enable auto mode",
    "No, and tell Claude what to do differently (esc)",
  ]);

  it("binds allow once to the first row and deny to the last row regardless of shape", () => {
    expect(bindPermissionSelection(hookPermission, 1, fourRows)).toEqual({
      status: "bound",
      rows: [{ index: 0, label: "Yes" }],
    });
    expect(bindPermissionSelection(hookPermission, 2, fourRows)).toEqual({
      status: "bound",
      rows: [{ index: 3, label: "No, and tell Claude what to do differently (esc)" }],
    });
  });

  it("asks for confirmation before taking a middle row when the shapes differ", () => {
    const withSuggestion = pending({
      permissionOptionLabels: ["允许：仅运行本次命令", "允许：以后运行 npm test 时不再询问", "拒绝"],
      permissionMenuSource: "hook",
      permissionSuggestionCount: 1,
    });
    expect(bindPermissionSelection(withSuggestion, 2, fourRows)).toMatchObject({
      status: "confirm",
      reason: expect.stringContaining("通知中的权限菜单有 3 项，终端当前有 4 项"),
    });
    // Same shape: the single middle row is the remembered rule.
    const threeRows = menu(["Yes", "Yes, and don't ask again for npm test", "No"]);
    expect(bindPermissionSelection(withSuggestion, 2, threeRows)).toEqual({
      status: "bound",
      rows: [{ index: 1, label: "Yes, and don't ask again for npm test" }],
    });
  });

  it("checks the text of a middle row when the notification came from the screen", () => {
    const rendered = pending({
      permissionOptionLabels: ["Yes", "Yes, and always allow access to project-a", "No"],
      permissionMenuSource: "rendered",
      permissionSuggestionCount: 1,
    });
    const changed = menu(["Yes", "Yes, and always allow access to project-b", "No"]);
    expect(bindPermissionSelection(rendered, 2, changed)).toMatchObject({
      status: "confirm",
      reason: expect.stringContaining("project-b"),
    });
  });

  it("rejects a screen that is not a permission dialog", () => {
    expect(
      bindPermissionSelection(hookPermission, 1, menu(["方案 A", "方案 B", "Type something."])),
    ).toMatchObject({ status: "reject", reason: expect.stringContaining("不是权限对话框") });
  });

  it("recognises the request on screen through its probes", () => {
    expect(screenShowsRequest(hookPermission, ["⏺ Bash(npm test)", "❯ 1. Yes"])).toBe(true);
    expect(screenShowsRequest(hookPermission, ["⏺ Bash(rm -rf build)", "❯ 1. Yes"])).toBe(false);
    expect(screenShowsRequest(pending({}), ["anything"])).toBeNull();
    // A long command is probed by its first 24 characters, which may wrap.
    expect(
      screenShowsRequest(pending({ identityProbes: ["npm run build -- --watch"] }), [
        "│ npm run build --",
        "│ --watch --verbose --color",
      ]),
    ).toBe(true);
    // A complete short command must match as a whole token: another queued
    // command that merely starts the same way is a different dialog.
    expect(
      screenShowsRequest(pending({ identityProbes: ["npm test --foo"] }), [
        "⏺ Bash(npm test --foobar)",
      ]),
    ).toBe(false);
    expect(
      screenShowsRequest(pending({ identityProbes: ["npm test --foo"] }), [
        "│ Bash command",
        "│   npm test --foo",
        "│   Run the unit tests",
        "Do you want to proceed?",
      ]),
    ).toBe(true);
    expect(
      screenShowsRequest(pending({ identityProbes: ["q_f790.js"] }), ["Write(skills/q_f790.jsx)"]),
    ).toBe(false);
    expect(
      screenShowsRequest(pending({ identityProbes: ["example.com"] }), ["Fetch https://example.com/docs"]),
    ).toBe(true);
  });

  it("derives the denial-reason stage from the deny row only", () => {
    expect(
      stageForBoundRow(hookPermission, { index: 3, label: fourRows.options[3].label }, fourRows),
    ).toBe("permission-denial-reason");
    expect(stageForBoundRow(hookPermission, { index: 0, label: "Yes" }, fourRows)).toBeNull();
  });
});

describe("question binding", () => {
  const question = pending({
    kind: "question",
    questionSelectionModes: ["single"],
    questionOptionLabels: [["直接发布", "先灰度"]],
  });

  it("binds options by label even when the screen numbers them differently", () => {
    const screen = parseVisibleMenu([
      "❯ 1. 直接发布",
      "     全部用户立即可见",
      "  2. 先灰度",
      "     先对 5% 用户开放",
      "  3. Type something.",
      "  4. Chat about this",
    ])!;
    expect(bindQuestionSelections(question, [2], screen)).toEqual({
      status: "bound",
      rows: [{ index: 1, label: "先灰度 先对 5% 用户开放" }],
    });
    expect(bindQuestionSelections(question, [3], screen)).toEqual({
      status: "bound",
      rows: [{ index: 2, label: "Type something." }],
    });
    expect(bindQuestionSelections(question, [4], screen)).toEqual({
      status: "bound",
      rows: [{ index: 3, label: "Chat about this" }],
    });
    expect(stageForBoundRow(question, { index: 2, label: "Type something." }, screen)).toBe(
      "question-custom-answer",
    );
    expect(stageForBoundRow(question, { index: 3, label: "Chat about this" }, screen)).toBe(
      "question-chat-message",
    );
  });

  it("probes for an unnumbered Chat about this row when it is not visible", () => {
    const screen = menu(["直接发布", "先灰度", "Type something."]);
    expect(bindQuestionSelections(question, [4], screen)).toEqual({
      status: "probe",
      fromIndex: 2,
      acceptLabels: expect.arrayContaining(["chat about this"]),
    });
  });

  it("rejects a screen that shows a different question", () => {
    expect(
      bindQuestionSelections(question, [1], menu(["Yes", "No"])),
    ).toMatchObject({ status: "reject", reason: expect.stringContaining("直接发布") });
  });

  it("binds every row of a multi-select answer", () => {
    const multiple = pending({
      kind: "question",
      questionSelectionModes: ["multiple"],
      questionOptionLabels: [["日志", "指标", "链路"]],
    });
    const screen = menu(["日志", "指标", "链路", "Type something"]);
    expect(bindQuestionSelections(multiple, [1, 3], screen)).toEqual({
      status: "bound",
      rows: [
        { index: 0, label: "日志" },
        { index: 2, label: "链路" },
      ],
    });
    expect(bindQuestionSelections(multiple, [5], screen)).toMatchObject({ status: "reject" });
  });
});

describe("positional, out-of-range and confirmed bindings", () => {
  const plan = menu(["Yes, and auto-accept edits", "Yes, and manually approve edits", "No, keep planning"]);

  it("binds plan replies by position and checks the remembered labels", () => {
    expect(bindPositionalSelection(pending({ kind: "plan" }), 3, plan)).toEqual({
      status: "bound",
      rows: [{ index: 2, label: "No, keep planning" }],
    });
    expect(
      bindPositionalSelection(
        pending({ kind: "plan", renderedMenuLabels: ["Yes, and auto-accept edits", "Yes, and manually approve edits", "No, keep planning"] }),
        2,
        plan,
      ),
    ).toMatchObject({ status: "bound" });
    expect(
      bindPositionalSelection(
        pending({ kind: "plan", renderedMenuLabels: ["Yes", "No"] }),
        2,
        plan,
      ),
    ).toMatchObject({ status: "confirm" });
    expect(bindPositionalSelection(pending({ kind: "plan" }), 4, plan)).toMatchObject({
      status: "reject",
    });
  });

  it("treats numbers beyond the notification by what the row on screen does", () => {
    const screen = menu(["收到了", "没收到", "Type something.", "Chat about this"]);
    expect(bindOutOfRangeSelection(3, screen)).toMatchObject({
      status: "text-hint",
      reason: expect.stringContaining("其他："),
    });
    expect(bindOutOfRangeSelection(4, screen)).toMatchObject({
      status: "text-hint",
      reason: expect.stringContaining("讨论："),
    });
    const permission = menu(["Yes", "Yes, and enable auto mode", "No"]);
    expect(bindOutOfRangeSelection(2, permission)).toMatchObject({
      status: "confirm",
      reason: expect.stringContaining("Yes, and enable auto mode"),
    });
    expect(bindOutOfRangeSelection(5, permission)).toMatchObject({ status: "reject" });
    expect(bindOutOfRangeSelection(2, null)).toMatchObject({ status: "reject" });
  });

  it("confirms a row by its terminal number and matches rows by text", () => {
    const screen = menu(["Yes", "Yes, and enable auto mode", "No"]);
    expect(bindConfirmedRow(2, screen)).toEqual({
      status: "bound",
      rows: [{ index: 1, label: "Yes, and enable auto mode" }],
    });
    expect(bindConfirmedRow(4, screen)).toMatchObject({ status: "reject" });
    expect(bindRowByText("yes, and enable auto mode", screen)).toMatchObject({
      status: "bound",
      rows: [{ index: 1, label: "Yes, and enable auto mode" }],
    });
    expect(bindRowByText("Yes", screen)).toEqual({
      status: "bound",
      rows: [{ index: 0, label: "Yes" }],
    });
    expect(bindRowByText("maybe", screen)).toMatchObject({ status: "reject" });
  });

  it("describes the visible menu with the pointer and unnumbered rows", () => {
    expect(
      describeVisibleMenu({
        options: [
          { label: "方案 A", number: 1 },
          { label: "Chat about this", number: null },
        ],
        pointerIndex: 1,
      }),
    ).toBe("终端当前菜单：\n  1. 方案 A\n❯ · Chat about this");
    expect(describeVisibleMenu(null)).toContain("没有可识别的菜单");
  });
});
