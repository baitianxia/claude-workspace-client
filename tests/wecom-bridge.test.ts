import { EventEmitter } from "node:events";
import type { IPty } from "node-pty";
import { describe, expect, it, vi } from "vitest";
import { EventType } from "@wecom/aibot-node-sdk";
import type {
  BaseMessage,
  EventMessage,
  SendMsgBody,
  TextMessage,
  WsFrame,
  WsFrameHeaders,
} from "@wecom/aibot-node-sdk";
import type { ClaudeHookEvent } from "../src/main/claude-hook-server";
import { RemoteReplyRouter } from "../src/main/remote-reply-router";
import {
  SessionManager,
  type PtySpawner,
} from "../src/main/session-manager";
import {
  WeComBridge,
  type WeComClient,
} from "../src/main/wecom-bridge";

interface FakePty {
  process: IPty;
  writes: string[];
  emitExit(exitCode: number): void;
}

function fakePty(pid: number): FakePty {
  let exitListener: (event: { exitCode: number; signal?: number }) => void = () =>
    undefined;
  const writes: string[] = [];
  return {
    process: {
      pid,
      process: "claude",
      cols: 120,
      rows: 36,
      handleFlowControl: false,
      onData: () => ({ dispose: () => undefined }),
      onExit: (listener) => {
        exitListener = listener;
        return { dispose: () => undefined };
      },
      write: (data) => writes.push(String(data)),
      resize: () => undefined,
      clear: () => undefined,
      pause: () => undefined,
      resume: () => undefined,
      kill: () => undefined,
    },
    writes,
    emitExit: (exitCode) => exitListener({ exitCode, signal: 0 }),
  };
}

class FakeWeComClient extends EventEmitter {
  readonly sent: Array<{ chatId: string; body: SendMsgBody }> = [];
  readonly replies: string[] = [];
  connected = false;
  disconnected = false;

  connect(): this {
    this.connected = true;
    return this;
  }

  disconnect(): void {
    this.disconnected = true;
  }

  async sendMessage(chatId: string, body: SendMsgBody): Promise<unknown> {
    this.sent.push({ chatId, body });
    return {};
  }

  async replyStream(
    _frame: WsFrameHeaders,
    _streamId: string,
    content: string,
  ): Promise<unknown> {
    this.replies.push(content);
    return {};
  }
}

function hook(
  workspaceSessionId: string,
  launchId: string,
  command: string,
): ClaudeHookEvent {
  return {
    workspaceSessionId,
    launchId,
    payload: {
      session_id: `claude-${workspaceSessionId}`,
      transcript_path: `C:\\transcripts\\${workspaceSessionId}.jsonl`,
      cwd: "C:\\work\\mall",
      hook_event_name: "PermissionRequest",
      tool_name: "Bash",
      tool_input: { command },
    },
  };
}

function incomingMessage(
  msgid: string,
  content: string,
  userid = "zhangsan",
  quotedContent?: string,
): WsFrame<TextMessage> {
  return {
    headers: { req_id: `request-${msgid}` },
    body: {
      msgid,
      aibotid: "bot-id",
      chattype: "single",
      from: { userid },
      msgtype: "text" as TextMessage["msgtype"],
      text: { content },
      ...(quotedContent
        ? {
            quote: {
              msgtype: "text" as const,
              text: { content: quotedContent },
            },
          }
        : {}),
    },
  };
}

function incomingMixedMessage(
  msgid: string,
  content: string,
  userid = "zhangsan",
  quotedContent?: string,
): WsFrame<BaseMessage> {
  return {
    headers: { req_id: `request-${msgid}` },
    body: {
      msgid,
      aibotid: "bot-id",
      chattype: "single",
      from: { userid },
      msgtype: "mixed",
      mixed: {
        msg_item: [
          { msgtype: "image", image: { url: "https://example.com/image" } },
          { msgtype: "text", text: { content } },
        ],
      },
      ...(quotedContent
        ? {
            quote: {
              msgtype: "text" as const,
              text: { content: quotedContent },
            },
          }
        : {}),
    },
  };
}

function disconnectedEvent(): WsFrame<EventMessage> {
  return {
    headers: { req_id: "request-disconnected" },
    body: {
      msgid: "disconnected-event",
      create_time: 1,
      aibotid: "bot-id",
      chattype: "single",
      from: { userid: "zhangsan" },
      msgtype: "event",
      event: { eventtype: EventType.Disconnected },
    },
  };
}

