import { describe, expect, it } from "vitest";
import {
  latestMenuOptions,
  latestMenuOptionCount,
  remoteMenuMismatch,
  RemoteReplyRouter,
  terminalActionForRemoteReply,
  terminalInputForRemoteReply,
  type RemoteAttention,
} from "../src/main/remote-reply-router";

const DOWN = "\x1b[B";

function attention(
  workspaceSessionId: string,
  launchId: string,
  overrides: Partial<RemoteAttention> = {},
): RemoteAttention {
  return {
    workspaceSessionId,
    launchId,
    claudeSessionId: `claude-${workspaceSessionId}`,
    kind: "idle",
    title: "等待回复",
    body: `message for ${workspaceSessionId}`,
    inputMode: "text",
    ...overrides,
  };
}

function codeGenerator(...codes: string[]): () => string {
  let index = 0;
  return () => codes[index++] ?? "ZZZZZ";
}

describe("RemoteReplyRouter", () => {
  it("generates an eight-character route code for production replies", () => {
    const result = new RemoteReplyRouter().register(
      "zhangsan",
      attention("session-a", "launch-a"),
    );

    expect(result.pending.code).toMatch(/^[A-Z2-9]{8}$/u);
  });

  it("routes simultaneous replies only by explicit unique code", () => {
    const router = new RemoteReplyRouter(
      codeGenerator("AAAAA", "BBBBB"),
      () => 1_000,
    );
    router.register("zhangsan", attention("session-a", "launch-a"));
    router.register("zhangsan", attention("session-b", "launch-b"));

    expect(router.resolve("zhangsan", "没有回复码")).toMatchObject({
      status: "rejected",
      message: expect.stringContaining("AAAAA、BBBBB"),
    });
    expect(router.resolve("zhangsan", "BBBBB second answer")).toMatchObject({
      status: "matched",
      pending: { workspaceSessionId: "session-b", launchId: "launch-b" },
      reply: "second answer",
    });
    expect(router.resolve("zhangsan", "AAAAA first answer")).toMatchObject({
      status: "matched",
      pending: { workspaceSessionId: "session-a", launchId: "launch-a" },
      reply: "first answer",
    });
  });

  it("binds each pending reply to its configured WeCom userid", () => {
    const router = new RemoteReplyRouter(codeGenerator("ABCDE"));
    router.register("zhangsan", attention("session-a", "launch-a"));

    expect(router.resolve("lisi", "ABCDE approve")).toMatchObject({
      status: "rejected",
      message: expect.stringContaining("不存在或已过期"),
    });
    expect(router.resolve("zhangsan", "ABCDE approve").status).toBe("matched");
  });

  it("can resolve an untagged reply only from a quoted notification code", () => {
    const router = new RemoteReplyRouter(codeGenerator("ABCDE", "QWERT"));
    router.register("zhangsan", attention("session-other", "launch-other"));
    router.register("zhangsan", attention("session-a", "launch-a"));

    expect(
      router.resolve(
        "zhangsan",
        "继续处理",
        "命令里可能出现 ABCDE，但明确的回复码是：回复码：QWERT",
      ),
    ).toMatchObject({
      status: "matched",
      reply: "继续处理",
      pending: { workspaceSessionId: "session-a" },
    });
  });

  it("uses a unique quoted notification title when WeCom truncates the reply code", () => {
    const router = new RemoteReplyRouter(codeGenerator("ABCDE", "QWERT"));
    router.register(
      "zhangsan",
      attention("session-a", "launch-a", {
        kind: "permission",
        title: "Claude Code 需要权限确认",
      }),
    );
    router.register(
      "zhangsan",
      attention("session-b", "launch-b", {
        kind: "question",
        title: "Claude Code 有问题需要回复",
      }),
    );

    expect(
      router.resolve(
        "zhangsan",
        "1",
        "Claude Workspace:\nClaude Code 需要权限确认\n工程：临时会话…",
      ),
    ).toMatchObject({
      status: "matched",
      pending: { code: "ABCDE", workspaceSessionId: "session-a" },
      reply: "1",
    });
  });

  it("rejects a truncated quote when its title matches multiple processes", () => {
    const router = new RemoteReplyRouter(codeGenerator("ABCDE", "QWERT"));
    for (const sessionId of ["session-a", "session-b"]) {
      router.register(
        "zhangsan",
        attention(sessionId, `launch-${sessionId}`, {
          kind: "permission",
          title: "Claude Code 需要权限确认",
        }),
      );
    }

    expect(
      router.resolve(
        "zhangsan",
        "1",
        "Claude Workspace:\nClaude Code 需要权限确认\n工程：临时会话…",
      ),
    ).toMatchObject({
      status: "rejected",
      message: expect.stringContaining("ABCDE、QWERT"),
    });
  });

  it("replaces older requests from the same process and rejects stale codes", () => {
    const router = new RemoteReplyRouter(codeGenerator("OLDZZ", "NEW22"));
    router.register("zhangsan", attention("session-a", "launch-a"));
    router.register(
      "zhangsan",
      attention("session-a", "launch-a", {
        kind: "permission",
        title: "权限确认",
        body: "run tests",
        inputMode: "menu",
      }),
    );

    expect(router.resolve("zhangsan", "OLDZZ reply").status).toBe("rejected");
    expect(router.resolve("zhangsan", "NEW22 1").status).toBe("matched");
  });

  it("does not let a delayed idle notification replace a concrete question", () => {
    const router = new RemoteReplyRouter(codeGenerator("ASKKK", "IDLE2"));
    const first = router.register(
      "zhangsan",
      attention("session-a", "launch-a", {
        kind: "question",
        title: "请选择",
        inputMode: "menu",
      }),
    );
    const duplicate = router.register(
      "zhangsan",
      attention("session-a", "launch-a", {
        kind: "idle",
        title: "等待回复",
      }),
    );

    expect(first).toMatchObject({ shouldSend: true, pending: { code: "ASKKK" } });
    expect(duplicate).toMatchObject({
      shouldSend: false,
      pending: { code: "ASKKK", kind: "question" },
    });
  });

  it("deduplicates generic permission notifications in favor of detailed requests", () => {
    const router = new RemoteReplyRouter(codeGenerator("GENAA", "DETAIL"));
    const generic = router.register(
      "zhangsan",
      attention("session-a", "launch-a", {
        kind: "permission",
        title: "Claude Code 需要权限确认",
        body: "Claude Code 正在等待权限选择。",
        inputMode: "none",
      }),
    );
    const detailed = router.register(
      "zhangsan",
      attention("session-a", "launch-a", {
        kind: "permission",
        title: "Claude Code 需要权限确认",
        body: "工具：Bash\n命令：npm test",
        inputMode: "menu",
        permissionSuggestionCount: 0,
        permissionOptionLabels: ["允许", "拒绝"],
      }),
    );

    expect(generic).toMatchObject({ shouldSend: true, pending: { code: "GENAA" } });
    expect(() => terminalActionForRemoteReply(generic.pending, "拒绝")).toThrow(
      "未提供完整权限选项",
    );
    expect(detailed).toMatchObject({ shouldSend: true, pending: { code: "DETAIL" } });
    expect(router.register("zhangsan", generic.pending)).toMatchObject({
      shouldSend: false,
      pending: { code: "DETAIL", inputMode: "menu" },
    });
    expect(router.resolve("zhangsan", "GENAA 1").status).toBe("rejected");
    expect(router.resolve("zhangsan", "DETAIL 1").status).toBe("matched");
  });

  it("keeps one reply code for duplicate hooks describing the same question", () => {
    const router = new RemoteReplyRouter(codeGenerator("ASKKK", "OTHER"));
    const question = attention("session-a", "launch-a", {
      kind: "question",
      title: "Claude Code 有问题需要回复",
      body: "是否收到通知？\n\n1. 收到了\n2. 没收到",
      inputMode: "menu",
      questionSelectionModes: ["single"],
    });

    const first = router.register("zhangsan", question);
    const duplicate = router.register("zhangsan", { ...question });

    expect(first).toMatchObject({
      shouldSend: true,
      pending: { code: "ASKKK" },
    });
    expect(duplicate).toMatchObject({
      shouldSend: false,
      pending: { code: "ASKKK", kind: "question" },
    });
    expect(router.resolve("zhangsan", "ASKKK 1")).toMatchObject({
      status: "matched",
      reply: "1",
    });
  });

  it("supports question labels and staged Type something / Chat about this replies", () => {
    const router = new RemoteReplyRouter(codeGenerator("ASKKK", "CHAT2"));
    const customPending = router.register(
      "zhangsan",
      attention("session-a", "launch-a", {
        kind: "question",
        inputMode: "menu",
        questionSelectionModes: ["single"],
        questionOptionLabels: [["收到了", "没收到"]],
      }),
    ).pending;

    expect(terminalInputForRemoteReply(customPending, "1")).toBe("\r");
    expect(terminalInputForRemoteReply(customPending, "收到了")).toBe("\r");
    // The extra rows are no longer numbered in the notification, so a bare
    // "3" is not an answer here (the bridge checks the terminal's row 3).
    expect(() => terminalActionForRemoteReply(customPending, "3")).toThrow(
      "请回复 1-2 的选项编号",
    );
    expect(
      terminalActionForRemoteReply(customPending, "输入其他回答"),
    ).toEqual({
      input: `${DOWN}${DOWN}\r`,
      inputChunks: [DOWN, DOWN, "\r"],
      nextStage: "question-custom-answer",
      followUpMessage: expect.stringContaining("Type something"),
      menuSelections: [3],
    });
    // "其他：内容" chooses the row and carries the text in one message.
    expect(
      terminalActionForRemoteReply(customPending, "其他：我在手机端收到了"),
    ).toEqual({
      input: `${DOWN}${DOWN}\r`,
      inputChunks: [DOWN, DOWN, "\r"],
      nextStage: "question-custom-answer",
      inlineFollowUp: "我在手机端收到了",
      menuSelections: [3],
    });
    expect(
      terminalActionForRemoteReply(
        customPending,
        "输入其他回答（Type something.）",
      ),
    ).toMatchObject({
      input: `${DOWN}${DOWN}\r`,
      nextStage: "question-custom-answer",
    });
    expect(router.setReplyStage(customPending.code, "question-custom-answer")).toBe(
      true,
    );
    const customFollowUp = router.resolve("zhangsan", "ASKKK 我在手机端收到了");
    expect(customFollowUp).toMatchObject({
      status: "matched",
      pending: { replyStage: "question-custom-answer" },
    });
    if (customFollowUp.status !== "matched") {
      throw new Error("Expected a matched custom follow-up.");
    }
    expect(
      terminalActionForRemoteReply(customFollowUp.pending, customFollowUp.reply),
    ).toEqual({ input: "我在手机端收到了\r" });
    expect(
      terminalActionForRemoteReply(customFollowUp.pending, "1"),
    ).toEqual({ input: "1\r" });

    const chatPending = router.register(
      "zhangsan",
      attention("session-b", "launch-b", {
        kind: "question",
        inputMode: "menu",
        questionSelectionModes: ["single"],
        questionOptionLabels: [["收到了", "没收到"]],
      }),
    ).pending;
    expect(() => terminalActionForRemoteReply(chatPending, "4")).toThrow(
      "请回复 1-2 的选项编号",
    );
    expect(
      terminalActionForRemoteReply(chatPending, "Chat about this"),
    ).toEqual({
      input: `${DOWN}${DOWN}${DOWN}\r`,
      inputChunks: [DOWN, DOWN, DOWN, "\r"],
      nextStage: "question-chat-message",
      followUpMessage: expect.stringContaining("Chat about this"),
      menuSelections: [4],
    });
    expect(
      terminalActionForRemoteReply(chatPending, "讨论：能否改成 20%"),
    ).toEqual({
      input: `${DOWN}${DOWN}${DOWN}\r`,
      inputChunks: [DOWN, DOWN, DOWN, "\r"],
      nextStage: "question-chat-message",
      inlineFollowUp: "能否改成 20%",
      menuSelections: [4],
    });
    expect(
      terminalActionForRemoteReply(
        chatPending,
        "与 Claude 讨论这个问题（Chat about this）",
      ),
    ).toMatchObject({
      input: `${DOWN}${DOWN}${DOWN}\r`,
      nextStage: "question-chat-message",
    });
    expect(
      terminalActionForRemoteReply(
        { ...chatPending, replyStage: "question-chat-message" },
        "1",
      ),
    ).toEqual({ input: "1\r" });

    const multiPending = router.register(
      "zhangsan",
      attention("session-multi", "launch-multi", {
        kind: "question",
        inputMode: "menu",
        supportsMultipleSelection: true,
        questionSelectionModes: ["multiple"],
        questionOptionLabels: [["日志", "指标"]],
      }),
    ).pending;
    expect(terminalInputForRemoteReply(multiPending, "1,2")).toBe(
      ` ${DOWN} \r`,
    );
    expect(() => terminalActionForRemoteReply(multiPending, "3")).toThrow(
      "请回复 1-2 的选项编号",
    );
    expect(terminalActionForRemoteReply(multiPending, "Type something")).toMatchObject({
      input: `${DOWN}${DOWN}\r`,
      nextStage: "question-custom-answer",
    });
    // A multi-select question has no chat row: discussion text becomes the
    // free-text answer.
    expect(terminalActionForRemoteReply(multiPending, "讨论：都要")).toMatchObject({
      input: `${DOWN}${DOWN}\r`,
      nextStage: "question-custom-answer",
      inlineFollowUp: "都要",
    });
    expect(() => terminalInputForRemoteReply(multiPending, "Chat about this")).toThrow(
      "多选问题回复无效",
    );
  });

  it("requires a unique exact option-text match and gives numbers priority", () => {
    const router = new RemoteReplyRouter(
      codeGenerator("EXACT", "AMBIG", "NUMBER", "PERM2"),
    );
    const exact = router.register(
      "zhangsan",
      attention("session-exact", "launch-exact", {
        kind: "question",
        inputMode: "menu",
        questionSelectionModes: ["single"],
        questionOptionLabels: [["允许", "不允许", "Ａ"]],
      }),
    ).pending;

    expect(terminalInputForRemoteReply(exact, "不允许")).toBe(`${DOWN}\r`);
    expect(terminalInputForRemoteReply(exact, "A")).toBe(
      `${DOWN}${DOWN}\r`,
    );
    expect(() => terminalInputForRemoteReply(exact, "允许。")).toThrow(
      "问题回复无效",
    );
    expect(() => terminalInputForRemoteReply(exact, "允")).toThrow(
      "问题回复无效",
    );

    const ambiguous = router.register(
      "zhangsan",
      attention("session-ambiguous", "launch-ambiguous", {
        kind: "question",
        inputMode: "menu",
        questionSelectionModes: ["single"],
        questionOptionLabels: [["Ａ", "A"]],
      }),
    ).pending;
    expect(() => terminalInputForRemoteReply(ambiguous, "A")).toThrow(
      "存在歧义",
    );

    const numericLabels = router.register(
      "zhangsan",
      attention("session-number", "launch-number", {
        kind: "question",
        inputMode: "menu",
        questionSelectionModes: ["single"],
        questionOptionLabels: [["1", "１"]],
      }),
    ).pending;
    expect(terminalInputForRemoteReply(numericLabels, "１")).toBe("\r");
    expect(terminalInputForRemoteReply(numericLabels, "2")).toBe(
      `${DOWN}\r`,
    );
    expect(() => terminalInputForRemoteReply(numericLabels, "01")).toThrow(
      "问题回复无效",
    );
    expect(() => terminalInputForRemoteReply(numericLabels, "5")).toThrow(
      "问题回复无效",
    );

    const ambiguousPermission = router.register(
      "zhangsan",
      attention("session-permission", "launch-permission", {
        kind: "permission",
        inputMode: "menu",
        permissionSuggestionCount: 1,
        permissionOptionLabels: ["Ａ", "A", "否"],
      }),
    ).pending;
    expect(() =>
      terminalInputForRemoteReply(ambiguousPermission, "A"),
    ).toThrow("权限选项文字存在歧义");
    expect(terminalInputForRemoteReply(ambiguousPermission, "2")).toBe(
      `${DOWN}\r`,
    );

    const aggregatedPermission = router.register(
      "zhangsan",
      attention("session-aggregated", "launch-aggregated", {
        kind: "permission",
        inputMode: "menu",
        // Labels describe the one persistent row shown to the user; the
        // stale count models a legacy pending notification.
        permissionSuggestionCount: 3,
        permissionOptionLabels: ["允许", "允许并保存建议", "拒绝"],
      }),
    ).pending;
    expect(terminalInputForRemoteReply(aggregatedPermission, "拒绝")).toBe(
      `${DOWN}${DOWN}\r`,
    );
    expect(() => terminalInputForRemoteReply(aggregatedPermission, "4")).toThrow(
      "1-3",
    );
  });

  it("does not let a generic idle notification replace a completed response", () => {
    const router = new RemoteReplyRouter(codeGenerator("DONE2", "IDLE3"));
    const completion = router.register(
      "zhangsan",
      attention("session-a", "launch-a", {
        kind: "completion",
        title: "本轮已完成",
        body: "修复完成，测试全部通过。",
      }),
    );
    const delayedIdle = router.register(
      "zhangsan",
      attention("session-a", "launch-a", {
        kind: "idle",
        title: "等待回复",
        body: "Claude Code is waiting for your input",
      }),
    );

    expect(completion).toMatchObject({
      shouldSend: true,
      pending: { code: "DONE2" },
    });
    expect(delayedIdle).toMatchObject({
      shouldSend: false,
      pending: { code: "DONE2", kind: "completion" },
    });
  });

  it("encodes menu selections without leaking extra control characters", () => {
    const router = new RemoteReplyRouter(
      codeGenerator("MENUA", "MENUB", "MENUC", "MENUD", "MENUE"),
    );
    const permissionWithoutSuggestion = router.register(
      "zhangsan",
      attention("session-a", "launch-a", {
        kind: "permission",
        inputMode: "menu",
      }),
    ).pending;
    const permissionWithSuggestion = router.register(
      "zhangsan",
      attention("session-c", "launch-c", {
        kind: "permission",
        inputMode: "menu",
        permissionSuggestionCount: 1,
        permissionOptionLabels: [
          "是",
          "是，并且以后从 hook-test.example.com 获取内容时不再询问",
          "否，并告诉 Claude 应如何调整（Esc）",
        ],
      }),
    ).pending;
    const multiple = router.register(
      "zhangsan",
      attention("session-b", "launch-b", {
        kind: "question",
        inputMode: "menu",
        supportsMultipleSelection: true,
      }),
    ).pending;
    const freeform = router.register(
      "zhangsan",
      attention("session-d", "launch-d"),
    ).pending;
    const single = router.register(
      "zhangsan",
      attention("session-e", "launch-e", {
        kind: "question",
        inputMode: "menu",
      }),
    ).pending;

    expect(terminalInputForRemoteReply(permissionWithoutSuggestion, "1")).toBe(
      "\r",
    );
    expect(terminalInputForRemoteReply(permissionWithoutSuggestion, "１")).toBe(
      "\r",
    );
    expect(terminalInputForRemoteReply(permissionWithoutSuggestion, "允许")).toBe(
      "\r",
    );
    expect(terminalInputForRemoteReply(permissionWithoutSuggestion, "是")).toBe(
      "\r",
    );
    expect(
      terminalInputForRemoteReply(permissionWithoutSuggestion, "允许本次"),
    ).toBe("\r");
    expect(terminalInputForRemoteReply(permissionWithoutSuggestion, "拒绝")).toBe(
      `${DOWN}\r`,
    );
    expect(
      terminalInputForRemoteReply(permissionWithoutSuggestion, "不允许"),
    ).toBe(`${DOWN}\r`);
    expect(() =>
      terminalInputForRemoteReply(permissionWithoutSuggestion, "我允许"),
    ).toThrow("权限回复无效");
    expect(terminalInputForRemoteReply(permissionWithSuggestion, "否")).toBe(
      `${DOWN}${DOWN}\r`,
    );
    expect(terminalInputForRemoteReply(permissionWithSuggestion, "始终允许")).toBe(
      `${DOWN}\r`,
    );
    expect(
      terminalInputForRemoteReply(
        permissionWithSuggestion,
        "是，并且以后从 hook-test.example.com 获取内容时不再询问",
      ),
    ).toBe(`${DOWN}\r`);
    expect(
      terminalActionForRemoteReply(
        permissionWithSuggestion,
        "否，并告诉 Claude 应如何调整",
      ),
    ).toMatchObject({
      input: `${DOWN}${DOWN}\r`,
      nextStage: "permission-denial-reason",
    });
    expect(terminalInputForRemoteReply(permissionWithSuggestion, "拒绝")).toBe(
      `${DOWN}${DOWN}\r`,
    );
    expect(
      terminalActionForRemoteReply(permissionWithSuggestion, "拒绝"),
    ).toMatchObject({
      input: `${DOWN}${DOWN}\r`,
      nextStage: "permission-denial-reason",
      followUpMessage: expect.stringContaining("如何调整"),
    });
    expect(terminalInputForRemoteReply(multiple, "1, 3")).toBe(
      ` ${DOWN}${DOWN} \r`,
    );
    expect(terminalInputForRemoteReply(single, "2")).toBe(`${DOWN}\r`);
    expect(terminalActionForRemoteReply(single, "2").inputChunks).toEqual([
      DOWN,
      "\r",
    ]);
    expect(() => terminalInputForRemoteReply(single, "随便输入")).toThrow(
      "菜单回复无效",
    );
    expect(() =>
      terminalInputForRemoteReply(
        permissionWithoutSuggestion,
        "说明\u001b[31m\n继续\r不能提交\t制表",
      ),
    ).toThrow("权限回复无效");
    expect(
      terminalInputForRemoteReply(
        freeform,
        "说明\u001b[31m\n继续\r不能提交\t制表",
      ),
    ).toBe("说明[31m 继续 不能提交 制表\r");
  });

  it("routes the reported merged directory permission menu as three rows", () => {
    const router = new RemoteReplyRouter(codeGenerator("SCREEN"));
    const pending = router.register(
      "zhangsan",
      attention("session-screen", "launch-screen", {
        kind: "permission",
        inputMode: "menu",
        // The old hook count was two (setMode + addDirectories), while the
        // Claude Code menu renders one persistent directory row.
        permissionSuggestionCount: 2,
        permissionOptionLabels: [
          "允许：仅执行本次操作",
          "允许：本次操作，并将 “C:\\Users\\tianxiabai\\.claude\\skills\\dpms-interface-entry” 添加为本会话工作目录",
          "拒绝：不执行本次操作，并告诉 Claude Code 应如何调整（选择后还需要回复具体调整要求）",
        ],
      }),
    ).pending;

    expect(terminalInputForRemoteReply(pending, "3")).toBe(
      `${DOWN}${DOWN}\r`,
    );
    expect(terminalInputForRemoteReply(pending, "拒绝")).toBe(
      `${DOWN}${DOWN}\r`,
    );
    expect(() => terminalInputForRemoteReply(pending, "4")).toThrow("1-3");
  });

  it("preserves numeric replies in Claude text-input prompts", () => {
    const router = new RemoteReplyRouter(
      codeGenerator("TEXTA", "TEXTB", "TEXTC", "TEXTD"),
    );
    const textPrompts = [
      { sessionId: "session-a", kind: "completion" as const },
      { sessionId: "session-b", kind: "idle" as const },
      { sessionId: "session-c", kind: "agent" as const },
      { sessionId: "session-d", kind: "elicitation" as const },
    ].map(({ sessionId, kind }) =>
      router.register(
        "zhangsan",
        attention(sessionId, `launch-${sessionId}`, {
          kind,
          inputMode: "text",
        }),
      ).pending,
    );

    for (const pending of textPrompts) {
      expect(terminalInputForRemoteReply(pending, "1")).toBe("1\r");
      expect(terminalInputForRemoteReply(pending, "继续处理")).toBe(
        "继续处理\r",
      );
    }
  });

  it("encodes multiple AskUserQuestion answers in terminal order", () => {
    const router = new RemoteReplyRouter(codeGenerator("QUEST"));
    const pending = router.register(
      "zhangsan",
      attention("session-a", "launch-a", {
        kind: "question",
        inputMode: "menu",
        supportsMultipleSelection: true,
        questionSelectionModes: ["single", "multiple", "single"],
        questionOptionLabels: [
          ["A", "B"],
          ["C", "D", "E"],
          ["F", "G", "H", "I"],
        ],
      }),
    ).pending;

    expect(terminalInputForRemoteReply(pending, "2;1,3;4")).toBe(
      "213\t4\r",
    );
    expect(terminalInputForRemoteReply(pending, "B;C,E;I")).toBe(
      "213\t4\r",
    );
    expect(terminalActionForRemoteReply(pending, "2;1,3;4").inputChunks).toEqual([
      "2",
      "1",
      "3",
      "\t",
      "4",
      "\r",
    ]);

    const lineSeparated = router.resolve(
      "zhangsan",
      "QUEST 2\n1,3\n4",
    );
    expect(lineSeparated.status).toBe("matched");
    if (lineSeparated.status !== "matched") {
      throw new Error("Expected line-separated answers to match.");
    }
    expect(
      terminalInputForRemoteReply(
        lineSeparated.pending,
        lineSeparated.reply,
      ),
    ).toBe("213\t4\r");
  });
});

