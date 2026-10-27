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
import type {
  ClaudeHookDecision,
  ClaudeHookEvent,
} from "../src/main/claude-hook-server";
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
const UP = "\x1b[A";

interface FakePty {
  process: IPty;
  writes: string[];
  emitExit(exitCode: number): void;
  emitData(data: string): void;
}

interface SimulatedMenu {
  /** Redraw the current menu and report it as the visible screen. */
  render(): void;
  /** Replace the menu (a new dialog) and redraw it. */
  show(header: string[], options: string[], pointer?: number): void;
  readonly pointer: number;
}

/**
 * Simulate Claude Code's menu rendering: every Down/Up written to the PTY
 * moves the focus pointer, Claude Code "redraws" the dialog (new PTY output)
 * and the renderer reports the new rows. This is what lets the bridge verify
 * where the pointer landed before it presses Enter.
 */
function simulateMenu(
  manager: SessionManager,
  sessionId: string,
  pty: FakePty,
  header: string[],
  options: string[],
  pointer = 0,
): SimulatedMenu {
  let currentHeader = [...header];
  let currentOptions = [...options];
  let focus = pointer;
  const lines = () => [
    ...currentHeader,
    ...currentOptions.map(
      (label, index) => `${index === focus ? "❯" : " "} ${index + 1}. ${label}`,
    ),
  ];
  const render = () => {
    pty.emitData(`${lines().join("\r\n")}\r\n`);
    manager.setTerminalVisibleLines({
      sessionId,
      sequence: manager.getTerminalSequence(sessionId),
      lines: lines(),
      viewportY: 0,
      rows: lines().length,
      columns: 120,
    });
  };
  const originalWrite = pty.process.write.bind(pty.process);
  pty.process.write = (data: string) => {
    originalWrite(data);
    if (data === DOWN) {
      focus = Math.min(currentOptions.length - 1, focus + 1);
      render();
    } else if (data === UP) {
      focus = Math.max(0, focus - 1);
      render();
    }
  };
  render();
  return {
    render,
    show(nextHeader, nextOptions, nextPointer = 0) {
      currentHeader = [...nextHeader];
      currentOptions = [...nextOptions];
      focus = nextPointer;
      render();
    },
    get pointer() {
      return focus;
    },
  };
}

const ALLOW_DENY = ["Yes", "No, and tell Claude what to do differently (esc)"];

