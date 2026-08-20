import { EventEmitter } from "node:events";
import {
  generateReqId,
  WSClient,
  type BaseMessage,
  type EventMessage,
  type SendMsgBody,
  type WsFrame,
  type WsFrameHeaders,
} from "@wecom/aibot-node-sdk";
import type {
  ProjectRecord,
  SessionRecord,
  WeComInboundStatus,
  WeComState,
} from "../shared/contracts";
import { attentionFromClaudeHook } from "./claude-attention";
import type { ClaudeHookEvent } from "./claude-hook-server";
import {
  RemoteReplyRouter,
  terminalActionForRemoteReply,
  type PendingRemoteReply,
} from "./remote-reply-router";
import type { SessionManager, SessionInputEvent } from "./session-manager";

export interface WeComRuntimeConfiguration {
  enabled: boolean;
  botId: string;
  targetUserId: string;
  secret?: string;
  hasSecret: boolean;
  configurationError?: string;
}

interface WeComBridgeEvents {
  stateChanged: [state: WeComState];
}

export interface WeComClient {
  connect(): unknown;
  disconnect(): void;
  on(event: "authenticated", listener: () => void): unknown;
  on(event: "connected", listener: () => void): unknown;
  on(event: "disconnected", listener: (reason: string) => void): unknown;
  on(event: "reconnecting", listener: (attempt: number) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(
    event: "message",
    listener: (frame: WsFrame<BaseMessage>) => void,
  ): unknown;
  on(
    event: "event.disconnected_event",
    listener: (frame: WsFrame<EventMessage>) => void,
  ): unknown;
  sendMessage(chatId: string, body: SendMsgBody): Promise<unknown>;
  replyStream(
    frame: WsFrameHeaders,
    streamId: string,
    content: string,
    finish?: boolean,
  ): Promise<unknown>;
}

export type WeComClientFactory = (options: {
  botId: string;
  secret: string;
}) => WeComClient;

function defaultClientFactory(options: {
  botId: string;
  secret: string;
}): WeComClient {
  return new WSClient({
    ...options,
    maxReconnectAttempts: -1,
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: (message) => console.warn(`[WeCom] ${message}`),
      error: (message) => console.error(`[WeCom] ${message}`),
    },
  });
}

function copyState(state: WeComState): WeComState {
  return { ...state };
}

function readableError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) {
    return value;
  }
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maxBytes - Buffer.byteLength("…", "utf8")) {
      break;
    }
    result += character;
    bytes += characterBytes;
  }
  return `${result}…`;
}

function quoteText(message: BaseMessage): string {
  const quote = (message as BaseMessage & { quote?: unknown }).quote;
  if (!quote) {
    return "";
  }
  if (typeof quote === "string") {
    return quote;
  }
  if (typeof quote !== "object" || Array.isArray(quote)) {
    return "";
  }
  const value = quote as {
    content?: unknown;
    quote_text?: unknown;
    text?: { content?: unknown };
    markdown?: { content?: unknown };
    voice?: { content?: unknown };
    mixed?: { msg_item?: Array<{ text?: { content?: unknown } }> };
  };
  const candidates = [
    value.content,
    value.quote_text,
    value.text?.content,
    value.markdown?.content,
    value.voice?.content,
    ...(value.mixed?.msg_item?.map((item) => item.text?.content) ?? []),
  ].filter(
    (candidate): candidate is string =>
      typeof candidate === "string" && candidate.trim().length > 0,
  );
  return [...new Set(candidates)].join("\n");
}

function incomingMessageText(message: BaseMessage): string {
  const text = (message as BaseMessage & { text?: { content?: unknown } }).text
    ?.content;
  if (typeof text === "string") {
    return text;
  }
  const voice = (
    message as BaseMessage & { voice?: { content?: unknown } }
  ).voice?.content;
  if (typeof voice === "string") {
    return voice;
  }
  const items = (
    message as BaseMessage & {
      mixed?: { msg_item?: Array<{ text?: { content?: unknown } }> };
    }
  ).mixed?.msg_item;
  return (
    items
      ?.flatMap((item) =>
        typeof item.text?.content === "string" ? [item.text.content] : [],
      )
      .join("\n") ?? ""
  );
}

function isSupersededConnection(reason: string): boolean {
  return /new connection (?:has been )?established/iu.test(reason);
}

function projectDisplayName(project: ProjectRecord | undefined): string {
  return project?.alias?.trim() || project?.name || "未知工程";
}

