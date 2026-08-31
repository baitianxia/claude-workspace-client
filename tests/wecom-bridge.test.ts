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

const DOWN = "\x1b[B";

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

function multipleQuestionHook(
  workspaceSessionId: string,
  launchId: string,
): ClaudeHookEvent {
  return {
    workspaceSessionId,
    launchId,
    payload: {
      session_id: `claude-${workspaceSessionId}`,
      transcript_path: `C:\\transcripts\\${workspaceSessionId}.jsonl`,
      cwd: "C:\\work\\mall",
      hook_event_name: "PreToolUse",
      tool_name: "AskUserQuestion",
      tool_input: {
        questions: [
          {
            header: "文件类型",
            question: "你想创建什么类型的文件？",
            options: [
              { label: "文本文件", description: "普通文本文件" },
              { label: "Markdown 文档", description: "笔记或说明文件" },
            ],
            multiSelect: false,
          },
          {
            header: "文件内容",
            question: "文件内容大概是什么？",
            options: [
              { label: "空文件", description: "内容之后再说" },
              { label: "描述内容", description: "稍后输入具体内容" },
            ],
            multiSelect: false,
          },
        ],
      },
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

function incomingGroupMessage(
  msgid: string,
  chatid: string,
  content: string,
  userid = "zhangsan",
  quotedContent?: string,
): WsFrame<BaseMessage> {
  return {
    headers: { req_id: `request-${msgid}` },
    body: {
      msgid,
      aibotid: "bot-id",
      chattype: "group",
      chatid,
      from: { userid },
      msgtype: "text",
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
  } as WsFrame<BaseMessage>;
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
        const codes = ["AAAAA", "BBBBB", "CCCCC", "DDDDD"];
        return () => codes.shift() ?? "EEEEE";
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
    expect(markdownContent(client.sent[0].body).indexOf("> 回复码：")).toBeLessThan(
      markdownContent(client.sent[0].body).indexOf("> 工程："),
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
        "允许",
        callbackUserId,
        markdownContent(client.sent[1].body),
      ),
    );
    await vi.waitFor(() => expect(secondPty.writes).toEqual(["\r"]));
    expect(firstPty.writes).toEqual([]);
    expect(bridge.getState()).toMatchObject({
      lastInboundStatus: "routed",
      lastInboundDetail: expect.stringMatching(
        new RegExp(`${secondCode}.*菜单操作写入.*等待 Claude Code 处理`, "u"),
      ),
    });

    client.emit(
      "message",
      incomingMessage("message-1", `${firstCode} 2`, callbackUserId),
    );
    await vi.waitFor(() => expect(firstPty.writes).toEqual([`${DOWN}\r`]));
    expect(secondPty.writes).toEqual(["\r"]);
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
      expect(firstPty.writes).toEqual([`${DOWN}\r`, "请改用只读命令\r"]),
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
        `${DOWN}\r`,
        "请改用只读命令\r",
        "\r",
      ]),
    );
    expect(bridge.getState()).toMatchObject({
      lastInboundStatus: "routed",
      lastInboundDetail: expect.stringContaining(thirdCode),
    });

    bridge.handleClaudeHook({
      workspaceSessionId: first.id,
      launchId: launchIds.get(first.id)!,
      payload: {
        session_id: `claude-${first.id}`,
        transcript_path: `C:\\transcripts\\${first.id}.jsonl`,
        cwd: "C:\\work\\one",
        hook_event_name: "Stop",
        last_assistant_message: "修复已经完成。请输入 1 继续发布。",
      },
    });
    await vi.waitFor(() => expect(client.sent).toHaveLength(4));
    const textCode = routeCode(markdownContent(client.sent[3].body));
    expect(markdownContent(client.sent[3].body)).toContain("直接发送回复内容");
    client.emit(
      "message",
      incomingMessage("text-input", `${textCode} 1`, callbackUserId),
    );
    await vi.waitFor(() =>
      expect(firstPty.writes).toEqual([
        `${DOWN}\r`,
        "请改用只读命令\r",
        "\r",
        "1\r",
      ]),
    );
    expect(bridge.getState()).toMatchObject({
      lastInboundStatus: "routed",
      lastInboundDetail: expect.stringMatching(
        new RegExp(`${textCode}.*回复文字写入.*等待 Claude Code 处理`, "u"),
      ),
    });

    bridge.dispose();
  });

  it("keeps pending routes through passive terminal protocol reports", async () => {
    const pty = fakePty(1);
    let launchId = "";
    const manager = new SessionManager(
      () => "C:\\Tools\\claude.exe",
      (() => pty.process) as PtySpawner,
      "win32",
      [],
      (_sessionId, currentLaunchId) => {
        launchId = currentLaunchId;
        return { args: [] };
      },
    );
    const session = manager.createSession({
      projectId: null,
      cwd: "C:\\work\\one",
    });
    const client = new FakeWeComClient();
    const codes = ["ABCDE", "QWERT"];
    const router = new RemoteReplyRouter(() => codes.shift() ?? "ROUTE");
    const bridge = new WeComBridge(
      manager,
      () => [],
      router,
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

    bridge.handleClaudeHook(hook(session.id, launchId, "npm test -- first"));
    await vi.waitFor(() => expect(client.sent).toHaveLength(1));
    const firstCode = routeCode(markdownContent(client.sent[0].body));
    const controlInput = [
      "\x1b[O",
      "\x1b[I",
      "\x1b[<0;10;5M",
      "\x1b[?1;2c",
      "\x1b[0n",
      "\x1b[12;34R",
      "\x1b[?12;34R",
      "\x1b[8;36;120t",
      "\x1b[?2004;1$y",
      "\x1bP1$r0m\x1b\\",
      "\x1b]10;rgb:ffff/ffff/ffff\x1b\\",
      "\x1b[I\x1b[12;34R",
    ];
    for (const data of controlInput) {
      manager.write(session.id, data);
    }
    expect(router.listForUser("zhangsan")).toContainEqual(
      expect.objectContaining({ code: firstCode }),
    );

    client.emit(
      "message",
      incomingMessage("direct-after-focus", `${firstCode} 1`),
    );
    await vi.waitFor(() =>
      expect(pty.writes).toEqual([...controlInput, "\r"]),
    );

    bridge.handleClaudeHook(hook(session.id, launchId, "npm test -- second"));
    await vi.waitFor(() => expect(client.sent).toHaveLength(2));
    const secondCode = routeCode(markdownContent(client.sent[1].body));
    manager.write(session.id, "\x1b[O");
    client.emit(
      "message",
      incomingMessage(
        "truncated-quote",
        "1",
        "zhangsan",
        "Claude Workspace:\nClaude Code 需要权限确认\n工程：临时会话…",
      ),
    );
    await vi.waitFor(() =>
      expect(pty.writes).toEqual([...controlInput, "\r", "\x1b[O", "\r"]),
    );
    expect(bridge.getState()).toMatchObject({
      lastInboundStatus: "routed",
      lastInboundDetail: expect.stringContaining(secondCode),
    });

    bridge.dispose();
  });

  it("routes line-separated answers after xterm protocol responses", async () => {
    const pty = fakePty(1);
    let launchId = "";
    const manager = new SessionManager(
      () => "C:\\Tools\\claude.exe",
      (() => pty.process) as PtySpawner,
      "win32",
      [],
      (_sessionId, currentLaunchId) => {
        launchId = currentLaunchId;
        return { args: [] };
      },
    );
    const session = manager.createSession({
      projectId: null,
      cwd: "C:\\work\\one",
    });
    const client = new FakeWeComClient();
    const router = new RemoteReplyRouter(() => "QUEST");
    const bridge = new WeComBridge(
      manager,
      () => [],
      router,
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

    bridge.handleClaudeHook(multipleQuestionHook(session.id, launchId));
    await vi.waitFor(() => expect(client.sent).toHaveLength(1));
    const notification = markdownContent(client.sent[0].body);
    expect(notification).toContain("问题间用分号或换行");

    manager.write(session.id, "\x1b[12;34R");
    client.emit(
      "message",
      incomingMessage(
        "line-separated-answer",
        "1\n2",
        "zhangsan",
        notification,
      ),
    );

    await vi.waitFor(() =>
      expect(pty.writes).toEqual(["\x1b[12;34R", `\r${DOWN}\r`]),
    );
    expect(bridge.getState()).toMatchObject({
      lastInboundStatus: "routed",
      lastInboundDetail: expect.stringContaining("QUEST"),
    });
    expect(router.listForUser("zhangsan")).toEqual([]);

    bridge.dispose();
  });

  it("expires a pending route when local keyboard input changes the menu", async () => {
    const pty = fakePty(1);
    let launchId = "";
    const manager = new SessionManager(
      () => "C:\\Tools\\claude.exe",
      (() => pty.process) as PtySpawner,
      "win32",
      [],
      (_sessionId, currentLaunchId) => {
        launchId = currentLaunchId;
        return { args: [] };
      },
    );
    const session = manager.createSession({
      projectId: null,
      cwd: "C:\\work\\one",
    });
    const client = new FakeWeComClient();
    const router = new RemoteReplyRouter(() => "ABCDE");
    const bridge = new WeComBridge(
      manager,
      () => [],
      router,
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
    bridge.handleClaudeHook(hook(session.id, launchId, "npm test"));
    await vi.waitFor(() => expect(client.sent).toHaveLength(1));

    manager.write(session.id, DOWN);
    expect(router.listForUser("zhangsan")).toEqual([]);
    client.emit("message", incomingMessage("after-local-answer", "ABCDE 1"));
    await vi.waitFor(() =>
      expect(client.replies).toContainEqual(
        expect.stringContaining("回复码 ABCDE 不存在或已过期"),
      ),
    );
    expect(pty.writes).toEqual([DOWN]);

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
      lastInboundDetail: expect.stringContaining("不存在或已过期"),
    });

    firstPty.emitExit(0);
    manager.restartSession(session.id);
    client.emit("message", incomingMessage("stale-reply", "ABCDE 1"));
    bridge.handleClaudeHook(hook(session.id, launches[0], "stale command"));
    await vi.waitFor(() =>
      expect(client.replies).toContainEqual(
        expect.stringContaining("不存在或已过期"),
      ),
    );
    expect(client.sent).toHaveLength(1);
    expect(restartedPty.writes).toEqual([]);

    bridge.dispose();
  });

  it("routes group messages and outbound reports through the shared bot connection", async () => {
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
    const businessHandler = vi.fn().mockResolvedValue({
      status: "accepted" as const,
      message: "已触发任务。",
    });
    bridge.setBusinessMessageHandler(businessHandler);
    bridge.configure({
      enabled: true,
      botId: "bot-id",
      targetUserId: "zhangsan",
      secret: "secret",
      hasSecret: true,
    });
    client.emit("authenticated");

    const frame = incomingGroupMessage(
      "group-message-1",
      "group-one",
      "  /run 每日报告  ",
      "lisi",
      "[RPT-ABCDEF1234] 上次报告",
    );
    client.emit("message", frame);

    await vi.waitFor(() => expect(businessHandler).toHaveBeenCalledTimes(1));
    expect(businessHandler).toHaveBeenCalledWith({
      messageId: "group-message-1",
      chatId: "group-one",
      userId: "lisi",
      text: "/run 每日报告",
      quoteText: "[RPT-ABCDEF1234] 上次报告",
    });
    await vi.waitFor(() => expect(client.replies).toEqual(["已触发任务。"]));
    expect(bridge.getState()).toMatchObject({
      lastInboundStatus: "routed",
      lastInboundDetail: "已触发任务。",
    });

    client.emit("message", frame);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(businessHandler).toHaveBeenCalledTimes(1);

    await bridge.sendMarkdown("group-one", "# [RPT-ABCDEF1234]\n报告正文");
    expect(client.sent).toEqual([
      {
        chatId: "group-one",
        body: {
          msgtype: "markdown",
          markdown: { content: "# [RPT-ABCDEF1234]\n报告正文" },
        },
      },
    ]);

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
