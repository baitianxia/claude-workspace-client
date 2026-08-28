import { describe, expect, it } from "vitest";
import {
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
    expect(terminalActionForRemoteReply(customPending, "3")).toEqual({
      input: `${DOWN}${DOWN}\r`,
      nextStage: "question-custom-answer",
      followUpMessage: expect.stringContaining("Type something"),
    });
    expect(
      terminalActionForRemoteReply(customPending, "输入其他回答"),
    ).toMatchObject({
      input: `${DOWN}${DOWN}\r`,
      nextStage: "question-custom-answer",
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
    expect(terminalActionForRemoteReply(chatPending, "4")).toEqual({
      input: `${DOWN}${DOWN}${DOWN}\r`,
      nextStage: "question-chat-message",
      followUpMessage: expect.stringContaining("Chat about this"),
    });
    expect(
      terminalActionForRemoteReply(chatPending, "Chat about this"),
    ).toMatchObject({
      input: `${DOWN}${DOWN}${DOWN}\r`,
      nextStage: "question-chat-message",
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
      `${DOWN}\r ${DOWN}${DOWN} \r${DOWN}${DOWN}${DOWN}\r`,
    );
    expect(terminalInputForRemoteReply(pending, "B;C,E;I")).toBe(
      `${DOWN}\r ${DOWN}${DOWN} \r${DOWN}${DOWN}${DOWN}\r`,
    );

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
    ).toBe(`${DOWN}\r ${DOWN}${DOWN} \r${DOWN}${DOWN}${DOWN}\r`);
  });
});
