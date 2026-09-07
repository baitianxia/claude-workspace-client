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
  /** Local diagnostic only; never send this message back to the sender. */
  silent?: boolean;
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
  pendingInboundMessages: Map<string, PendingInboundMessage>;
  processingMessageIds: Set<string>;
  processedMessageIds: Set<string>;
}

interface PendingInboundMessage {
  client: WeComClient;
  frame: WsFrame<BaseMessage>;
  /**
   * A route result is retained when only the acknowledgement failed. Retrying
   * the acknowledgement must not execute commands such as /new twice.
   */
  routeResult?: AssistantWeComMessageResult;
  retryCount: number;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout> | null;
}

type AssistantInboundMessageEvent =
  | "message.text"
  | "message.voice"
  | "message.mixed"
  | "message.image"
  | "message.file"
  | "message.video";

interface AssistantInboundEventClient {
  on(
    event: AssistantInboundMessageEvent,
    listener: (frame: WsFrame<BaseMessage>) => void,
  ): unknown;
}

const MAX_MARKDOWN_BYTES = 18_000;
const INBOUND_RETRY_DELAYS_MS = [100, 250, 500, 1_000, 2_000, 4_000, 8_000] as const;
const INBOUND_RETRY_MAX_AGE_MS = 30_000;
const MAX_PENDING_INBOUND_MESSAGES = 100;

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

function trimmedInboundIdentifier(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
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
    mixed?: { msg_item?: unknown };
  };
  const mixedItems = Array.isArray(value.mixed?.msg_item)
    ? value.mixed.msg_item
    : [];
  const candidates = [
    value.content,
    value.quote_text,
    value.text?.content,
    value.markdown?.content,
    value.voice?.content,
    ...mixedItems.flatMap((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return [];
      }
      const text = (item as { text?: unknown }).text;
      if (!text || typeof text !== "object" || Array.isArray(text)) {
        return [];
      }
      const content = (text as { content?: unknown }).content;
      return typeof content === "string" ? [content] : [];
    }),
  ].filter(
    (candidate): candidate is string =>
      typeof candidate === "string" && candidate.trim().length > 0,
  );
  return [...new Set(candidates)].join("\n");
}

