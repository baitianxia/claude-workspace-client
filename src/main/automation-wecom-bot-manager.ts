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
  AutomationWeComBotProfile,
  UpsertAutomationWeComBotRequest,
  WeComInboundStatus,
} from "../shared/contracts";
import {
  AutomationStore,
  type StoredAutomationWeComBot,
} from "./automation-store";
import type { SecretProtector } from "./wecom-settings";
import type { WeComClient, WeComClientFactory } from "./wecom-bridge";

export interface AutomationWeComMessage {
  botProfileId: string;
  messageId: string;
  chatId: string;
  userId: string;
  text: string;
  quoteText: string;
}

export interface AutomationWeComMessageResult {
  status: "accepted" | "rejected";
  message: string;
}

export type AutomationWeComMessageHandler = (
  message: AutomationWeComMessage,
) => Promise<AutomationWeComMessageResult>;

interface AutomationWeComBotManagerEvents {
  stateChanged: [];
}

interface BotRuntime {
  record: StoredAutomationWeComBot;
  state: AutomationWeComBotProfile;
  client: WeComClient | null;
  authenticatedClient: WeComClient | null;
  supersededClient: WeComClient | null;
  processedMessageIds: Set<string>;
}

const MAX_MARKDOWN_BYTES = 18_000;
const MAX_DELIVERY_ATTEMPTS = 5;

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
      warn: (message) => console.warn(`[Automation WeCom] ${message}`),
      error: (message) => console.error(`[Automation WeCom] ${message}`),
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
  record: StoredAutomationWeComBot,
  previous?: AutomationWeComBotProfile,
): AutomationWeComBotProfile {
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

export class AutomationWeComBotManager extends EventEmitter<AutomationWeComBotManagerEvents> {
  private readonly runtimes = new Map<string, BotRuntime>();
  private messageHandler: AutomationWeComMessageHandler | null = null;
  private initialized = false;
  private lastReservedManagementBotId = "";

  constructor(
    private readonly store: AutomationStore,
    private readonly secretProtector: SecretProtector,
    private readonly getManagementBotId: () => string,
    private readonly clientFactory: WeComClientFactory = defaultClientFactory,
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

  listBots(): AutomationWeComBotProfile[] {
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

  setBusinessMessageHandler(
    handler: AutomationWeComMessageHandler | null,
  ): void {
    this.messageHandler = handler;
  }

  async upsertBot(
    request: UpsertAutomationWeComBotRequest,
    now = Date.now(),
  ): Promise<AutomationWeComBotProfile> {
    this.assertInitialized();
    if (!request || typeof request !== "object") {
      throw new Error("自动化机器人请求无效。");
    }
    if (typeof request.enabled !== "boolean") {
      throw new Error("自动化机器人启用状态无效。");
    }
    const id = request.id
      ? requireText(request.id, "机器人配置 ID", 200)
      : randomUUID();
    const existing = this.store.getStoredWeComBot(id);
    if (request.id && !existing) {
      throw new Error("自动化机器人不存在或已经删除。");
    }
    const name = requireText(request.name, "机器人名称", 80);
    const botId = requireText(request.botId, "Bot ID", 200);
    if (/\s/u.test(botId)) {
      throw new Error("Bot ID 格式无效。");
    }
    if (existing && existing.botId !== botId) {
      throw new Error(
        "已保存机器人的 Bot ID 不能修改；请新建机器人配置后再切换任务。",
      );
    }
    const duplicateName = this.store.listStoredWeComBots().find(
      (bot) =>
        bot.id !== id &&
        bot.name.toLocaleLowerCase("zh-CN") === name.toLocaleLowerCase("zh-CN"),
    );
    if (duplicateName) {
      throw new Error("已经存在同名自动化机器人。");
    }
    const duplicateBotId = this.store.listStoredWeComBots().find(
      (bot) =>
        bot.id !== id &&
        bot.botId.toLocaleLowerCase("en-US") ===
          botId.toLocaleLowerCase("en-US"),
    );
    if (duplicateBotId) {
      throw new Error("这个 Bot ID 已经配置为其他自动化机器人。");
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
      throw new Error("启用自动化机器人前必须填写 Secret。");
    }
    const record: StoredAutomationWeComBot = {
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
    if (this.store.listJobs().some((job) => job.wecomBotProfileId === id)) {
      throw new Error("仍有自动化任务使用这个机器人，请先修改或删除相关任务。");
    }
    if (
      this.store.listRuns(500).some((run) =>
        run.deliveries.some(
          (delivery) =>
            delivery.botProfileId === id &&
            (delivery.status === "pending" ||
              delivery.status === "sending" ||
              (delivery.status === "failed" &&
                delivery.attempts < MAX_DELIVERY_ATTEMPTS)),
        ),
      )
    ) {
      throw new Error("这个机器人仍有未完成的历史投递，暂时不能删除。");
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
      throw new Error(`自动化机器人“${runtime.state.name}”尚未连接。`);
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

  private configureRuntime(record: StoredAutomationWeComBot): void {
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
    if (!message || runtime.processedMessageIds.has(message.msgid)) {
      return;
    }
    runtime.processedMessageIds.add(message.msgid);
    if (runtime.processedMessageIds.size > 2_000) {
      const oldest = runtime.processedMessageIds.values().next().value;
      if (typeof oldest === "string") {
        runtime.processedMessageIds.delete(oldest);
      }
    }
    if (message.chattype !== "group") {
      this.recordInbound(
        runtime,
        "ignored",
        "自动化机器人只处理群聊消息；Claude Code 远程回复请使用管理机器人。",
      );
      return;
    }
    const text = incomingMessageText(message).trim();
    const chatId = message.chatid?.trim();
    const userId = message.from?.userid?.trim();
    if (!text || !chatId || !userId) {
      const detail = "群聊消息缺少文本、chatid 或发送者 userid，无法安全路由。";
      this.recordInbound(runtime, "rejected", detail);
      await this.replyToMessage(runtime, client, frame, detail);
      return;
    }
    if (!this.messageHandler) {
      this.recordInbound(runtime, "ignored", "自动化业务路由尚未启动。");
      return;
    }
    this.recordInbound(runtime, "received", "已收到群聊请求，正在匹配自动化任务。");
    const result = await this.messageHandler({
      botProfileId: runtime.record.id,
      messageId: message.msgid,
      chatId,
      userId,
      text,
      quoteText: quoteText(message).trim(),
    });
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
        generateReqId("claude_workspace_automation"),
        content,
        true,
      );
      return true;
    } catch (error) {
      console.error("Failed to reply to automation WeCom message", error);
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
        console.error("Failed to send automation WeCom reply fallback", fallbackError);
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
      throw new Error("自动化机器人不存在或已经删除。");
    }
    return runtime;
  }

  private assertInitialized(): void {
    if (!this.initialized) {
      throw new Error("Automation WeCom bot manager has not been initialized.");
    }
  }
}