function notificationMarkdown(
  pending: PendingRemoteReply,
  session: SessionRecord,
  project: ProjectRecord | undefined,
): string {
  const workspace =
    session.projectId === null ? "临时会话" : projectDisplayName(project);
  const replyGuidance =
    (pending.questionSelectionModes?.length ?? 0) > 1
      ? {
          quoted:
            "发送 `1;2,3`（每题可用编号或完整选项文字；问题间用分号，多选项用逗号）",
          directExample: "1;2,3",
        }
      : pending.kind === "permission"
        ? {
            quoted: "发送上方选项编号、`允许`/`拒绝`或完整选项文字",
            directExample: "允许",
          }
        : pending.kind === "question" && pending.inputMode === "menu"
          ? pending.supportsMultipleSelection
            ? {
                quoted: "发送 `1,3`，也可用逗号分隔完整选项文字",
                directExample: "1,3",
              }
            : {
                quoted: "发送上方选项编号或完整选项文字，例如 `1`",
                directExample: "1",
              }
          : pending.inputMode === "menu"
            ? pending.supportsMultipleSelection
              ? {
                  quoted: "发送上方选项编号，例如 `1,3`",
                  directExample: "1,3",
                }
              : {
                  quoted: "发送上方选项编号，例如 `1`",
                  directExample: "1",
                }
            : {
                quoted: "直接发送回复内容",
                directExample: "继续处理并运行测试",
              };
  const prefix = [
    `# ${pending.title}`,
    `> 回复码：\`${pending.code}\``,
    `> 工程：${workspace}`,
    `> 会话：${session.title}`,
    `> 工作目录：${session.cwd}`,
    "",
  ].join("\n");
  const suffix = [
    "",
    "## 如何回复",
    `- 引用本消息回复：${replyGuidance.quoted}，无需重复输入回复码。`,
    `- 不引用消息：发送 \`${pending.code} ${replyGuidance.directExample}\`。`,
    `回复码 \`${pending.code}\` 只对应当前 Claude Code 进程，不能用于其他会话。`,
  ].join("\n");
  const maxMarkdownBytes = 18_000;
  const bodyBudget = Math.max(
    256,
    maxMarkdownBytes -
      Buffer.byteLength(prefix, "utf8") -
      Buffer.byteLength(suffix, "utf8"),
  );
  return `${prefix}${truncateUtf8(pending.body, bodyBudget)}${suffix}`;
}