function markdownContent(body: SendMsgBody): string {
  if (body.msgtype !== "markdown") {
    throw new Error("Expected a markdown message.");
  }
  return body.markdown.content;
}

function routeCode(markdown: string): string {
  const match = /回复码：`([A-Z2-9]{4,8})`/u.exec(markdown);
  if (!match) {
    throw new Error("Notification has no route code.");
  }
  return match[1];
}

describe("WeComBridge", () => {
  it("routes simultaneous replies to the exact Claude Code PTY", async () => {
    const firstPty = fakePty(1);
    const secondPty = fakePty(2);
    const spawner = vi
      .fn()
      .mockReturnValueOnce(firstPty.process)
      .mockReturnValueOnce(secondPty.process) as unknown as PtySpawner;
    const launchIds = new Map<string, string>();
    const manager = new SessionManager(
      () => "C:\\Tools\\claude.exe",
      spawner,
      "win32",
      [],
      (sessionId, launchId) => {
        launchIds.set(sessionId, launchId);
        return { args: [] };
      },
    );
    const first = manager.createSession({
      projectId: "project-one",
      cwd: "C:\\work\\one",
    });
    const second = manager.createSession({
      projectId: "project-two",
      cwd: "C:\\work\\two",
    });
    const client = new FakeWeComClient();
    const router = new RemoteReplyRouter(
      (() => {
        const codes = ["AAAAA", "BBBBB"];
        return () => codes.shift() ?? "CCCCC";
      })(),
    );
    const bridge = new WeComBridge(
      manager,
      () => [
        {
          id: "project-one",
          name: "one",
          pinned: false,
          rootPath: "C:\\work\\one",
          createdAt: 1,
          lastOpenedAt: 1,
        },
        {
          id: "project-two",
          name: "two",
          pinned: false,
          rootPath: "C:\\work\\two",
          createdAt: 2,
          lastOpenedAt: 2,
        },
      ],
      router,
      () => client as unknown as WeComClient,
    );
    expect(bridge.shouldInjectClaudeHooks()).toBe(false);
    bridge.configure({
      enabled: true,
      botId: "bot-id",
      targetUserId: "zhangsan",
      secret: "secret",
      hasSecret: true,
    });
    expect(bridge.shouldInjectClaudeHooks()).toBe(true);
    client.emit("authenticated");

    bridge.handleClaudeHook(
      hook(first.id, launchIds.get(first.id)!, "npm test -- first"),
    );
    bridge.handleClaudeHook(
      hook(second.id, launchIds.get(second.id)!, "npm test -- second"),
    );
    await vi.waitFor(() => expect(client.sent).toHaveLength(2));

    const firstCode = routeCode(markdownContent(client.sent[0].body));
    const secondCode = routeCode(markdownContent(client.sent[1].body));
    expect(markdownContent(client.sent[0].body)).toContain(
      "> 工作目录：C:\\work\\one",
    );
    expect(markdownContent(client.sent[0].body)).toContain(
      "命令：npm test -- first",
    );
    expect(markdownContent(client.sent[0].body)).toContain(
      "引用本消息回复",
    );
    expect(markdownContent(client.sent[0].body)).toContain(
      "无需重复输入回复码",
    );
    expect(firstCode).not.toBe(secondCode);
    expect(client.sent.map((entry) => entry.chatId)).toEqual([
      "zhangsan",
      "zhangsan",
    ]);
    const callbackUserId = "wohR_KCgAAVrFf3pjqdWOLHCn12fH5nw";

    client.emit(
      "message",
      incomingMixedMessage(
        "message-2",
        "1",
        callbackUserId,
        markdownContent(client.sent[1].body),
      ),
    );
    await vi.waitFor(() => expect(secondPty.writes).toEqual(["1\r"]));
    expect(firstPty.writes).toEqual([]);
    expect(bridge.getState()).toMatchObject({
      lastInboundStatus: "routed",
      lastInboundDetail: expect.stringContaining(secondCode),
    });

    client.emit(
      "message",
      incomingMessage("message-1", `${firstCode} 2`, callbackUserId),
    );
    await vi.waitFor(() => expect(firstPty.writes).toEqual(["2\r"]));
    expect(secondPty.writes).toEqual(["1\r"]);
    expect(client.replies).toEqual([
      expect.stringContaining(secondCode),
      expect.stringContaining(firstCode),
    ]);
    expect(router.listForUser("zhangsan")).toContainEqual(
      expect.objectContaining({
        code: firstCode,
        replyStage: "permission-denial-reason",
      }),
    );

    client.emit(
      "message",
      incomingMessage(
        "message-1-reason",
        `${firstCode} 请改用只读命令`,
        callbackUserId,
      ),
    );
    await vi.waitFor(() =>
      expect(firstPty.writes).toEqual(["2\r", "请改用只读命令\r"]),
    );
    expect(router.listForUser("zhangsan")).not.toContainEqual(
      expect.objectContaining({ code: firstCode }),
    );

    bridge.handleClaudeHook(
      hook(first.id, launchIds.get(first.id)!, "npm test -- third"),
    );
    await vi.waitFor(() => expect(client.sent).toHaveLength(3));
    const thirdCode = routeCode(markdownContent(client.sent[2].body));
    client.emit(
      "message",
      incomingMessage("other-user", `${thirdCode} 1`, "lisi"),
    );
    await vi.waitFor(() =>
      expect(firstPty.writes).toEqual([
        "2\r",
        "请改用只读命令\r",
        "1\r",
      ]),
    );
    expect(bridge.getState()).toMatchObject({
      lastInboundStatus: "routed",
      lastInboundDetail: expect.stringContaining(thirdCode),
    });

    bridge.dispose();
  });

  it("rejects unknown and stale reply codes without writing to a PTY", async () => {
    const firstPty = fakePty(1);
    const restartedPty = fakePty(2);
    const spawner = vi
      .fn()
      .mockReturnValueOnce(firstPty.process)
      .mockReturnValueOnce(restartedPty.process) as unknown as PtySpawner;
    const launches: string[] = [];
    const manager = new SessionManager(
      () => "C:\\Tools\\claude.exe",
      spawner,
      "win32",
      [],
      (_sessionId, launchId) => {
        launches.push(launchId);
        return { args: [] };
      },
    );
    const session = manager.createSession({
      projectId: "project-one",
      cwd: "C:\\work\\one",
    });
    const client = new FakeWeComClient();
    const bridge = new WeComBridge(
      manager,
      () => [],
      new RemoteReplyRouter(() => "ABCDE"),
      () => client as unknown as WeComClient,
    );
    bridge.configure({
      enabled: true,
      botId: "bot-id",
      targetUserId: "zhangsan",
      secret: "secret",
      hasSecret: true,
    });
    client.emit("authenticated");
    bridge.handleClaudeHook(hook(session.id, launches[0], "npm test"));
    await vi.waitFor(() => expect(client.sent).toHaveLength(1));

    client.emit(
      "message",
      incomingMessage("unauthorized", "ZZZZZ 1", "lisi"),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(firstPty.writes).toEqual([]);
    expect(bridge.getState()).toMatchObject({
      lastInboundStatus: "rejected",
      lastInboundDetail: expect.stringContaining("不存在、已过期"),
    });

    firstPty.emitExit(0);
    manager.restartSession(session.id);
    client.emit("message", incomingMessage("stale-reply", "ABCDE 1"));
    bridge.handleClaudeHook(hook(session.id, launches[0], "stale command"));
    await vi.waitFor(() =>
      expect(client.replies).toContainEqual(
        expect.stringContaining("不存在、已过期"),
      ),
    );
    expect(client.sent).toHaveLength(1);
    expect(restartedPty.writes).toEqual([]);

    bridge.dispose();
  });

  it("reports when another client takes over the same bot connection", () => {
    const manager = new SessionManager(
      () => "C:\\Tools\\claude.exe",
      vi.fn() as unknown as PtySpawner,
      "win32",
    );
    const client = new FakeWeComClient();
    const bridge = new WeComBridge(
      manager,
      () => [],
      new RemoteReplyRouter(),
      () => client as unknown as WeComClient,
    );
    bridge.configure({
      enabled: true,
      botId: "bot-id",
      targetUserId: "zhangsan",
      secret: "secret",
      hasSecret: true,
    });
    client.emit("authenticated");
    expect(bridge.getState().status).toBe("connected");

    client.emit("event.disconnected_event", disconnectedEvent());
    client.emit(
      "disconnected",
      "New connection established, server disconnected this connection",
    );

    expect(bridge.getState()).toMatchObject({
      status: "error",
      error: expect.stringContaining("其他客户端占用"),
    });

    bridge.dispose();
  });
});
