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
    expectsMenuSelection: false,
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
        expectsMenuSelection: true,
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
        expectsMenuSelection: true,
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
      expectsMenuSelection: true,
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
        expectsMenuSelection: true,
        questionSelectionModes: ["single"],
        questionOptionLabels: [["收到了", "没收到"]],
      }),
    ).pending;

    expect(terminalInputForRemoteReply(customPending, "收到了")).toBe("\r");
    expect(terminalActionForRemoteReply(customPending, "3")).toEqual({
      input: `${DOWN}${DOWN}\r`,
      nextStage: "question-custom-answer",
      followUpMessage: expect.stringContaining("Type something"),
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

    const chatPending = router.register(
      "zhangsan",
      attention("session-b", "launch-b", {
        kind: "question",
        expectsMenuSelection: true,
        questionSelectionModes: ["single"],
        questionOptionLabels: [["收到了", "没收到"]],
      }),
    ).pending;
    expect(terminalActionForRemoteReply(chatPending, "4")).toEqual({
      input: `${DOWN}${DOWN}${DOWN}\r`,
      nextStage: "question-chat-message",
      followUpMessage: expect.stringContaining("Chat about this"),
    });
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
        expectsMenuSelection: true,
      }),
    ).pending;
    const permissionWithSuggestion = router.register(
      "zhangsan",
      attention("session-c", "launch-c", {
        kind: "permission",
        expectsMenuSelection: true,
        permissionSuggestionCount: 1,
      }),
    ).pending;
    const multiple = router.register(
      "zhangsan",
      attention("session-b", "launch-b", {
        kind: "question",
        expectsMenuSelection: true,
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
        expectsMenuSelection: true,
      }),
    ).pending;

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
    expect(terminalInputForRemoteReply(permissionWithSuggestion, "否")).toBe(
      `${DOWN}${DOWN}\r`,
    );
    expect(terminalInputForRemoteReply(permissionWithSuggestion, "始终允许")).toBe(
      `${DOWN}\r`,
    );
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

  it("encodes multiple AskUserQuestion answers in terminal order", () => {
    const router = new RemoteReplyRouter(codeGenerator("QUEST"));
    const pending = router.register(
      "zhangsan",
      attention("session-a", "launch-a", {
        kind: "question",
        expectsMenuSelection: true,
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
  });
});
