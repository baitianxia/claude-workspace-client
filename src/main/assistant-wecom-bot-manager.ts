import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  generateReqId,
  WSClient,
  type BaseMessage,
  type EventMessage,
  type WsFrame,
  type WsFrameHeaders,
} from "@wecom/aibot-node-sdk";
import type {
  AssistantWeComBotProfile,
  UpsertAssistantWeComBotRequest,
  WeComInboundStatus,
} from "../shared/contracts";
import {
  AssistantStore,
  type StoredAssistantWeComBot,
} from "./assistant-store";
import type { SecretProtector } from "./wecom-settings";
import type { WeComClient, WeComClientFactory } from "./wecom-bridge";

export interface AssistantWeComMessage {
  botProfileId: string;
  messageId: string;
  chatType: "single" | "group";
  /** Group chatid for group messages, or sender userid for single chat. */
  chatId: string;
  userId: string;
  text: string;
  quoteText: string;
}

export interface AssistantWeComMessageResult {
  status: "accepted" | "rejected";
  message: string;
}

export type AssistantWeComMessageHandler = (
  message: AssistantWeComMessage,
) => Promise<AssistantWeComMessageResult | null>;

interface AssistantWeComBotManagerEvents {
  stateChanged: [];
}

interface BotRuntime {
  record: StoredAssistantWeComBot;
  state: AssistantWeComBotProfile;
  client: WeComClient | null;
  authenticatedClient: WeComClient | null;
  supersededClient: WeComClient | null;
  processedMessageIds: Set<string>;
}

const MAX_MARKDOWN_BYTES = 18_000;

function readableError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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
      warn: (message) => console.warn(`[Assistant WeCom] ${message}`),
      error: (message) => console.error(`[Assistant WeCom] ${message}`),
    },
  });
}

function requireText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") {
    throw new Error(`${label}必须是字符串。`);
  }
  const normalized = value.trim();
  if (
    !normalized ||
    [...normalized].length > maximum ||
    /\p{Cc}/u.test(normalized)
  ) {
    throw new Error(`${label}格式无效。`);
  }
  return normalized;
}