function localInputInvalidatesPendingReply(data: string): boolean {
  const isFocusReport = data === "\x1b[I" || data === "\x1b[O";
  const isSgrMouseReport = /^\x1b\[<[0-9;]+[Mm]$/u.test(data);
  const isX10MouseReport = /^\x1b\[M[\s\S]{3}$/u.test(data);
  return (
    Boolean(data) &&
    !isFocusReport &&
    !isSgrMouseReport &&
    !isX10MouseReport
  );
}

export class WeComBridge extends EventEmitter<WeComBridgeEvents> {
  private client: WeComClient | null = null;
  private configuration: WeComRuntimeConfiguration = {
    enabled: false,
    botId: "",
    targetUserId: "",
    hasSecret: false,
  };
  private state: WeComState = {
    enabled: false,
    configured: false,
    hasSecret: false,
    botId: "",
    targetUserId: "",
    status: "disabled",
  };
  private readonly unsentCodes = new Set<string>();
  private readonly sendingCodes = new Set<string>();
  private readonly processedMessageIds = new Set<string>();
  private authenticatedClient: WeComClient | null = null;
  private supersededClient: WeComClient | null = null;
  private retryTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly sessionManager: SessionManager,
    private readonly listProjects: () => ProjectRecord[],
    private readonly router = new RemoteReplyRouter(),
    private readonly clientFactory: WeComClientFactory = defaultClientFactory,
    private readonly availabilityError?: string,
  ) {
    super();
    this.sessionManager.on("input", this.handleSessionInput);
    this.sessionManager.on("changed", this.handleSessionChanged);
  }

  getState(): WeComState {
    return copyState(this.state);
  }

  shouldInjectClaudeHooks(): boolean {
    return Boolean(
      !this.availabilityError &&
        this.configuration.enabled &&
        this.configuration.botId &&
        this.configuration.targetUserId &&
        this.configuration.hasSecret &&
        !this.configuration.configurationError,
    );
  }

  configure(configuration: WeComRuntimeConfiguration): WeComState {
    this.client?.disconnect();
    this.client = null;
    this.authenticatedClient = null;
    this.supersededClient = null;
    this.clearRetry();
    this.configuration = { ...configuration, secret: undefined };
    this.router.clearAll();
    this.unsentCodes.clear();
    this.sendingCodes.clear();
    this.processedMessageIds.clear();

    const configured = Boolean(
      configuration.botId &&
        configuration.targetUserId &&
        configuration.hasSecret,
    );
    if (!configuration.enabled) {
      this.updateState({
        enabled: false,
        configured,
        hasSecret: configuration.hasSecret,
        botId: configuration.botId,
        targetUserId: configuration.targetUserId,
        status: "disabled",
      });
      return this.getState();
    }

    if (
      !configured ||
      !configuration.secret ||
      configuration.configurationError ||
      this.availabilityError
    ) {
      this.updateState({
        enabled: true,
        configured,
        hasSecret: configuration.hasSecret,
        botId: configuration.botId,
        targetUserId: configuration.targetUserId,
        status: "error",
        error:
          this.availabilityError ??
          configuration.configurationError ??
          "企业微信 Bot ID、Secret 和接收用户 userid 均不能为空。",
      });
      return this.getState();
    }

    this.updateState({
      enabled: true,
      configured: true,
      hasSecret: true,
      botId: configuration.botId,
      targetUserId: configuration.targetUserId,
      status: "connecting",
    });

    try {
      const client = this.clientFactory({
        botId: configuration.botId,
        secret: configuration.secret,
      });
      this.client = client;
      this.attachClient(client);
      client.connect();
    } catch (error) {
      this.fail(`无法连接企业微信智能机器人：${readableError(error)}`);
    }
    return this.getState();
  }

  handleClaudeHook(event: ClaudeHookEvent): void {
    if (
      !this.shouldInjectClaudeHooks() ||
      !this.sessionManager.isCurrentLaunch(
        event.workspaceSessionId,
        event.launchId,
      )
    ) {
      return;
    }
    const attention = attentionFromClaudeHook(event);
    if (!attention) {
      return;
    }
    const result = this.router.register(
      this.configuration.targetUserId,
      attention,
    );
    this.pruneDeliveryState();
    if (!result.shouldSend) {
      return;
    }
    this.unsentCodes.add(result.pending.code);
    void this.sendPending(result.pending);
  }

  dispose(): void {
    this.sessionManager.off("input", this.handleSessionInput);
    this.sessionManager.off("changed", this.handleSessionChanged);
    this.client?.disconnect();
    this.client = null;
    this.authenticatedClient = null;
    this.supersededClient = null;
    this.clearRetry();
    this.router.clearAll();
    this.unsentCodes.clear();
    this.sendingCodes.clear();
  }

  private readonly handleSessionInput = (event: SessionInputEvent) => {
    if (
      event.source === "local" &&
      localInputInvalidatesPendingReply(event.data)
    ) {
      const code = this.router.clearWorkspaceSession(event.sessionId);
      if (code) {
        this.unsentCodes.delete(code);
      }
    }
  };

  private readonly handleSessionChanged = (session: SessionRecord) => {
    if (session.status !== "running") {
      const code = this.router.clearWorkspaceSession(session.id);
      if (code) {
        this.unsentCodes.delete(code);
      }
    }
  };

  private attachClient(client: WeComClient): void {
    client.on("connected", () => {
      if (this.client === client && this.state.status !== "connected") {
        this.updateState({ ...this.state, status: "connecting" });
      }
    });
    client.on("authenticated", () => {
      if (this.client !== client) {
        return;
      }
      this.authenticatedClient = client;
      this.supersededClient = null;
      this.clearRetry();
      this.updateState({ ...this.state, status: "connected", error: undefined });
      void this.flushUnsent();
    });
    client.on("reconnecting", () => {
      if (this.client === client) {
        this.authenticatedClient = null;
        this.clearRetry();
        this.updateState({ ...this.state, status: "connecting" });
      }
    });
    client.on("disconnected", (reason) => {
      if (this.client === client) {
        this.authenticatedClient = null;
        this.clearRetry();
        if (
          this.supersededClient === client ||
          isSupersededConnection(reason)
        ) {
          this.supersededClient = client;
          this.updateState({
            ...this.state,
            status: "error",
            error:
              "连接被其他客户端占用，请关闭使用相同 Bot ID/Secret 的客户端或改用独立机器人。",
          });
          return;
        }
        this.updateState({
          ...this.state,
          status: "connecting",
          error: reason || "企业微信连接已断开，正在重连。",
        });
      }
    });
    client.on("error", (error) => {
      if (this.client === client) {
        this.authenticatedClient = null;
        this.clearRetry();
        this.fail(`企业微信连接错误：${readableError(error)}`);
      }
    });
    client.on("event.disconnected_event", () => {
      if (this.client === client) {
        this.authenticatedClient = null;
        this.supersededClient = client;
        this.clearRetry();
        this.updateState({
          ...this.state,
          status: "error",
          error:
            "连接被其他客户端占用，请关闭使用相同 Bot ID/Secret 的客户端或改用独立机器人。",
        });
      }
    });
    client.on("message", (frame) => {
      if (this.client === client) {
        void this.handleIncomingMessage(client, frame).catch((error: unknown) => {
          if (this.client !== client) {
            return;
          }
          const detail = `处理企业微信回复失败：${readableError(error)}`;
          this.recordInbound("failed", detail);
          void this.replyToMessage(client, frame, detail);
        });
      }
    });
  }

  private async handleIncomingMessage(
    client: WeComClient,
    frame: WsFrame<BaseMessage>,
  ): Promise<void> {
    const message = frame.body;
    if (!message) {
      return;
    }
    if (this.processedMessageIds.has(message.msgid)) {
      return;
    }
    this.processedMessageIds.add(message.msgid);
    if (this.processedMessageIds.size > 2_000) {
      const oldest = this.processedMessageIds.values().next().value;
      if (typeof oldest === "string") {
        this.processedMessageIds.delete(oldest);
      }
    }

    if (message.chattype !== "single") {
      this.recordInbound("ignored", "收到群聊消息，已按安全策略忽略。");
      return;
    }
    const messageText = incomingMessageText(message);
    if (!messageText.trim()) {
      const detail = "收到消息，但其中没有可用于路由的文本。";
      this.recordInbound("rejected", detail);
      await this.replyToMessage(client, frame, detail);
      return;
    }
    const quotedText = quoteText(message);
    const resolved = this.router.resolve(
      this.configuration.targetUserId,
      messageText,
      quotedText,
    );
    this.recordInbound(
      "received",
      "已收到企业微信回复，正在按回复码匹配 Claude Code 会话。",
    );
    if (resolved.status === "rejected") {
      this.recordInbound("rejected", resolved.message);
      await this.replyToMessage(client, frame, resolved.message);
      return;
    }

    const { pending } = resolved;
    if (
      !this.sessionManager.isCurrentLaunch(
        pending.workspaceSessionId,
        pending.launchId,
      )
    ) {
      this.router.complete(pending.code);
      const detail = `回复码 ${pending.code} 对应的 Claude Code 进程已经退出或重启，未发送任何输入。`;
      this.recordInbound("rejected", detail);
      await this.replyToMessage(
        client,
        frame,
        detail,
      );
      return;
    }

    let action: ReturnType<typeof terminalActionForRemoteReply>;
    try {
      action = terminalActionForRemoteReply(pending, resolved.reply);
    } catch (error) {
      const detail =
        error instanceof Error ? error.message : "远程回复格式无效。";
      this.recordInbound("rejected", detail);
      await this.replyToMessage(
        client,
        frame,
        detail,
      );
      return;
    }
    if (
      action.nextStage &&
      !this.router.setReplyStage(pending.code, action.nextStage)
    ) {
      const detail = `回复码 ${pending.code} 已失效，未发送任何输入。`;
      this.recordInbound("rejected", detail);
      await this.replyToMessage(client, frame, detail);
      return;
    }
    const written = this.sessionManager.writeRemoteReply(
      pending.workspaceSessionId,
      action.input,
    );
    if (!written) {
      this.router.complete(pending.code);
      const detail = `回复码 ${pending.code} 对应的 Claude Code 进程已不可用，未发送任何输入。`;
      this.recordInbound("failed", detail);
      await this.replyToMessage(
        client,
        frame,
        detail,
      );
      return;
    }

    if (action.nextStage) {
      const detail =
        `${action.followUpMessage ?? "请继续回复具体内容。"}\n` +
        `回复码：\`${pending.code}\`。该回复码仍对应当前 Claude Code 会话。`;
      this.recordInbound("routed", detail);
      await this.replyToMessage(client, frame, detail);
      return;
    }

    this.router.complete(pending.code);
    this.unsentCodes.delete(pending.code);
    const inputDescription =
      pending.replyStage || pending.inputMode === "text"
        ? "回复文字"
        : "菜单操作";
    const detail =
      `已将回复码 ${pending.code} 对应的${inputDescription}写入 Claude Code 终端，` +
      "正在等待 Claude Code 处理。";
    this.recordInbound("routed", detail);
    const confirmed = await this.replyToMessage(
      client,
      frame,
      detail,
    );
    if (!confirmed) {
      this.recordInbound(
        "routed",
        `${detail} 企业微信确认消息发送失败，请在客户端终端确认执行状态。`,
      );
    }
  }

  private async replyToMessage(
    client: WeComClient,
    frame: WsFrameHeaders,
    content: string,
  ): Promise<boolean> {
    try {
      await client.replyStream(
        frame,
        generateReqId("claude_workspace"),
        content,
        true,
      );
      return true;
    } catch (error) {
      console.error("Failed to reply to WeCom message", error);
      if (this.client !== client) {
        return false;
      }
      try {
        await client.sendMessage(this.configuration.targetUserId, {
          msgtype: "markdown",
          markdown: { content },
        });
        return true;
      } catch (fallbackError) {
        console.error("Failed to send WeCom reply fallback", fallbackError);
        return false;
      }
    }
  }

  private recordInbound(status: WeComInboundStatus, detail: string): void {
    this.updateState({
      ...this.state,
      lastInboundAt: Date.now(),
      lastInboundStatus: status,
      lastInboundDetail: detail,
    });
  }

  private async sendPending(pending: PendingRemoteReply): Promise<void> {
    const client = this.client;
    if (
      !client ||
      this.authenticatedClient !== client ||
      this.sendingCodes.has(pending.code)
    ) {
      return;
    }
    this.sendingCodes.add(pending.code);
    const session = this.sessionManager
      .listSessions()
      .find((candidate) => candidate.id === pending.workspaceSessionId);
    if (
      !session ||
      !this.sessionManager.isCurrentLaunch(
        pending.workspaceSessionId,
        pending.launchId,
      )
    ) {
      this.router.complete(pending.code);
      this.unsentCodes.delete(pending.code);
      this.sendingCodes.delete(pending.code);
      return;
    }
    const project = this.listProjects().find(
      (candidate) => candidate.id === session.projectId,
    );
    try {
      await client.sendMessage(this.configuration.targetUserId, {
        msgtype: "markdown",
        markdown: { content: notificationMarkdown(pending, session, project) },
      });
      if (this.client === client) {
        this.unsentCodes.delete(pending.code);
        if (this.state.status === "error") {
          this.updateState({
            ...this.state,
            status: "connected",
            error: undefined,
          });
        }
      }
    } catch (error) {
      if (this.client === client) {
        this.fail(`企业微信消息推送失败：${readableError(error)}`);
        this.scheduleRetry();
      }
    } finally {
      this.sendingCodes.delete(pending.code);
    }
  }

  private async flushUnsent(): Promise<void> {
    const pending = this.router
      .listForUser(this.configuration.targetUserId)
      .filter((entry) => this.unsentCodes.has(entry.code));
    for (const entry of pending) {
      await this.sendPending(entry);
    }
  }

  private pruneDeliveryState(): void {
    const activeCodes = new Set(
      this.router
        .listForUser(this.configuration.targetUserId)
        .map((pending) => pending.code),
    );
    for (const code of this.unsentCodes) {
      if (!activeCodes.has(code)) {
        this.unsentCodes.delete(code);
      }
    }
  }

  private scheduleRetry(): void {
    if (
      this.retryTimer ||
      !this.client ||
      this.authenticatedClient !== this.client ||
      this.unsentCodes.size === 0
    ) {
      return;
    }
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.flushUnsent();
    }, 5_000);
    this.retryTimer.unref();
  }

  private clearRetry(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private fail(error: string): void {
    this.updateState({ ...this.state, status: "error", error });
  }

  private updateState(state: WeComState): void {
    this.state = {
      ...state,
      ...(state.error ? { error: state.error } : {}),
    };
    if (!state.error) {
      delete this.state.error;
    }
    this.emit("stateChanged", this.getState());
  }
}
