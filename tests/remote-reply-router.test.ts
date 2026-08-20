import { describe, expect, it } from "vitest";
import {
  RemoteReplyRouter,
  terminalInputForRemoteReply,
  type RemoteAttention,
} from "../src/main/remote-reply-router";

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
      message: expect.stringContaining("不属于当前用户"),
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

  it("encodes menu selections without leaking extra control characters", () => {
    const router = new RemoteReplyRouter(
      codeGenerator("MENUA", "MENUB", "MENUC", "MENUD"),
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

    expect(terminalInputForRemoteReply(permissionWithoutSuggestion, "允许")).toBe(
      "1",
    );
    expect(terminalInputForRemoteReply(permissionWithoutSuggestion, "拒绝")).toBe(
      "2",
    );
    expect(terminalInputForRemoteReply(permissionWithSuggestion, "始终允许")).toBe(
      "2",
    );
    expect(terminalInputForRemoteReply(permissionWithSuggestion, "拒绝")).toBe(
      "3",
    );
    expect(terminalInputForRemoteReply(multiple, "1, 3")).toBe("13\r");
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
      }),
    ).pending;

    expect(terminalInputForRemoteReply(pending, "2;1,3;4")).toBe("213\r4");
  });
});