function validInboundIdentifier(value: string): boolean {
  return (
    Boolean(value) &&
    [...value].length <= 200 &&
    !/\p{Cc}|\s/u.test(value)
  );
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

function profileState(
  record: StoredAssistantWeComBot,
  previous?: AssistantWeComBotProfile,
): AssistantWeComBotProfile {
  return {
    id: record.id,
    name: record.name,
    enabled: record.enabled,
    configured: Boolean(record.botId && record.encryptedSecret),
    hasSecret: Boolean(record.encryptedSecret),
    botId: record.botId,
    status: "disabled",
    ...(previous?.lastInboundAt === undefined
      ? {}
      : { lastInboundAt: previous.lastInboundAt }),
    ...(previous?.lastInboundStatus
      ? { lastInboundStatus: previous.lastInboundStatus }
      : {}),
    ...(previous?.lastInboundDetail
      ? { lastInboundDetail: previous.lastInboundDetail }
      : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export class AssistantWeComBotManager extends EventEmitter<AssistantWeComBotManagerEvents> {
  private readonly runtimes = new Map<string, BotRuntime>();
  private messageHandler: AssistantWeComMessageHandler | null = null;
  private initialized = false;
  private lastReservedManagementBotId = "";

  constructor(
    private readonly store: AssistantStore,
    private readonly secretProtector: SecretProtector,
    private readonly getManagementBotId: () => string,
    private readonly clientFactory: WeComClientFactory = defaultClientFactory,
    private readonly getDeletionBlocker: (
      botProfileId: string,
    ) => string | undefined = () => undefined,
  ) {
    super();
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    await this.store.initialize();
    this.initialized = true;
    this.lastReservedManagementBotId = this.getManagementBotId().trim();
    for (const record of this.store.listStoredWeComBots()) {
      this.configureRuntime(record);
    }
    this.emit("stateChanged");
  }

  listBots(): AssistantWeComBotProfile[] {
    return [...this.runtimes.values()]
      .map((runtime) => ({ ...runtime.state }))
      .sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
  }

  hasBotId(botId: string): boolean {
    const key = botId.trim().toLocaleLowerCase("en-US");
    return Boolean(key) && this.store.listStoredWeComBots().some(
      (bot) => bot.botId.toLocaleLowerCase("en-US") === key,
    );
  }

  setMessageHandler(
    handler: AssistantWeComMessageHandler | null,
  ): void {
    this.messageHandler = handler;
  }

  async upsertBot(
    request: UpsertAssistantWeComBotRequest,
    now = Date.now(),
  ): Promise<AssistantWeComBotProfile> {
    this.assertInitialized();
    if (!request || typeof request !== "object") {
      throw new Error("企业微信助理入口请求无效。");
    }
    if (typeof request.enabled !== "boolean") {
      throw new Error("企业微信助理入口启用状态无效。");
    }
    const id = request.id
      ? requireText(request.id, "机器人配置 ID", 200)
      : randomUUID();
    const existing = this.store.getStoredWeComBot(id);
    if (request.id && !existing) {
      throw new Error("企业微信助理入口不存在或已经删除。");
    }
    const name = requireText(request.name, "机器人名称", 80);
    const botId = requireText(request.botId, "Bot ID", 200);
    if (/\s/u.test(botId)) {
      throw new Error("Bot ID 格式无效。");
    }
    if (existing && existing.botId !== botId) {
      throw new Error(
        "已保存机器人的 Bot ID 不能修改；请新建机器人配置后再切换助理入口。",
      );
    }
    const duplicateName = this.store.listStoredWeComBots().find(
      (bot) =>
        bot.id !== id &&
        bot.name.toLocaleLowerCase("zh-CN") === name.toLocaleLowerCase("zh-CN"),
    );
    if (duplicateName) {
      throw new Error("已经存在同名企业微信助理入口。");
    }
    const duplicateBotId = this.store.listStoredWeComBots().find(
      (bot) =>
        bot.id !== id &&
        bot.botId.toLocaleLowerCase("en-US") ===
          botId.toLocaleLowerCase("en-US"),
    );
    if (duplicateBotId) {
      throw new Error("这个 Bot ID 已经配置为其他企业微信助理入口。");
    }
    if (
      this.getManagementBotId().trim().toLocaleLowerCase("en-US") ===
      botId.toLocaleLowerCase("en-US")
    ) {
      throw new Error("这个 Bot ID 已用于 Claude Code 管理机器人，不能重复连接。");
    }
    const submittedSecret =
      request.secret === undefined ? "" : request.secret.trim();
    if (
      [...submittedSecret].length > 1_000 ||
      /\p{Cc}/u.test(submittedSecret)
    ) {
      throw new Error("Secret 格式无效。");
    }
    let encryptedSecret = existing?.encryptedSecret ?? "";
    if (submittedSecret) {
      if (!this.secretProtector.isEncryptionAvailable()) {
        throw new Error("当前系统安全存储不可用，不能安全保存企业微信 Secret。");
      }
      encryptedSecret = this.secretProtector
        .encryptString(submittedSecret)
        .toString("base64");
    }
    if (request.enabled && !encryptedSecret) {
      throw new Error("启用企业微信助理入口前必须填写 Secret。");
    }
    const record: StoredAssistantWeComBot = {
      id,
      name,
      enabled: request.enabled,
      botId,
      encryptedSecret,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    await this.store.putStoredWeComBot(record);
    this.configureRuntime(record);
    this.emit("stateChanged");
    return { ...this.requireRuntime(id).state };
  }

  async deleteBot(botProfileId: string): Promise<void> {
    this.assertInitialized();
    const id = requireText(botProfileId, "机器人配置 ID", 200);
    const externalBlocker = this.getDeletionBlocker(id);
    if (externalBlocker) {
      throw new Error(externalBlocker);
    }
    const runtime = this.runtimes.get(id);
    runtime?.client?.disconnect();
    this.runtimes.delete(id);
    await this.store.removeStoredWeComBot(id);
    this.emit("stateChanged");
  }

  async sendMarkdown(
    botProfileId: string,
    targetId: string,
    content: string,
  ): Promise<void> {
    const runtime = this.requireRuntime(botProfileId);
    const target = targetId.trim();
    if (!target || [...target].length > 200 || /\p{Cc}|\s/u.test(target)) {
      throw new Error("企业微信投递目标格式无效。");
    }
    const client = runtime.client;
    if (!client || runtime.authenticatedClient !== client) {
      throw new Error(`企业微信助理入口“${runtime.state.name}”尚未连接。`);
    }
    try {
      await client.sendMessage(target, {
        msgtype: "markdown",
        markdown: { content: truncateUtf8(content, MAX_MARKDOWN_BYTES) },
      });
      if (runtime.state.status === "error") {
        runtime.state = { ...runtime.state, status: "connected", error: undefined };
        this.emit("stateChanged");
      }
    } catch (error) {
      this.failRuntime(
        runtime,
        `企业微信消息推送失败：${readableError(error)}`,
      );
      throw error;
    }
  }

  refreshReservedManagementBotId(): void {
    if (!this.initialized) {
      return;
    }
    const current = this.getManagementBotId().trim();
    if (current === this.lastReservedManagementBotId) {
      return;
    }
    this.lastReservedManagementBotId = current;
    for (const record of this.store.listStoredWeComBots()) {
      this.configureRuntime(record);
    }
    this.emit("stateChanged");
  }

  dispose(): void {
    for (const runtime of this.runtimes.values()) {
      runtime.client?.disconnect();
      runtime.client = null;
      runtime.authenticatedClient = null;
      runtime.supersededClient = null;
    }
    this.runtimes.clear();
    this.messageHandler = null;
  }

  private configureRuntime(record: StoredAssistantWeComBot): void {
    const previous = this.runtimes.get(record.id);
    previous?.client?.disconnect();
    const runtime: BotRuntime = {
      record: { ...record },
      state: profileState(record, previous?.state),
      client: null,
      authenticatedClient: null,
      supersededClient: null,
      processedMessageIds: new Set<string>(),
    };
    this.runtimes.set(record.id, runtime);
    if (!record.enabled) {
      return;
    }
    if (
      record.botId.toLocaleLowerCase("en-US") ===
      this.getManagementBotId().trim().toLocaleLowerCase("en-US")
    ) {
      runtime.state = {
        ...runtime.state,
        status: "error",
        error: "这个 Bot ID 同时被配置为 Claude Code 管理机器人，已阻止重复连接。",
      };
      return;
    }
    if (!record.encryptedSecret) {
      runtime.state = {
        ...runtime.state,
        status: "error",
        error: "企业微信 Secret 尚未配置。",
      };
      return;
    }
    if (!this.secretProtector.isEncryptionAvailable()) {
      runtime.state = {
        ...runtime.state,
        status: "error",
        error: "当前系统安全存储不可用，无法读取企业微信 Secret。",
      };
      return;
    }
    let secret: string;
    try {
      secret = this.secretProtector.decryptString(
        Buffer.from(record.encryptedSecret, "base64"),
      );
    } catch {
      runtime.state = {
        ...runtime.state,
        status: "error",
        error: "企业微信 Secret 无法解密，请重新填写。",
      };
      return;
    }
    runtime.state = { ...runtime.state, status: "connecting", error: undefined };
    try {
      const client = this.clientFactory({ botId: record.botId, secret });
      runtime.client = client;
      this.attachClient(runtime, client);
      client.connect();
    } catch (error) {
      this.failRuntime(
        runtime,
        `无法连接企业微信智能机器人：${readableError(error)}`,
      );
    }
  }

  private attachClient(runtime: BotRuntime, client: WeComClient): void {
    const isCurrent = () => this.runtimes.get(runtime.record.id) === runtime;
    client.on("connected", () => {
      if (isCurrent()) {
        runtime.state = { ...runtime.state, status: "connecting" };
        this.emit("stateChanged");
      }
    });
    client.on("authenticated", () => {
      if (!isCurrent()) {
        return;
      }
      runtime.authenticatedClient = client;
      runtime.supersededClient = null;
      runtime.state = { ...runtime.state, status: "connected", error: undefined };
      this.emit("stateChanged");
    });
    client.on("reconnecting", () => {
      if (isCurrent()) {
        runtime.authenticatedClient = null;
        runtime.state = { ...runtime.state, status: "connecting" };
        this.emit("stateChanged");
      }
    });
    client.on("disconnected", (reason) => {
      if (!isCurrent()) {
        return;
      }
      runtime.authenticatedClient = null;
      if (
        runtime.supersededClient === client ||
        isSupersededConnection(reason)
      ) {
        runtime.supersededClient = client;
        runtime.state = {
          ...runtime.state,
          status: "error",
          error:
            "连接被其他客户端占用，请关闭使用相同 Bot ID/Secret 的客户端。",
        };
      } else {
        runtime.state = {
          ...runtime.state,
          status: "connecting",
          error: reason || "企业微信连接已断开，正在重连。",
        };
      }
      this.emit("stateChanged");
    });
    client.on("error", (error) => {
      if (isCurrent()) {
        runtime.authenticatedClient = null;
        this.failRuntime(runtime, `企业微信连接错误：${readableError(error)}`);
      }
    });
    client.on("event.disconnected_event", () => {
      if (isCurrent()) {
        runtime.authenticatedClient = null;
        runtime.supersededClient = client;
        runtime.state = {
          ...runtime.state,
          status: "error",
          error:
            "连接被其他客户端占用，请关闭使用相同 Bot ID/Secret 的客户端。",
        };
        this.emit("stateChanged");
      }
    });
    client.on("message", (frame) => {
      if (isCurrent()) {
        void this.handleIncomingMessage(runtime, client, frame).catch(
          (error: unknown) => {
            if (!isCurrent()) {
              return;
            }
            const detail = `处理企业微信自动化消息失败：${readableError(error)}`;
            this.recordInbound(runtime, "failed", detail);
            void this.replyToMessage(runtime, client, frame, detail);
          },
        );
      }
    });
  }

  private async handleIncomingMessage(
    runtime: BotRuntime,
    client: WeComClient,
    frame: WsFrame<BaseMessage>,
  ): Promise<void> {
    const message = frame.body;
    if (!message) {
      return;
    }
    const messageId = message.msgid?.trim();
    if (!messageId || !validInboundIdentifier(messageId)) {
      this.recordInbound(
        runtime,
        "ignored",
        "消息缺少可信的消息 ID，已静默忽略。",
      );
      return;
    }
    if (runtime.processedMessageIds.has(messageId)) {
      return;
    }
    runtime.processedMessageIds.add(messageId);
    if (runtime.processedMessageIds.size > 2_000) {
      const oldest = runtime.processedMessageIds.values().next().value;
      if (typeof oldest === "string") {
        runtime.processedMessageIds.delete(oldest);
      }
    }
    if (message.chattype !== "group" && message.chattype !== "single") {
      this.recordInbound(
        runtime,
        "ignored",
        "暂不支持这种企业微信会话类型。",
      );
      return;
    }
    const text = incomingMessageText(message).trim();
    const userId = message.from?.userid?.trim();
    const chatId =
      message.chattype === "group" ? message.chatid?.trim() : userId;
    if (
      !text ||
      !chatId ||
      !userId ||
      !validInboundIdentifier(chatId) ||
      !validInboundIdentifier(userId)
    ) {
      this.recordInbound(
        runtime,
        "ignored",
        "消息缺少可信文本或身份字段，已静默忽略。",
      );
      return;
    }
    if (!this.messageHandler) {
      this.recordInbound(runtime, "ignored", "自动化业务路由尚未启动。");
      return;
    }
    this.recordInbound(runtime, "received", "已收到消息，正在匹配业务路由。");
    const result = await this.messageHandler({
      botProfileId: runtime.record.id,
      messageId,
      chatType: message.chattype,
      chatId,
      userId,
      text,
      quoteText: quoteText(message).trim(),
    });
    if (!result) {
      this.recordInbound(
        runtime,
        "ignored",
        "消息未匹配已启用的业务路由，已静默忽略。",
      );
      return;
    }
    this.recordInbound(
      runtime,
      result.status === "accepted" ? "routed" : "rejected",
      result.message,
    );
    await this.replyToMessage(runtime, client, frame, result.message);
  }

  private async replyToMessage(
    runtime: BotRuntime,
    client: WeComClient,
    frame: WsFrameHeaders,
    content: string,
  ): Promise<boolean> {
    try {
      await client.replyStream(
        frame,
        generateReqId("claude_workspace_assistant"),
        content,
        true,
      );
      return true;
    } catch (error) {
      console.error("Failed to reply to assistant WeCom message", error);
      if (runtime.client !== client) {
        return false;
      }
      try {
        const message = (frame as WsFrame<BaseMessage>).body;
        const fallbackTarget = message?.chatid || message?.from?.userid;
        if (!fallbackTarget) {
          return false;
        }
        await client.sendMessage(fallbackTarget, {
          msgtype: "markdown",
          markdown: { content: truncateUtf8(content, MAX_MARKDOWN_BYTES) },
        });
        return true;
      } catch (fallbackError) {
        console.error("Failed to send assistant WeCom reply fallback", fallbackError);
        return false;
      }
    }
  }

  private recordInbound(
    runtime: BotRuntime,
    status: WeComInboundStatus,
    detail: string,
  ): void {
    runtime.state = {
      ...runtime.state,
      lastInboundAt: Date.now(),
      lastInboundStatus: status,
      lastInboundDetail: detail,
    };
    this.emit("stateChanged");
  }

  private failRuntime(runtime: BotRuntime, error: string): void {
    runtime.state = { ...runtime.state, status: "error", error };
    this.emit("stateChanged");
  }

  private requireRuntime(botProfileId: string): BotRuntime {
    const runtime = this.runtimes.get(botProfileId);
    if (!runtime) {
      throw new Error("企业微信助理入口不存在或已经删除。");
    }
    return runtime;
  }

  private assertInitialized(): void {
    if (!this.initialized) {
      throw new Error("Assistant WeCom bot manager has not been initialized.");
    }
  }
}