function fakePty(pid: number): FakePty {
  let exitListener: (event: { exitCode: number; signal?: number }) => void = () =>
    undefined;
  let dataListener: (data: string) => void = () => undefined;
  const writes: string[] = [];
  return {
    process: {
      pid,
      process: "claude",
      cols: 120,
      rows: 36,
      handleFlowControl: false,
      onData: (listener) => {
        dataListener = listener;
        return { dispose: () => undefined };
      },
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
    emitData: (data) => dataListener(data),
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
  it("pushes generic permission notices without enabling guessed terminal actions", async () => {
    const pty = fakePty(1);
    let launchId = "";
    const manager = new SessionManager(
      () => "C:\\Tools\\claude.exe", (() => pty.process) as PtySpawner, "win32", [],
      (_id, currentLaunchId) => { launchId = currentLaunchId; return { args: [] }; },
    );
    const session = manager.createSession({ projectId: null, cwd: "C:\\work" });
    const client = new FakeWeComClient();
    const bridge = new WeComBridge(manager, () => [], undefined, () => client);
    bridge.configure({ enabled: true, botId: "bot-id", targetUserId: "zhangsan", secret: "secret", hasSecret: true });
    client.emit("authenticated");
    const event = hook(session.id, launchId, "unused");
    bridge.handleClaudeHook({
      ...event,
      payload: {
        ...event.payload,
        hook_event_name: "Notification",
        notification_type: "permission_prompt",
        message: "Claude Code 需要权限确认",
      },
    });
    await vi.waitFor(() => expect(client.sent).toHaveLength(1));
    const content = markdownContent(client.sent[0].body);
    expect(content).toContain("回到开发工作台");
    expect(content).not.toContain("回复码");
    client.emit("message", incomingMessage("unknown-menu", "拒绝", "zhangsan", content));
    await vi.waitFor(() => expect(client.replies).toContainEqual(expect.stringContaining("未提供完整权限选项")));
    expect(pty.writes).toEqual([]);
    bridge.dispose();
  });

  it("uses the currently rendered Claude permission labels when they are visible", async () => {
    const pty = fakePty(1);
    let launchId = "";
    const manager = new SessionManager(
      () => "C:\\Tools\\claude.exe",
      (() => pty.process) as PtySpawner,
      "win32",
      [],
      (_id, currentLaunchId) => {
        launchId = currentLaunchId;
        return { args: [] };
      },
    );
    const session = manager.createSession({ projectId: null, cwd: "C:\\work" });
    const client = new FakeWeComClient();
    const bridge = new WeComBridge(manager, () => [], undefined, () => client);
    bridge.configure({
      enabled: true,
      botId: "bot-id",
      targetUserId: "zhangsan",
      secret: "secret",
      hasSecret: true,
    });
    client.emit("authenticated");
    pty.emitData(
      "Do you want to proceed?\r\n" +
        "❯ 1. Yes\r\n" +
        "  2. Yes, and always allow access to dpms-interface-entry from this project\r\n" +
        "  3. No\r\n",
    );
    manager.setTerminalVisibleLines({
      sessionId: session.id,
      sequence: 1,
      lines: [
        "Do you want to proceed?",
        "❯ 1. Yes",
        "  2. Yes, and always allow access to dpms-interface-entry from this project",
        "  3. No",
      ],
      viewportY: 0,
      rows: 4,
      columns: 120,
    });
    bridge.handleClaudeHook({
      workspaceSessionId: session.id,
      launchId,
      payload: {
        session_id: `claude-${session.id}`,
        transcript_path: `C:\\transcripts\\${session.id}.jsonl`,
        cwd: "C:\\work",
        hook_event_name: "PermissionRequest",
        tool_name: "Write",
        tool_input: {
          file_path: "C:\\Users\\tianxiabai\\.claude\\skills\\dpms-interface-entry\\q_f790.js",
        },
        permission_suggestions: [
          {
            type: "setMode",
            mode: "acceptEdits",
            destination: "session",
          },
          {
            type: "addDirectories",
            directories: [
              "C:\\Users\\tianxiabai\\.claude\\skills\\dpms-interface-entry",
            ],
            destination: "session",
          },
        ],
      },
    });
    await vi.waitFor(() => expect(client.sent).toHaveLength(1));
    const content = markdownContent(client.sent[0].body);
    expect(content).toContain(
      "2. Yes, and always allow access to dpms-interface-entry from this project",
    );
    expect(content).toContain("3. No");
    expect(content).not.toContain("自动接受文件编辑");
    bridge.dispose();
  });

  it("waits for the dialog drawn after a permission Hook instead of using older rows", async () => {
    const pty = fakePty(1);
    let launchId = "";
    const manager = new SessionManager(
      () => "C:\\Tools\\claude.exe",
      (() => pty.process) as PtySpawner,
      "win32",
      [],
      (_id, currentLaunchId) => {
        launchId = currentLaunchId;
        return { args: [] };
      },
    );
    const session = manager.createSession({ projectId: null, cwd: "C:\\work" });
    const client = new FakeWeComClient();
    const bridge = new WeComBridge(manager, () => [], undefined, () => client);
    bridge.configure({
      enabled: true,
      botId: "bot-id",
      targetUserId: "zhangsan",
      secret: "secret",
      hasSecret: true,
    });
    client.emit("authenticated");
    // The screen before the dialog: an earlier permission menu is still in
    // the reported rows, but newer output has not been laid out yet.
    pty.emitData("❯ 1. Yes\r\n  2. No\r\n");
    manager.setTerminalVisibleLines({
      sessionId: session.id,
      sequence: 1,
      lines: ["❯ 1. Yes", "  2. No"],
      viewportY: 0,
      rows: 2,
      columns: 120,
    });
    pty.emitData("⏺ Bash(npm test)\r\n");
    bridge.handleClaudeHook(hook(session.id, launchId, "npm test"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(client.sent).toHaveLength(0);

    // Claude Code draws the dialog for this Hook.
    pty.emitData("❯ 1. Yes\r\n  2. Yes, and don't ask again for npm test commands\r\n  3. No\r\n");
    manager.setTerminalVisibleLines({
      sessionId: session.id,
      sequence: 3,
      lines: [
        "⏺ Bash(npm test)",
        "❯ 1. Yes",
        "  2. Yes, and don't ask again for npm test commands",
        "  3. No",
      ],
      viewportY: 0,
      rows: 4,
      columns: 120,
    });
    await vi.waitFor(() => expect(client.sent).toHaveLength(1));
    const content = markdownContent(client.sent[0].body);
    expect(content).toContain("2. Yes, and don't ask again for npm test commands");
    expect(content).toContain("3. No");

    // Answering by position now matches the screen.
    const code = routeCode(content);
    client.emit("message", incomingMessage("rendered-menu", `${code} 1`));
    await vi.waitFor(() => expect(pty.writes.length).toBeGreaterThan(0));
    bridge.dispose();
  });

  it("only pushes completion notices while the owner is away from the computer", async () => {
    const pty = fakePty(1);
    let launchId = "";
    const manager = new SessionManager(
      () => "C:\\Tools\\claude.exe", (() => pty.process) as PtySpawner, "win32", [],
      (_id, currentLaunchId) => { launchId = currentLaunchId; return { args: [] }; },
    );
    const session = manager.createSession({ projectId: null, cwd: "C:\\work" });
    const client = new FakeWeComClient();
    let away = false;
    const bridge = new WeComBridge(
      manager,
      () => [],
      undefined,
      () => client,
      undefined,
      () => away,
    );
    bridge.configure({ enabled: true, botId: "bot-id", targetUserId: "zhangsan", secret: "secret", hasSecret: true });
    client.emit("authenticated");
    const stop = (message: string): ClaudeHookEvent => ({
      workspaceSessionId: session.id,
      launchId,
      payload: {
        session_id: `claude-${session.id}`,
        transcript_path: `C:\\transcripts\\${session.id}.jsonl`,
        cwd: "C:\\work",
        hook_event_name: "Stop",
        last_assistant_message: message,
      },
    });

    bridge.handleClaudeHook(stop("第一轮已经完成。"));
    expect(bridge.getState().lastClaudeHookDetail).toContain("你正在使用电脑");

    // Prompts that block Claude Code are pushed even while the owner is here.
    bridge.handleClaudeHook(hook(session.id, launchId, "npm test"));
    await vi.waitFor(() => expect(client.sent).toHaveLength(1));
    expect(markdownContent(client.sent[0].body)).toContain("npm test");

    away = true;
    bridge.handleClaudeHook(stop("第二轮已经完成。"));
    await vi.waitFor(() => expect(client.sent).toHaveLength(2));
    expect(markdownContent(client.sent[1].body)).toContain("第二轮已经完成");
    bridge.dispose();
  });

  it("binds allow and deny to the first and last rows whatever Claude Code inserted", async () => {
    const pty = fakePty(1);
    let launchId = "";
    const manager = new SessionManager(
      () => "C:\\Tools\\claude.exe", (() => pty.process) as PtySpawner, "win32", [],
      (_id, currentLaunchId) => { launchId = currentLaunchId; return { args: [] }; },
    );
    const session = manager.createSession({ projectId: null, cwd: "C:\\work" });
    const client = new FakeWeComClient();
    const bridge = new WeComBridge(manager, () => [], undefined, () => client);
    bridge.configure({ enabled: true, botId: "bot-id", targetUserId: "zhangsan", secret: "secret", hasSecret: true });
    client.emit("authenticated");

    // The Hook describes allow / deny (two rows)...
    bridge.handleClaudeHook(hook(session.id, launchId, "npm test"));
    await vi.waitFor(() => expect(client.sent).toHaveLength(1));
    const code = routeCode(markdownContent(client.sent[0].body));

    // ...but Claude Code draws two extra rows the Hook knows nothing about.
    simulateMenu(manager, session.id, pty, ["⏺ Bash(npm test)"], [
      "Yes",
      "Yes, and don't ask again for npm test commands in this project",
      "Yes, and enable auto mode",
      "No, and tell Claude what to do differently (esc)",
    ]);
    const writesBefore = pty.writes.length;

    // "2" meant deny in the notification: it must land on the last row, not
    // on the persistent-allow row that now sits at position 2.
    client.emit("message", incomingMessage("deny", `${code} 2`));
    await vi.waitFor(() =>
      expect(pty.writes.slice(writesBefore)).toEqual([DOWN, DOWN, DOWN, "\r"]),
    );
    expect(client.replies).toContainEqual(expect.stringContaining("已选择拒绝"));
    bridge.dispose();
  });

  it("asks for confirmation before taking a middle row the notification did not show", async () => {
    const pty = fakePty(1);
    let launchId = "";
    const manager = new SessionManager(
      () => "C:\\Tools\\claude.exe", (() => pty.process) as PtySpawner, "win32", [],
      (_id, currentLaunchId) => { launchId = currentLaunchId; return { args: [] }; },
    );
    const session = manager.createSession({ projectId: null, cwd: "C:\\work" });
    const client = new FakeWeComClient();
    const bridge = new WeComBridge(manager, () => [], undefined, () => client);
    bridge.configure({ enabled: true, botId: "bot-id", targetUserId: "zhangsan", secret: "secret", hasSecret: true });
    client.emit("authenticated");

    // The notice has three rows (allow, one remembered rule, deny)...
    bridge.handleClaudeHook({
      ...hook(session.id, launchId, "npm test"),
      payload: {
        ...hook(session.id, launchId, "npm test").payload,
        permission_suggestions: [
          {
            type: "addRules",
            rules: [{ toolName: "Bash", ruleContent: "npm test:*" }],
            behavior: "allow",
            destination: "localSettings",
          },
        ],
      },
    });
    await vi.waitFor(() => expect(client.sent).toHaveLength(1));
    const notice = markdownContent(client.sent[0].body);
    expect(notice).toContain("3. 拒绝");
    const code = routeCode(notice);

    // ...but the terminal shows four, so row 2 may not mean the same thing.
    simulateMenu(manager, session.id, pty, ["⏺ Bash(npm test)"], [
      "Yes",
      "Yes, and don't ask again for npm test commands in this project",
      "Yes, and enable auto mode",
      "No, and tell Claude what to do differently (esc)",
    ]);
    const writesBefore = pty.writes.length;
    client.emit("message", incomingMessage("middle-row", `${code} 2`));
    await vi.waitFor(() =>
      expect(client.replies).toContainEqual(expect.stringContaining("未发送任何按键")),
    );
    const refusal = client.replies[client.replies.length - 1];
    expect(refusal).toContain("通知中的权限菜单有 3 项，终端当前有 4 项");
    expect(refusal).toContain("终端当前菜单：");
    expect(refusal).toContain("❯ 1. Yes");
    expect(refusal).toContain("  3. Yes, and enable auto mode");
    expect(refusal).toContain("确认 N");
    expect(pty.writes.slice(writesBefore)).toEqual([]);

    // "菜单" re-sends the real menu without touching the terminal.
    client.emit("message", incomingMessage("menu", `${code} 菜单`));
    await vi.waitFor(() => expect(client.replies).toHaveLength(2));
    expect(client.replies[1]).toContain("  4. No, and tell Claude what to do differently (esc)");
    expect(pty.writes.slice(writesBefore)).toEqual([]);

    // After seeing the real menu the user confirms a row by its terminal
    // number. The pointer is moved there and checked before Enter.
    client.emit("message", incomingMessage("confirm", `${code} 确认 2`));
    await vi.waitFor(() =>
      expect(pty.writes.slice(writesBefore)).toEqual([DOWN, "\r"]),
    );
    await vi.waitFor(() =>
      expect(bridge.getState()).toMatchObject({
        lastInboundStatus: "routed",
        lastInboundDetail: expect.stringContaining("菜单操作写入"),
      }),
    );
    bridge.dispose();
  });

  it("does not press Enter when the pointer cannot be confirmed on the chosen row", async () => {
    const pty = fakePty(1);
    let launchId = "";
    const manager = new SessionManager(
      () => "C:\\Tools\\claude.exe", (() => pty.process) as PtySpawner, "win32", [],
      (_id, currentLaunchId) => { launchId = currentLaunchId; return { args: [] }; },
    );
    const session = manager.createSession({ projectId: null, cwd: "C:\\work" });
    const client = new FakeWeComClient();
    const bridge = new WeComBridge(manager, () => [], undefined, () => client);
    bridge.configure({ enabled: true, botId: "bot-id", targetUserId: "zhangsan", secret: "secret", hasSecret: true });
    client.emit("authenticated");
    bridge.handleClaudeHook(hook(session.id, launchId, "npm test"));
    await vi.waitFor(() => expect(client.sent).toHaveLength(1));
    const code = routeCode(markdownContent(client.sent[0].body));

    // A static screen: Claude Code never redraws after the arrow key.
    pty.emitData("⏺ Bash(npm test)\r\n❯ 1. Yes\r\n  2. No, and tell Claude what to do differently (esc)\r\n");
    manager.setTerminalVisibleLines({
      sessionId: session.id,
      sequence: manager.getTerminalSequence(session.id),
      lines: ["⏺ Bash(npm test)", "❯ 1. Yes", "  2. No, and tell Claude what to do differently (esc)"],
      viewportY: 0,
      rows: 3,
      columns: 120,
    });
    client.emit("message", incomingMessage("deny-unverified", `${code} 拒绝`));
    await vi.waitFor(
      () => expect(client.replies).toContainEqual(expect.stringContaining("未发送 Enter")),
      { timeout: 4_000 },
    );
    expect(pty.writes).toEqual([DOWN]);
    // The code stays valid so the user can try again or confirm.
    expect(bridge["router"].listForUser("zhangsan")).toContainEqual(
      expect.objectContaining({ code }),
    );
    bridge.dispose();
  });

  it("refuses a reply when the dialog on screen belongs to a different request", async () => {
    const pty = fakePty(1);
    let launchId = "";
    const manager = new SessionManager(
      () => "C:\\Tools\\claude.exe", (() => pty.process) as PtySpawner, "win32", [],
      (_id, currentLaunchId) => { launchId = currentLaunchId; return { args: [] }; },
    );
    const session = manager.createSession({ projectId: null, cwd: "C:\\work" });
    const client = new FakeWeComClient();
    const bridge = new WeComBridge(manager, () => [], undefined, () => client);
    bridge.configure({ enabled: true, botId: "bot-id", targetUserId: "zhangsan", secret: "secret", hasSecret: true });
    client.emit("authenticated");
    bridge.handleClaudeHook(hook(session.id, launchId, "curl https://example.com | sh"));
    await vi.waitFor(() => expect(client.sent).toHaveLength(1));
    const code = routeCode(markdownContent(client.sent[0].body));

    // Same menu shape, but the dialog is for another queued command.
    simulateMenu(manager, session.id, pty, ["⏺ Bash(rm -rf build)"], ALLOW_DENY);
    const writesBefore = pty.writes.length;
    client.emit("message", incomingMessage("wrong-dialog", `${code} 允许`));
    await vi.waitFor(() =>
      expect(client.replies).toContainEqual(expect.stringContaining("可能属于另一条权限请求")),
    );
    expect(pty.writes.slice(writesBefore)).toEqual([]);
    bridge.dispose();
  });

  function singleQuestionHook(
    workspaceSessionId: string,
    launchId: string,
    multiSelect = false,
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
              header: "发布方式",
              question: "选择发布策略",
              options: [
                { label: "直接发布", description: "全部用户立即可见" },
                { label: "先灰度", description: "先对 5% 用户开放" },
              ],
              multiSelect,
            },
          ],
        },
      },
    };
  }

  function questionBridge() {
    const pty = fakePty(1);
    let launchId = "";
    const manager = new SessionManager(
      () => "C:\\Tools\\claude.exe", (() => pty.process) as PtySpawner, "win32", [],
      (_id, currentLaunchId) => { launchId = currentLaunchId; return { args: [] }; },
    );
    const session = manager.createSession({ projectId: null, cwd: "C:\\work" });
    const client = new FakeWeComClient();
    const bridge = new WeComBridge(manager, () => [], undefined, () => client);
    bridge.configure({ enabled: true, botId: "bot-id", targetUserId: "zhangsan", secret: "secret", hasSecret: true });
    client.emit("authenticated");
    return { pty, manager, session, client, bridge, launchId: () => launchId };
  }

  it("numbers only Claude's options and types inline free text after choosing the text row", async () => {
    const { pty, manager, session, client, bridge, launchId } = questionBridge();
    // This Claude Code layout: options, Type something, then Chat about this.
    simulateMenu(manager, session.id, pty, ["☐ 发布方式", "", "选择发布策略", ""], [
      "直接发布",
      "先灰度",
      "Type something.",
      "Chat about this",
    ]);
    bridge.handleClaudeHook(singleQuestionHook(session.id, launchId()));
    await vi.waitFor(() => expect(client.sent).toHaveLength(1));
    const notice = markdownContent(client.sent[0].body);
    expect(notice).toContain("1. 直接发布");
    expect(notice).toContain("2. 先灰度");
    expect(notice).not.toContain("3.");
    expect(notice).toContain("其他：你的内容");
    const code = routeCode(notice);
    const writesBefore = pty.writes.length;

    client.emit("message", incomingMessage("inline-other", `${code} 其他：分批发布，先 1% 再 10%`));
    await vi.waitFor(
      () =>
        expect(pty.writes.slice(writesBefore)).toEqual([
          DOWN,
          DOWN,
          "\r",
          "分批发布，先 1% 再 10%\r",
        ]),
      { timeout: 3_000 },
    );
    expect(client.replies[client.replies.length - 1]).toContain("菜单操作和回复文字写入");
    expect(bridge["router"].listForUser("zhangsan")).toEqual([]);
    bridge.dispose();
  });

  it("finds the chat row where the terminal draws it and falls back to a text hint otherwise", async () => {
    const { pty, manager, session, client, bridge, launchId } = questionBridge();
    // A multi-select question: no chat row at all.
    simulateMenu(manager, session.id, pty, ["☐ 发布方式"], ["直接发布", "先灰度", "Type something"]);
    bridge.handleClaudeHook(singleQuestionHook(session.id, launchId(), true));
    await vi.waitFor(() => expect(client.sent).toHaveLength(1));
    const code = routeCode(markdownContent(client.sent[0].body));
    const writesBefore = pty.writes.length;

    // Numbers beyond the notification are explained by what is on screen.
    client.emit("message", incomingMessage("out-of-range", `${code} 3`));
    await vi.waitFor(() =>
      expect(client.replies).toContainEqual(expect.stringContaining("其他：你的内容")),
    );
    expect(pty.writes.slice(writesBefore)).toEqual([]);

    // Multi-select: toggle each bound row with Space, then submit.
    client.emit("message", incomingMessage("multi", `${code} 1,2`));
    await vi.waitFor(() =>
      expect(pty.writes.slice(writesBefore)).toEqual([" ", DOWN, " ", "\r"]),
    );
    bridge.dispose();
  });

  it("probes for an unnumbered Chat about this row before pressing Enter", async () => {
    const { pty, manager, session, client, bridge, launchId } = questionBridge();
    // Preview layout: the chat row is drawn without a number and only shows
    // its pointer once focused.
    let focus = 0;
    const rows = ["直接发布", "先灰度", "Type something."];
    const render = () => {
      const lines = [
        "☐ 发布方式",
        ...rows.map((label, index) => `${index === focus ? "❯" : " "} ${index + 1}. ${label}`),
        "  ────────────",
        `${focus === rows.length ? "❯" : " "} Chat about this`,
      ];
      pty.emitData(`${lines.join("\r\n")}\r\n`);
      manager.setTerminalVisibleLines({
        sessionId: session.id,
        sequence: manager.getTerminalSequence(session.id),
        lines,
        viewportY: 0,
        rows: lines.length,
        columns: 120,
      });
    };
    const originalWrite = pty.process.write.bind(pty.process);
    pty.process.write = (data: string) => {
      originalWrite(data);
      if (data === DOWN) {
        focus = Math.min(rows.length, focus + 1);
        render();
      }
    };
    render();
    bridge.handleClaudeHook(singleQuestionHook(session.id, launchId()));
    await vi.waitFor(() => expect(client.sent).toHaveLength(1));
    const code = routeCode(markdownContent(client.sent[0].body));
    const writesBefore = pty.writes.length;

    client.emit("message", incomingMessage("chat", `${code} 讨论：灰度比例能否调成 20%`));
    await vi.waitFor(
      () =>
        expect(pty.writes.slice(writesBefore)).toEqual([
          DOWN,
          DOWN,
          DOWN,
          "\r",
          "灰度比例能否调成 20%\r",
        ]),
      { timeout: 3_000 },
    );
    bridge.dispose();
  });

  /** A Hook decision handle as the Hook server would attach it. */
  function fakeDecision() {
    let held = false;
    let settled = false;
    const outputs: Array<Record<string, unknown>> = [];
    const releases: number[] = [];
    const listeners: Array<(reason: "responded" | "released" | "closed") => void> = [];
    const finish = (reason: "responded" | "released" | "closed") => {
      if (settled) return;
      settled = true;
      held = false;
      for (const listener of listeners.splice(0)) listener(reason);
    };
    const decision: ClaudeHookDecision = {
      hold: () => {
        if (!settled) held = true;
      },
      get held() {
        return held && !settled;
      },
      get settled() {
        return settled;
      },
      respond: (output) => {
        if (settled) return false;
        outputs.push(output);
        finish("responded");
        return true;
      },
      release: () => {
        if (settled) return false;
        releases.push(Date.now());
        finish("released");
        return true;
      },
      onSettled: (listener) => {
        if (!settled) listeners.push(listener);
      },
    };
    return { decision, outputs, releases, close: () => finish("closed") };
  }

  function heldBridge(away = () => true) {
    const pty = fakePty(1);
    let launchId = "";
    const manager = new SessionManager(
      () => "C:\\Tools\\claude.exe", (() => pty.process) as PtySpawner, "win32", [],
      (_id, currentLaunchId) => { launchId = currentLaunchId; return { args: [] }; },
    );
    const session = manager.createSession({ projectId: null, cwd: "C:\\work" });
    const client = new FakeWeComClient();
    const bridge = new WeComBridge(manager, () => [], undefined, () => client, undefined, away);
    bridge.configure({
      enabled: true, botId: "bot-id", targetUserId: "zhangsan", secret: "secret", hasSecret: true,
      holdPromptsWhileAway: true,
    });
    client.emit("authenticated");
    return { pty, manager, session, client, bridge, launchId: () => launchId };
  }

  it("answers a held permission Hook directly from WeCom without touching the terminal", async () => {
    const { pty, session, client, bridge, launchId } = heldBridge();
    const handle = fakeDecision();
    const event: ClaudeHookEvent = { ...hook(session.id, launchId(), "npm test"), decision: handle.decision };
    bridge.handleClaudeHook(event);
    expect(handle.decision.held).toBe(true);
    await vi.waitFor(() => expect(client.sent).toHaveLength(1));
    expect(bridge.getState().heldPrompts).toEqual([
      expect.objectContaining({ sessionId: session.id, kind: "permission" }),
    ]);
    const code = routeCode(markdownContent(client.sent[0].body));

    // "菜单" has nothing to show: no dialog exists while the Hook is held.
    client.emit("message", incomingMessage("menu", `${code} 菜单`));
    await vi.waitFor(() =>
      expect(client.replies).toContainEqual(expect.stringContaining("终端上没有菜单")),
    );

    client.emit("message", incomingMessage("allow", `${code} 允许`));
    await vi.waitFor(() => expect(handle.outputs).toHaveLength(1));
    expect(handle.outputs[0]).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "allow" },
      },
    });
    expect(pty.writes).toEqual([]);
    expect(bridge.getState().heldPrompts).toEqual([]);
    expect(bridge["router"].listForUser("zhangsan")).toEqual([]);
    expect(client.replies[client.replies.length - 1]).toContain("已通过 Hook 直接回复");
    bridge.dispose();
  });

  it("denies a held permission with the reason sent in the second message", async () => {
    const { pty, session, client, bridge, launchId } = heldBridge();
    const handle = fakeDecision();
    bridge.handleClaudeHook({ ...hook(session.id, launchId(), "rm -rf build"), decision: handle.decision });
    await vi.waitFor(() => expect(client.sent).toHaveLength(1));
    const code = routeCode(markdownContent(client.sent[0].body));
    client.emit("message", incomingMessage("deny", `${code} 拒绝`));
    await vi.waitFor(() =>
      expect(client.replies).toContainEqual(expect.stringContaining("已选择拒绝")),
    );
    expect(handle.outputs).toEqual([]);
    client.emit("message", incomingMessage("reason", `${code} 先列出会删除的文件`));
    await vi.waitFor(() => expect(handle.outputs).toHaveLength(1));
    expect(handle.outputs[0]).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "deny", message: "先列出会删除的文件" },
      },
    });
    expect(pty.writes).toEqual([]);
    bridge.dispose();
  });

  it("answers a held question through PreToolUse with the chosen label", async () => {
    const { pty, session, client, bridge, launchId } = heldBridge();
    const handle = fakeDecision();
    bridge.handleClaudeHook({ ...singleQuestionHook(session.id, launchId()), decision: handle.decision });
    await vi.waitFor(() => expect(client.sent).toHaveLength(1));
    const code = routeCode(markdownContent(client.sent[0].body));
    client.emit("message", incomingMessage("answer", `${code} 2`));
    await vi.waitFor(() => expect(handle.outputs).toHaveLength(1));
    expect(handle.outputs[0]).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        updatedInput: expect.objectContaining({
          answers: { 选择发布策略: "先灰度" },
        }),
      },
    });
    expect(pty.writes).toEqual([]);
    bridge.dispose();
  });

  it("hands a held prompt back to the terminal when the owner types locally or returns", async () => {
    let away = true;
    const { manager, session, client, bridge, launchId } = heldBridge(() => away);
    const first = fakeDecision();
    bridge.handleClaudeHook({ ...hook(session.id, launchId(), "npm test"), decision: first.decision });
    await vi.waitFor(() => expect(client.sent).toHaveLength(1));
    const code = routeCode(markdownContent(client.sent[0].body));

    // Local keyboard input: the owner is answering in the terminal.
    manager.write(session.id, "\r");
    expect(first.releases).toHaveLength(1);
    expect(first.decision.settled).toBe(true);
    expect(bridge.getState().heldPrompts).toEqual([]);
    client.emit("message", incomingMessage("late", `${code} 允许`));
    await vi.waitFor(() =>
      expect(client.replies).toContainEqual(expect.stringContaining("不存在或已过期")),
    );

    // Owner comes back to the computer: presence polling releases the hold.
    const second = fakeDecision();
    bridge.handleClaudeHook({ ...hook(session.id, launchId(), "npm run build"), decision: second.decision });
    await vi.waitFor(() => expect(client.sent).toHaveLength(2));
    expect(second.decision.held).toBe(true);
    away = false;
    await vi.waitFor(() => expect(second.releases).toHaveLength(1), { timeout: 5_000 });
    // The reply code survives: the dialog is now on screen for the menu path.
    expect(bridge["router"].listForUser("zhangsan")).toContainEqual(
      expect.objectContaining({ code: routeCode(markdownContent(client.sent[1].body)) }),
    );
    bridge.dispose();
  });

  it("falls back to the terminal menu when Claude Code stopped waiting for the Hook", async () => {
    const { pty, manager, session, client, bridge, launchId } = heldBridge();
    const handle = fakeDecision();
    bridge.handleClaudeHook({ ...hook(session.id, launchId(), "npm test"), decision: handle.decision });
    await vi.waitFor(() => expect(client.sent).toHaveLength(1));
    const code = routeCode(markdownContent(client.sent[0].body));
    // Claude Code gives up and draws its dialog.
    handle.close();
    expect(bridge.getState().heldPrompts).toEqual([]);
    simulateMenu(manager, session.id, pty, ["⏺ Bash(npm test)"], ALLOW_DENY);
    const writesBefore = pty.writes.length;
    client.emit("message", incomingMessage("allow-late", `${code} 允许`));
    await vi.waitFor(() => expect(pty.writes.slice(writesBefore)).toEqual(["\r"]));
    expect(handle.outputs).toEqual([]);
    bridge.dispose();
  });

  it("hands held prompts back to the terminal when the WeCom connection drops", async () => {
    const { session, client, bridge, launchId } = heldBridge();
    const handle = fakeDecision();
    bridge.handleClaudeHook({ ...hook(session.id, launchId(), "npm test"), decision: handle.decision });
    await vi.waitFor(() => expect(client.sent).toHaveLength(1));
    expect(handle.decision.held).toBe(true);
    client.emit("disconnected", "socket closed");
    expect(handle.releases).toHaveLength(1);
    expect(bridge.getState().heldPrompts).toEqual([]);
    // Without a live connection no new prompt is held either.
    const next = fakeDecision();
    bridge.handleClaudeHook({ ...hook(session.id, launchId(), "npm run build"), decision: next.decision });
    expect(next.decision.held).toBe(false);
    bridge.dispose();
  });

  it("refuses to act on a screen that has not caught up with newer output", async () => {
    const { pty, manager, session, client, bridge, launchId } = questionBridge();
    simulateMenu(manager, session.id, pty, ["⏺ Bash(npm test)"], ALLOW_DENY);
    bridge.handleClaudeHook(hook(session.id, launchId(), "npm test"));
    await vi.waitFor(() => expect(client.sent).toHaveLength(1));
    const code = routeCode(markdownContent(client.sent[0].body));
    // Claude Code printed more (the dialog may be gone) but the renderer has
    // not reported the new rows.
    pty.emitData("⏺ Running npm test…\r\n");
    const writesBefore = pty.writes.length;
    client.emit("message", incomingMessage("stale", `${code} 允许`));
    await vi.waitFor(
      () => expect(client.replies).toContainEqual(expect.stringContaining("无法读取终端当前画面")),
      { timeout: 3_000 },
    );
    expect(pty.writes.slice(writesBefore)).toEqual([]);
    bridge.dispose();
  });

  it("does not attach an older permission menu to a plan notification", async () => {
    const { pty, manager, session, client, bridge, launchId } = questionBridge();
    // A finished permission dialog is still the newest screen when the plan
    // Hook arrives.
    simulateMenu(manager, session.id, pty, ["⏺ Bash(npm test)"], ["Yes", "Yes, and don't ask again", "No"]);
    bridge.handleClaudeHook({
      workspaceSessionId: session.id,
      launchId: launchId(),
      payload: {
        session_id: `claude-${session.id}`,
        transcript_path: "t.jsonl",
        cwd: "C:\\work",
        hook_event_name: "PreToolUse",
        tool_name: "ExitPlanMode",
        tool_input: { plan: "1. 补测试\n2. 重构" },
      },
    });
    await vi.waitFor(() => expect(client.sent).toHaveLength(1), { timeout: 4_000 });
    const notice = markdownContent(client.sent[0].body);
    expect(notice).not.toContain("don't ask again");
    expect(notice).not.toContain("终端当前选项");
    bridge.dispose();
  });

  it("does not hold prompts while the owner is at the computer or when disabled", async () => {
    const atComputer = heldBridge(() => false);
    const handle = fakeDecision();
    atComputer.bridge.handleClaudeHook({
      ...hook(atComputer.session.id, atComputer.launchId(), "npm test"),
      decision: handle.decision,
    });
    expect(handle.decision.held).toBe(false);
    atComputer.bridge.dispose();

    const disabled = heldBridge();
    disabled.bridge.configure({
      enabled: true, botId: "bot-id", targetUserId: "zhangsan", secret: "secret", hasSecret: true,
      holdPromptsWhileAway: false,
    });
    disabled.client.emit("authenticated");
    const other = fakeDecision();
    disabled.bridge.handleClaudeHook({
      ...hook(disabled.session.id, disabled.launchId(), "npm test"),
      decision: other.decision,
    });
    expect(other.decision.held).toBe(false);
    expect(disabled.bridge.getState().holdPromptsWhileAway).toBe(false);
    disabled.bridge.dispose();
  });

  it("keeps unsent queued notifications until reauthentication and drops invalidated routes", async () => {
    const launches = new Map<string, string>();
    const manager = new SessionManager(
      () => "C:\\Tools\\claude.exe",
      (() => fakePty(1).process) as PtySpawner,
      "win32", [],
      (id, launchId) => {
        launches.set(id, launchId);
        return { args: [] };
      },
    );
    const first = manager.createSession({ projectId: null, cwd: "C:\\work" });
    const second = manager.createSession({ projectId: null, cwd: "C:\\work" });
    const stale = manager.createSession({ projectId: null, cwd: "C:\\work" });
    const client = new FakeWeComClient();
    let acknowledge: (value: unknown) => void = () => undefined;
    const send = vi.spyOn(client, "sendMessage").mockImplementationOnce(
      () => new Promise((resolve) => { acknowledge = resolve; }),
    );
    const bridge = new WeComBridge(manager, () => [], undefined, () => client);
    bridge.configure({ enabled: true, botId: "bot-id", targetUserId: "zhangsan", secret: "secret", hasSecret: true });
    client.emit("authenticated");
    for (const session of [first, second, stale]) {
      bridge.handleClaudeHook(hook(session.id, launches.get(session.id)!, session.id));
    }
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    client.emit("reconnecting", 1);
    manager.write(stale.id, "local input");
    acknowledge({});
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(send).toHaveBeenCalledTimes(1);

    client.emit("authenticated");
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(markdownContent(send.mock.calls[1][1])).toContain(second.id);
    bridge.dispose();
  });

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
    expect(bridge.isClaudePushEnabled()).toBe(false);
    bridge.configure({
      enabled: true,
      botId: "bot-id",
      targetUserId: "zhangsan",
      secret: "secret",
      hasSecret: true,
    });
    expect(bridge.isClaudePushEnabled()).toBe(true);
    client.emit("authenticated");

    // Both terminals show their own dialog; the simulator redraws them when
    // the bridge moves the pointer.
    const firstMenu = simulateMenu(manager, first.id, firstPty, ["⏺ Bash(npm test -- first)"], ALLOW_DENY);
    simulateMenu(manager, second.id, secondPty, ["⏺ Bash(npm test -- second)"], ALLOW_DENY);
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
    expect(bridge.getState()).toMatchObject({
      lastClaudeHookAt: expect.any(Number),
      lastClaudeHookDetail: expect.stringContaining("接收人 zhangsan"),
    });
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
    await vi.waitFor(() =>
      expect(bridge.getState()).toMatchObject({
        lastInboundStatus: "routed",
        lastInboundDetail: expect.stringMatching(
          new RegExp(`${secondCode}.*菜单操作写入.*等待 Claude Code 处理`, "u"),
        ),
      }),
    );

    client.emit(
      "message",
      incomingMessage("message-1", `${firstCode} 2`, callbackUserId),
    );
    await vi.waitFor(() => expect(firstPty.writes).toEqual([DOWN, "\r"]));
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
      expect(firstPty.writes).toEqual([DOWN, "\r", "请改用只读命令\r"]),
    );
    expect(router.listForUser("zhangsan")).not.toContainEqual(
      expect.objectContaining({ code: firstCode }),
    );

    firstMenu.show(["⏺ Bash(npm test -- third)"], ALLOW_DENY);
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
        DOWN,
        "\r",
        "请改用只读命令\r",
        "\r",
      ]),
    );
    await vi.waitFor(() =>
      expect(bridge.getState()).toMatchObject({
        lastInboundStatus: "routed",
        lastInboundDetail: expect.stringContaining(thirdCode),
      }),
    );

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
        DOWN,
        "\r",
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

    const menu = simulateMenu(manager, session.id, pty, ["⏺ Bash(npm test -- first)"], ALLOW_DENY);
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

    menu.show(["⏺ Bash(npm test -- second)"], ALLOW_DENY);
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
    await vi.waitFor(() =>
      expect(bridge.getState()).toMatchObject({
        lastInboundStatus: "routed",
        lastInboundDetail: expect.stringContaining(secondCode),
      }),
    );

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

    simulateMenu(
      manager,
      session.id,
      pty,
      ["☐ 文件类型", "", "你想创建什么类型的文件？", ""],
      ["文本文件", "Markdown 文档", "Type something."],
    );
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
      expect(pty.writes).toEqual([
        "\x1b[12;34R",
        "1",
        "2",
        "\r",
      ]),
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

  it("keeps group automation traffic out of the Claude Code management bot", async () => {
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

    const frame = incomingGroupMessage(
      "group-message-1",
      "group-one",
      "  /run 每日报告  ",
      "lisi",
      "[RPT-ABCDEF1234] 上次报告",
    );
    client.emit("message", frame);

    await vi.waitFor(() =>
      expect(bridge.getState().lastInboundStatus).toBe("ignored"),
    );
    expect(bridge.getState()).toMatchObject({
      lastInboundStatus: "ignored",
      lastInboundDetail: expect.stringContaining("企业微信智能机器人"),
    });
    expect(client.replies).toEqual([]);
    expect(client.sent).toEqual([]);

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
