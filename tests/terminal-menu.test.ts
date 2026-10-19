import { describe, expect, it } from "vitest";
import {
  extractNumberedMenuOptions,
  menuLabelMatches,
  menuLabelsEqual,
} from "../src/shared/terminal-menu";

describe("extractNumberedMenuOptions", () => {
  it("reads a permission menu", () => {
    expect(
      extractNumberedMenuOptions([
        " Do you want to proceed?",
        " ❯ 1. Yes",
        "   2. Yes, and don't ask again for git commands in /repo",
        "   3. No, and tell Claude what to do differently (esc)",
        "",
        " Esc to cancel",
      ]),
    ).toEqual([
      "Yes",
      "Yes, and don't ask again for git commands in /repo",
      "No, and tell Claude what to do differently (esc)",
    ]);
  });

  it("keeps every option when options have descriptions or wrap", () => {
    expect(
      extractNumberedMenuOptions([
        "☐ 发布方式",
        "",
        "选择发布策略：",
        "",
        "❯ 1. 直接发布",
        "     全部用户立即可见",
        "  2. 先灰度",
        "     先对 5% 用户开放，观察",
        "     一天后再全量",
        "  3. Type something.",
        "  ────────────────",
        "  4. Chat about this",
        "",
        "Enter to select · ↑/↓ to navigate · Esc to cancel",
      ]),
    ).toEqual([
      "直接发布 全部用户立即可见",
      "先灰度 先对 5% 用户开放，观察 一天后再全量",
      "Type something.",
      "Chat about this",
    ]);
  });

  it("reads a menu drawn inside a dialog border", () => {
    expect(
      extractNumberedMenuOptions([
        "│ Bash command                              │",
        "│ ❯ 1. Yes                                  │",
        "│   2. No, and tell Claude what to do (esc) │",
        "╰───────────────────────────────────────────╯",
      ]),
    ).toEqual(["Yes", "No, and tell Claude what to do (esc)"]);
  });

  it("strips multi-select checkboxes", () => {
    expect(
      extractNumberedMenuOptions([
        "❯ 1. [ ] 单元测试",
        "  2. [✔] 集成测试",
        "  3. [ ] Type something",
      ]),
    ).toEqual(["单元测试", "集成测试", "Type something"]);
  });

  it("does not treat a numbered list in Claude's answer as a menu", () => {
    expect(
      extractNumberedMenuOptions([
        "⏺ 接下来的计划：",
        "  1. 修改配置",
        "  2. 运行测试",
        "",
        "> ",
      ]),
    ).toBeNull();
  });

  it("prefers the latest menu over an earlier list", () => {
    expect(
      extractNumberedMenuOptions([
        "  1. 修改配置",
        "  2. 运行测试",
        " Do you want to proceed?",
        " ❯ 1. Yes",
        "   2. No",
      ]),
    ).toEqual(["Yes", "No"]);
  });
});

describe("menu label comparison", () => {
  it("matches a notification label against the screen label", () => {
    expect(menuLabelMatches("先灰度", "先灰度 先对 5% 用户开放")).toBe(true);
    expect(menuLabelMatches("先对 5%用户开放", "先对 5% 用户 开放")).toBe(true);
    expect(menuLabelMatches("Yes, and always allow access to project-x", "Yes, and always allow…")).toBe(true);
    expect(menuLabelMatches("方案 B", "方案 A")).toBe(false);
  });

  it("requires equal labels when both come from the screen", () => {
    expect(menuLabelsEqual("Yes, and always allow access", "Yes,  and always allow access")).toBe(true);
    expect(
      menuLabelsEqual("Yes, and always allow access", "Yes, and always allow access to another project"),
    ).toBe(false);
    expect(menuLabelsEqual("Yes, and always allow…", "Yes, and always allow access to x")).toBe(true);
  });
});
