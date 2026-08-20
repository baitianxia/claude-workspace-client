import { EventEmitter } from "node:events";
import {
  generateReqId,
  WSClient,
  type SendMsgBody,
  type TextMessage,
  type WsFrame,
  type WsFrameHeaders,
} from "@wecom/aibot-node-sdk";
import type {
  ProjectRecord,
  SessionRecord,
  WeComState,
} from "../shared/contracts";
import { attentionFromClaudeHook } from "./claude-attention";
import type { ClaudeHookEvent } from "./claude-hook-server";
import {
  RemoteReplyRouter,
  terminalInputForRemoteReply,
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
    event: "message.text",
    listener: (frame: WsFrame<TextMessage>) => void,
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

function quoteText(message: TextMessage): string {
  const quote = message.quote;
  if (!quote) {
    return "";
  }
  if (quote.text?.content) {
    return quote.text.content;
  }
  if (quote.voice?.content) {
    return quote.voice.content;
  }
  return (
    quote.mixed?.msg_item
      .flatMap((item) => (item.text?.content ? [item.text.content] : []))
      .join("\n") ?? ""
  );
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
  const menuHint =
    (pending.questionSelectionModes?.length ?? 0) > 1
      ? `回复示例：\`${pending.code} 1;2,3\`（问题间用分号，多选项用逗号）`
      : pending.kind === "permission"
        ? `回复示例：\`${pending.code} 允许\` 或 \`${pending.code} 拒绝\`（也可回复上方编号）`
      : pending.expectsMenuSelection
        ? pending.supportsMultipleSelection
          ? `回复示例：\`${pending.code} 1,3\``
          : `回复示例：\`${pending.code} 1\`（按终端选项编号）`
        : `回复示例：\`${pending.code} 继续处理并运行测试\``;
  const prefix = [
    `# ${pending.title}`,
    `> 工程：${workspace}`,
    `> 会话：${session.title}`,
    `> 回复码：\`${pending.code}\``,
    "",
  ].join("\n");
  const suffix = [
    "",
    menuHint,
    `为防止多个 Claude Code 进程串线，回复时必须带回复码 \`${pending.code}\`。`,
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
    this.clearRetry();
    this.router.clearAll();
    this.unsentCodes.clear();
    this.sendingCodes.clear();
  }

  private readonly handleSessionInput = (event: SessionInputEvent) => {
    if (event.source === "local") {
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
    client.on("message.text", (frame) => {
      if (this.client === client) {
        void this.handleTextMessage(client, frame);
      }
    });
  }

  private async handleTextMessage(
    client: WeComClient,
    frame: WsFrame<TextMessage>,
  ): Promise<void> {
    const message = frame.body;
    if (
      !message ||
      message.chattype !== "single" ||
      message.from?.userid !== this.configuration.targetUserId
    ) {
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
    const resolved = this.router.resolve(
      message.from.userid,
      message.text?.content ?? "",
      quoteText(message),
    );
    if (resolved.status === "rejected") {
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
      await this.replyToMessage(
        client,
        frame,
        `回复码 ${pending.code} 对应的 Claude Code 进程已经退出或重启，未发送任何输入。`,
      );
      return;
    }

    let input: string;
    try {
      input = terminalInputForRemoteReply(pending, resolved.reply);
    } catch (error) {
      await this.replyToMessage(
        client,
        frame,
        error instanceof Error ? error.message : "远程回复格式无效。",
      );
      return;
    }
    const written = this.sessionManager.writeRemoteReply(
      pending.workspaceSessionId,
      input,
    );
    if (!written) {
      this.router.complete(pending.code);
      await this.replyToMessage(
        client,
        frame,
        `回复码 ${pending.code} 对应的 Claude Code 进程已不可用，未发送任何输入。`,
      );
      return;
    }

    this.router.complete(pending.code);
    this.unsentCodes.delete(pending.code);
    await this.replyToMessage(
      client,
      frame,
      `已将回复码 ${pending.code} 的消息发送到对应 Claude Code 会话。`,
    );
  }

  private async replyToMessage(
    client: WeComClient,
    frame: WsFrameHeaders,
    content: string,
  ): Promise<void> {
    try {
      await client.replyStream(
        frame,
        generateReqId("claude_workspace"),
        content,
        true,
      );
    } catch (error) {
      console.error("Failed to reply to WeCom message", error);
    }
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