describe("remote menu screen check", () => {
  const permissionMenu = (options: string[]) =>
    "  echo version 1.5 && npm test\r\n Do you want to proceed?\r\n" +
    options
      .map(
        (option, index) =>
          `${index === 0 ? "\u001b[36m❯\u001b[39m" : " "} ${index + 1}.\u001b[1C${option}`,
      )
      .join("\r\n");

  it("counts the options of the latest rendered menu", () => {
    const two = permissionMenu(["Yes", "No, and tell Claude what to do differently"]);
    const three = permissionMenu(["Yes", "Yes, and don't ask again", "No"]);
    const strip = (value: string) => value.replace(/\u001b\[[0-9;]*[A-Za-z]/gu, "");

    expect(latestMenuOptionCount(strip(two))).toBe(2);
    expect(latestMenuOptionCount(strip(three))).toBe(3);
    // An older render above the current one does not count.
    expect(latestMenuOptionCount(strip(`${three}\u001b[5A${two}`))).toBe(2);
    expect(latestMenuOptionCount("没有菜单的普通输出 1.5")).toBeNull();
  });

  it("reads the labels from the latest rendered Claude permission menu", () => {
    const screen = permissionMenu([
      "Yes",
      "Yes, and always allow access to dpms-interface-entry from this project",
      "No",
    ]);
    expect(latestMenuOptions(screen)).toEqual([
      "Yes",
      "Yes, and always allow access to dpms-interface-entry from this project",
      "No",
    ]);
    expect(latestMenuOptionCount(screen)).toBe(3);
  });

  it("refuses permission keys when the menu has a different number of options", () => {
    const router = new RemoteReplyRouter(() => "PERMIT");
    const pending = router.register(
      "zhangsan",
      attention("session-a", "launch-a", {
        kind: "permission",
        inputMode: "menu",
        permissionSuggestionCount: 0,
      }),
    ).pending;
    const deny = terminalActionForRemoteReply(pending, "2");

    expect(deny.menuSelections).toEqual([2]);
    expect(
      remoteMenuMismatch(pending, deny, permissionMenu(["Yes", "No"])),
    ).toBeNull();
    expect(
      remoteMenuMismatch(
        pending,
        deny,
        permissionMenu(["Yes", "Yes, and don't ask again", "No"]),
      ),
    ).toContain("3 个选项");
    // Nothing recognisable on screen: do not block the reply.
    expect(remoteMenuMismatch(pending, deny, "")).toBeNull();
  });

  it("refuses a permission key when the selected rendered label changed", () => {
    const router = new RemoteReplyRouter(() => "LABELAB");
    const pending = router.register(
      "zhangsan",
      attention("session-label", "launch-label", {
        kind: "permission",
        inputMode: "menu",
        permissionOptionLabels: ["Yes", "Yes, and always allow access", "No"],
        permissionMenuSource: "rendered",
      }),
    ).pending;
    const allowAlways = terminalActionForRemoteReply(pending, "2");

    expect(
      remoteMenuMismatch(
        pending,
        allowAlways,
        permissionMenu(["Yes", "Yes, and always allow access", "No"]),
      ),
    ).toBeNull();
    expect(
      remoteMenuMismatch(
        pending,
        allowAlways,
        permissionMenu(["Yes", "Yes, and always allow access to another project", "No"]),
      ),
    ).toContain("第 2 项");
  });

  it("refuses a question answer whose option is not on screen", () => {
    const router = new RemoteReplyRouter(() => "ASKKK");
    const pending = router.register(
      "zhangsan",
      attention("session-q", "launch-q", {
        kind: "question",
        inputMode: "menu",
        questionSelectionModes: ["single"],
        questionOptionLabels: [["方案 A：直接发布", "方案 B：先灰度"]],
      }),
    ).pending;
    const action = terminalActionForRemoteReply(pending, "2");

    expect(
      remoteMenuMismatch(
        pending,
        action,
        "❯ 1. 方案 A：直接发布\r\n  2. 方案 B：先灰度\r\n  3. Type something.\r\n  4. Chat about this\r\n",
      ),
    ).toBeNull();
    expect(
      remoteMenuMismatch(
        pending,
        action,
        "",
        ["方案 A：直接发布", "方案 B：先灰度", "Type something.", "Chat about this"],
      ),
    ).toBeNull();
    expect(
      remoteMenuMismatch(pending, action, "❯ 1. Yes\r\n  2. No\r\n"),
    ).toContain("方案 B：先灰度");
  });
});