function incomingMessageText(message: BaseMessage): string {
  const flexible = message as BaseMessage & {
    text?: string | { content?: unknown };
    markdown?: string | { content?: unknown };
    voice?: string | { content?: unknown };
    mixed?: { msg_item?: unknown };
  };
  if (typeof flexible.text === "string") {
    return flexible.text;
  }
  if (typeof flexible.text?.content === "string") {
    return flexible.text.content;
  }
  if (typeof flexible.markdown === "string") {
    return flexible.markdown;
  }
  if (typeof flexible.markdown?.content === "string") {
    return flexible.markdown.content;
  }
  if (typeof flexible.voice === "string") {
    return flexible.voice;
  }
  if (typeof flexible.voice?.content === "string") {
    return flexible.voice.content;
  }
  const items = flexible.mixed?.msg_item;
  if (!Array.isArray(items)) {
    return "";
  }
  return items
    .flatMap((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return [];
      }
      const text = (item as { text?: string | { content?: unknown } }).text;
      if (typeof text === "string") {
        return [text];
      }
      return typeof text?.content === "string" ? [text.content] : [];
    })
    .join("\n");
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
    if (handler) {
      for (const runtime of this.runtimes.values()) {
        this.wakePendingInboundMessages(runtime);
      }
    }
  }

  async upsertBot(
    request: UpsertAssistantWeComBotRequest,
    now = Date.now(),
  ): Promise<AssistantWeComBotProfile> {
    this.assertInitialized();
    if (!request || typeof request !== "object") {
      throw new Error("企业微信智能机器人配置请求无效。");
    }
    if (typeof request.enabled !== "boolean") {
      throw new Error("企业微信智能机器人启用状态无效。");
    }
    const id = request.id
      ? requireText(request.id, "机器人配置 ID", 200)
      : randomUUID();
    const existing = this.store.getStoredWeComBot(id);
    if (request.id && !existing) {
      throw new Error("企业微信智能机器人配置不存在或已经删除。");
    }
    const name = requireText(request.name, "助理连接标识", 80);
    const botId = requireText(request.botId, "Bot ID", 200);
    if (/\s/u.test(botId)) {
      throw new Error("Bot ID 格式无效。");
    }
    if (existing && existing.botId !== botId) {
      throw new Error(
        "已保存连接的 Bot ID 不能修改；请在助理配置中先取消绑定，再绑定新的企业微信智能机器人。",
      );
    }
    const duplicateBotId = this.store.listStoredWeComBots().find(
      (bot) =>
        bot.id !== id &&
        bot.botId.toLocaleLowerCase("en-US") ===
          botId.toLocaleLowerCase("en-US"),
    );
    if (duplicateBotId) {
      throw new Error("这个 Bot ID 已经配置为其他企业微信智能机器人。");
    }
    if (
      this.getManagementBotId().trim().toLocaleLowerCase("en-US") ===
      botId.toLocaleLowerCase("en-US")
    ) {
      throw new Error("这个 Bot ID 已用于 Claude Code 终端控制机器人，不能重复连接。");
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
      throw new Error("启用企业微信智能机器人前必须填写 Secret。");
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
    if (runtime) {
      this.clearPendingInboundMessages(runtime);
    }
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
      throw new Error(`企业微信智能机器人“${runtime.state.name}”尚未连接。`);
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
      this.clearPendingInboundMessages(runtime);
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
    if (previous) {
      this.clearPendingInboundMessages(previous);
    }
    previous?.client?.disconnect();
    const runtime: BotRuntime = {
      record: { ...record },
      state: profileState(record, previous?.state),
      client: null,
      authenticatedClient: null,
      supersededClient: null,
      pendingInboundMessages: new Map<string, PendingInboundMessage>(),
      processingMessageIds: new Set<string>(),
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
        error: "这个 Bot ID 同时被配置为 Claude Code 终端控制机器人，已阻止重复连接。",
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
      // The bundled SDK currently returns the client synchronously, but some
      // compatible clients return a Promise. Observe both forms so a rejected
      // connection cannot become an unhandled rejection with the UI stuck at
      // “连接中”.
      void Promise.resolve(client.connect()).catch((error: unknown) => {
        if (this.runtimes.get(record.id) === runtime) {
          this.failRuntime(
            runtime,
            `无法连接企业微信智能机器人：${readableError(error)}`,
          );
        }
      });
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
      this.wakePendingInboundMessages(runtime);
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
    const dispatchMessage = (frame: WsFrame<BaseMessage>) => {
      this.dispatchIncomingMessage(runtime, client, frame);
    };
    client.on("message", dispatchMessage);
    // The current SDK emits both the generic event and one typed event. Keep
    // the typed subscriptions as a compatibility path for older/alternative
    // clients that only expose message.text/message.voice/etc. The in-flight
    // msgid set below makes the duplicate emission harmless.
    const typedClient = client as unknown as AssistantInboundEventClient;
    const typedEvents: AssistantInboundMessageEvent[] = [
      "message.text",
      "message.voice",
      "message.mixed",
      "message.image",
      "message.file",
      "message.video",
    ];
    for (const event of typedEvents) {
      typedClient.on(event, dispatchMessage);
    }
  }

  private dispatchIncomingMessage(
    runtime: BotRuntime,
    client: WeComClient,
    frame: WsFrame<BaseMessage>,
  ): void {
    if (this.runtimes.get(runtime.record.id) !== runtime) {
      return;
    }
    void this.handleIncomingMessage(runtime, client, frame).catch(
      (error: unknown) => {
        if (this.runtimes.get(runtime.record.id) !== runtime) {
          return;
        }
        console.error("Failed to handle assistant WeCom message", error);
        this.recordInbound(
          runtime,
          "failed",
          "处理企业微信助理消息发生异常，正在本地重试。",
        );
        const messageId = trimmedInboundIdentifier(frame.body?.msgid);
        if (messageId && validInboundIdentifier(messageId)) {
          this.scheduleInboundRetry(runtime, client, frame, messageId);
        }
      },
    );
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
    const messageId = trimmedInboundIdentifier(message.msgid);
    if (!messageId || !validInboundIdentifier(messageId)) {
      this.recordInbound(
        runtime,
        "ignored",
        "消息缺少可信的消息 ID，已静默忽略。",
      );
      return;
    }
    if (
      runtime.processingMessageIds.has(messageId) ||
      runtime.processedMessageIds.has(messageId)
    ) {
      return;
    }
    runtime.processingMessageIds.add(messageId);
    let processed = false;
    try {
      if (message.chattype !== "group" && message.chattype !== "single") {
        this.recordInbound(
          runtime,
          "ignored",
          "暂不支持这种企业微信会话类型。",
        );
        processed = true;
        return;
      }
      const text = incomingMessageText(message).trim();
      const userId = trimmedInboundIdentifier(message.from?.userid);
      const chatId =
        message.chattype === "group"
          ? trimmedInboundIdentifier(message.chatid)
          : userId;
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
        processed = true;
        return;
      }
      if (!this.messageHandler) {
        // Retain the callback in memory instead of depending on WeCom to resend
        // it after the rest of the application has finished starting.
        this.recordInbound(
          runtime,
          "received",
          "私人助理消息路由尚未启动，正在本地重试。",
        );
        this.scheduleInboundRetry(runtime, client, frame, messageId);
        return;
      }
      this.recordInbound(runtime, "received", "已收到消息，正在匹配业务路由。");
      const pending = runtime.pendingInboundMessages.get(messageId);
      const result =
        pending?.routeResult ??
        (await this.messageHandler({
          botProfileId: runtime.record.id,
          messageId,
          chatType: message.chattype,
          chatId,
          userId,
          text,
          quoteText: quoteText(message).trim(),
        }));
      if (!result) {
        // An inline bot connection can authenticate a few milliseconds before
        // its assistant profile is committed. Retry the retained callback
        // locally; an external same-msgid delivery can also complete it sooner.
        this.recordInbound(
          runtime,
          "received",
          "消息尚未匹配私人助理路由，正在本地重试。",
        );
        this.scheduleInboundRetry(runtime, client, frame, messageId);
        return;
      }
      if (result.silent) {
        this.recordInbound(runtime, "ignored", result.message);
        processed = true;
        return;
      }
      this.recordInbound(
        runtime,
        result.status === "accepted" ? "routed" : "rejected",
        result.message,
      );
      // Only make this msgid terminal after the acknowledgement reached WeCom.
      // If both the stream reply and fallback fail, a retry must be allowed;
      // AssistantStore still prevents an accepted turn from executing twice.
      processed = await this.replyToMessage(
        runtime,
        client,
        frame,
        result.message,
      );
      if (!processed) {
        this.recordInbound(
          runtime,
          "failed",
          "消息已进入本地路由，但企业微信确认回复失败，正在本地重试。",
        );
        this.scheduleInboundRetry(runtime, client, frame, messageId, result);
      }
    } finally {
      runtime.processingMessageIds.delete(messageId);
      if (processed) {
        this.clearPendingInboundMessage(runtime, messageId);
        this.rememberProcessedMessage(runtime, messageId);
      }
    }
  }

  private scheduleInboundRetry(
    runtime: BotRuntime,
    client: WeComClient,
    frame: WsFrame<BaseMessage>,
    messageId: string,
    routeResult?: AssistantWeComMessageResult,
  ): void {
    if (
      this.runtimes.get(runtime.record.id) !== runtime ||
      runtime.processedMessageIds.has(messageId)
    ) {
      return;
    }
    const now = Date.now();
    const pending = runtime.pendingInboundMessages.get(messageId) ?? {
      client,
      frame,
      retryCount: 0,
      expiresAt: now + INBOUND_RETRY_MAX_AGE_MS,
      timer: null,
    };
    if (
      !runtime.pendingInboundMessages.has(messageId) &&
      runtime.pendingInboundMessages.size >= MAX_PENDING_INBOUND_MESSAGES
    ) {
      this.recordInbound(
        runtime,
        "failed",
        "待处理企业微信消息过多，已暂缓本条消息，请稍后重试。",
      );
      return;
    }
    pending.client = client;
    pending.frame = frame;
    if (routeResult) {
      pending.routeResult = routeResult;
    }
    runtime.pendingInboundMessages.set(messageId, pending);
    if (pending.timer) {
      return;
    }
    if (
      now >= pending.expiresAt ||
      pending.retryCount >= INBOUND_RETRY_DELAYS_MS.length
    ) {
      runtime.pendingInboundMessages.delete(messageId);
      this.recordInbound(
        runtime,
        "failed",
        "企业微信入站消息在本地重试后仍未完成，请检查助理绑定、连接和运行状态。",
      );
      return;
    }
    const delay = INBOUND_RETRY_DELAYS_MS[pending.retryCount];
    pending.retryCount += 1;
    pending.timer = setTimeout(() => {
      pending.timer = null;
      if (
        this.runtimes.get(runtime.record.id) !== runtime ||
        runtime.processedMessageIds.has(messageId)
      ) {
        runtime.pendingInboundMessages.delete(messageId);
        return;
      }
      this.dispatchIncomingMessage(runtime, pending.client, pending.frame);
    }, delay);
    pending.timer.unref?.();
  }

  private wakePendingInboundMessages(runtime: BotRuntime): void {
    // A retry may have been retained while the SDK was reconnecting. Use the
    // runtime's current client before waking it so the acknowledgement cannot
    // be attempted through a stale connection object supplied by an older
    // callback.
    if (runtime.client) {
      for (const pending of runtime.pendingInboundMessages.values()) {
        pending.client = runtime.client;
      }
    }
    for (const [messageId, pending] of runtime.pendingInboundMessages) {
      if (pending.timer) {
        clearTimeout(pending.timer);
      }
      pending.timer = setTimeout(() => {
        pending.timer = null;
        if (
          this.runtimes.get(runtime.record.id) !== runtime ||
          runtime.processedMessageIds.has(messageId)
        ) {
          runtime.pendingInboundMessages.delete(messageId);
          return;
        }
        this.dispatchIncomingMessage(runtime, pending.client, pending.frame);
      }, 0);
      pending.timer.unref?.();
    }
  }

  private clearPendingInboundMessage(
    runtime: BotRuntime,
    messageId: string,
  ): void {
    const pending = runtime.pendingInboundMessages.get(messageId);
    if (pending?.timer) {
      clearTimeout(pending.timer);
    }
    runtime.pendingInboundMessages.delete(messageId);
  }

  private clearPendingInboundMessages(runtime: BotRuntime): void {
    for (const pending of runtime.pendingInboundMessages.values()) {
      if (pending.timer) {
        clearTimeout(pending.timer);
      }
    }
    runtime.pendingInboundMessages.clear();
  }

  private rememberProcessedMessage(
    runtime: BotRuntime,
    messageId: string,
  ): void {
    runtime.processedMessageIds.add(messageId);
    if (runtime.processedMessageIds.size <= 2_000) {
      return;
    }
    const oldest = runtime.processedMessageIds.values().next().value;
    if (typeof oldest === "string") {
      runtime.processedMessageIds.delete(oldest);
    }
  }

  private async replyToMessage(
    runtime: BotRuntime,
    client: WeComClient,
    frame: WsFrameHeaders,
    content: string,
  ): Promise<boolean> {
    // A callback can race a reconnect or a configuration replacement. Never
    // send a reply through a client that is no longer the authenticated
    // connection for this bot; the caller will retain the route result and
    // retry once the current connection is ready.
    if (runtime.client !== client || runtime.authenticatedClient !== client) {
      return false;
    }
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
      if (runtime.client !== client || runtime.authenticatedClient !== client) {
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
      throw new Error("企业微信智能机器人不存在或已经删除。");
    }
    return runtime;
  }

  private assertInitialized(): void {
    if (!this.initialized) {
      throw new Error("Assistant WeCom bot manager has not been initialized.");
    }
  }
}
