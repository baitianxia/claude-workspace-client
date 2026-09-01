import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { isAbsolute } from "node:path";
import type {
  AssistantConversationRecord,
  AssistantProfileRecord,
  AssistantSnapshot,
  AssistantTurnRecord,
  AutomationWeComBotProfile,
  ProjectRecord,
  SendAssistantMessageRequest,
  UpsertAssistantProfileRequest,
} from "../shared/contracts";
import type {
  AutomationWeComMessage,
  AutomationWeComMessageResult,
} from "./automation-wecom-bot-manager";
import { AssistantStore } from "./assistant-store";
import type {
  ClaudeCodeAssistantInput,
  ClaudeCodeAssistantResult,
} from "./claude-code-assistant-runner";

const MAX_QUEUED_TURNS_PER_ASSISTANT = 10;
const MAX_ASSISTANT_MESSAGE_CHARACTERS = 4_000;
const MAX_ASSISTANT_INSTRUCTION_CHARACTERS = 4_000;
const MCP_SERVER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;

interface AssistantServiceEvents {
  stateChanged: [state: AssistantSnapshot];
}

export interface AssistantRunner {
  initialize?(): Promise<void>;
  run(input: ClaudeCodeAssistantInput): Promise<ClaudeCodeAssistantResult>;
  cancel(turnId: string): boolean;
  dispose(): void;
}

export interface AssistantWeComGateway {
  listBots(): AutomationWeComBotProfile[];
  sendMarkdown(
    botProfileId: string,
    targetId: string,
    content: string,
  ): Promise<void>;
}

function readableError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu,
      " ",
    )
    .slice(-8_000);
}

function requireText(
  value: unknown,
  label: string,
  maximum: number,
  options: { allowEmpty?: boolean; multiline?: boolean } = {},
): string {
  if (typeof value !== "string") {
    throw new Error(`${label}必须是字符串。`);
  }
  const normalized = value.trim();
  const invalidControls = options.multiline
    ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u
    : /\p{Cc}/u;
  if (
    (!options.allowEmpty && !normalized) ||
    [...normalized].length > maximum ||
    invalidControls.test(normalized)
  ) {
    throw new Error(`${label}格式无效。`);
  }
  return normalized;
}

function requireInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(`${label}必须在 ${minimum}-${maximum} 之间。`);
  }
  return value;
}

function requireMcpServers(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 30) {
    throw new Error("允许的 MCP 服务器列表格式无效。");
  }
  const result: string[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (typeof raw !== "string") {
      throw new Error("允许的 MCP 服务器列表包含非字符串值。");
    }
    const name = raw.trim();
    const key = name.toLocaleLowerCase("en-US");
    if (!MCP_SERVER_NAME_PATTERN.test(name)) {
      throw new Error(`MCP 服务器名称“${name || "空值"}”格式无效。`);
    }
    if (!seen.has(key)) {
      seen.add(key);
      result.push(name);
    }
  }
  return result;
}

function validateMcpConfigPath(value: unknown, hasServers: boolean): string {
  const path = requireText(value, "MCP 配置路径", 500, {
    allowEmpty: !hasServers,
  });
  if (!path) {
    return "";
  }
  if (
    isAbsolute(path) ||
    path.split(/[\\/]+/u).some((segment) => segment === "..") ||
    !path.toLocaleLowerCase("en-US").endsWith(".json")
  ) {
    throw new Error("MCP 配置必须是工程内的相对 JSON 路径。");
  }
  return path;
}

function validWeComUserId(value: string): boolean {
  return Boolean(value) && !/\s/u.test(value) && [...value].length <= 200;
}

function isActiveTurn(turn: AssistantTurnRecord): boolean {
  return turn.status === "queued" || turn.status === "running";
}

function turnStatusLabel(turn: AssistantTurnRecord | undefined): string {
  if (!turn) {
    return "尚无对话";
  }
  switch (turn.status) {
    case "queued":
      return "等待处理";
    case "running":
      return "正在处理";
    case "succeeded":
      return "最近一轮已完成";
    case "failed":
      return "最近一轮失败";
    case "timed-out":
      return "最近一轮超时";
    case "cancelled":
      return "最近一轮已取消";
  }
}

export class AssistantService extends EventEmitter<AssistantServiceEvents> {
  private readonly workers = new Map<string, Promise<void>>();
  private initialized = false;
  private shuttingDown = false;
  private disposePromise: Promise<void> | null = null;

  constructor(
    private readonly store: AssistantStore,
    private readonly runner: AssistantRunner,
    private readonly getProject: (
      projectId: string,
    ) => ProjectRecord | undefined,
    private readonly wecomBots: AssistantWeComGateway,
    private readonly now: () => number = Date.now,
  ) {
    super();
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    await this.runner.initialize?.();
    await this.store.initialize();
    await this.store.recoverInterruptedTurns(this.now());
    this.initialized = true;
  }

  getSnapshot(): AssistantSnapshot {
    return {
      profiles: this.store.listProfiles(),
      conversations: this.store.listConversations().map((conversation) => {
        const publicConversation = { ...conversation };
        delete publicConversation.claudeSessionId;
        return publicConversation;
      }),
      turns: this.store.listTurns(),
      runningConversationIds: [...this.workers.keys()],
    };
  }

  hasRunningTurns(): boolean {
    return this.workers.size > 0;
  }

  async upsertProfile(
    request: UpsertAssistantProfileRequest,
  ): Promise<AssistantProfileRecord> {
    if (!request || typeof request !== "object") {
      throw new Error("私人助理配置请求无效。");
    }
    if (typeof request.enabled !== "boolean") {
      throw new Error("私人助理启用状态无效。");
    }
    const id = request.id
      ? requireText(request.id, "私人助理 ID", 200)
      : randomUUID();
    const existing = this.store.getProfile(id);
    if (request.id && !existing) {
      throw new Error("私人助理不存在或已经删除。");
    }
    if (this.hasActiveTurns(id)) {
      throw new Error("私人助理仍有对话正在处理，暂时不能修改配置。");
    }
    const name = requireText(request.name, "私人助理名称", 80);
    const duplicateName = this.store.listProfiles().find(
      (profile) =>
        profile.id !== id &&
        profile.name.toLocaleLowerCase("zh-CN") ===
          name.toLocaleLowerCase("zh-CN"),
    );
    if (duplicateName) {
      throw new Error("已经存在同名私人助理。");
    }
    const projectId = requireText(request.projectId, "运行工程 ID", 200);
    if (!this.getProject(projectId)) {
      throw new Error("私人助理关联的工程不存在。");
    }
    const hasHistory = Boolean(
      existing &&
        this.store.getConversation(existing.id)?.lastMessageAt !== undefined,
    );
    if (existing && projectId !== existing.projectId && hasHistory) {
      throw new Error(
        "已有主人对话后不能更换运行工程；请新建助理，避免跨工程恢复私人上下文。",
      );
    }
    const ownerWeComUserId = requireText(
      request.ownerWeComUserId,
      "主人企业微信 userid",
      200,
      { allowEmpty: true },
    );
    if (ownerWeComUserId && !validWeComUserId(ownerWeComUserId)) {
      throw new Error("主人企业微信 userid 格式无效。");
    }
    if (
      existing?.ownerWeComUserId &&
      ownerWeComUserId !== existing.ownerWeComUserId
    ) {
      throw new Error(
        "主人 userid 保存后不能更换；请新建助理，避免身份切换期间把私人上下文转交给其他人。",
      );
    }
    const wecomBotProfileId = request.wecomBotProfileId?.trim();
    if (wecomBotProfileId) {
      if (!ownerWeComUserId) {
        throw new Error("绑定企业微信入口前必须填写主人的 userid。");
      }
      if (!this.wecomBots.listBots().some((bot) => bot.id === wecomBotProfileId)) {
        throw new Error("选择的企业微信入口不存在或已经删除。");
      }
      const duplicateBot = this.store.findProfileByWeComBot(wecomBotProfileId);
      if (duplicateBot && duplicateBot.id !== id) {
        throw new Error("这个企业微信入口已经绑定到其他私人助理。");
      }
    }
    const allowedMcpServers = requireMcpServers(request.allowedMcpServers);
    const timestamp = this.now();
    const profile: AssistantProfileRecord = {
      id,
      name,
      enabled: request.enabled,
      projectId,
      instructions: requireText(
        request.instructions,
        "助理指令",
        MAX_ASSISTANT_INSTRUCTION_CHARACTERS,
        { allowEmpty: true, multiline: true },
      ),
      mcpConfigPath: validateMcpConfigPath(
        request.mcpConfigPath,
        allowedMcpServers.length > 0,
      ),
      allowedMcpServers,
      ownerWeComUserId,
      ...(wecomBotProfileId ? { wecomBotProfileId } : {}),
      timeoutMinutes: requireInteger(
        request.timeoutMinutes,
        "单轮超时分钟数",
        1,
        120,
      ),
      maxTurns: requireInteger(request.maxTurns, "最大 Agent 轮数", 1, 100),
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    await this.store.putProfile(profile);
    await this.ensureOwnerConversation(profile.id);
    this.emitStateChanged();
    return profile;
  }

  async deleteProfile(assistantId: string): Promise<void> {
    const id = requireText(assistantId, "私人助理 ID", 200);
    if (this.hasActiveTurns(id)) {
      throw new Error("私人助理仍有对话正在处理，请先停止后再删除。");
    }
    await this.store.removeProfile(id);
    this.emitStateChanged();
  }

  async sendDesktopMessage(
    request: SendAssistantMessageRequest,
  ): Promise<AssistantTurnRecord> {
    if (!request || typeof request !== "object") {
      throw new Error("私人助理消息请求无效。");
    }
    const assistantId = requireText(request.assistantId, "私人助理 ID", 200);
    const text = requireText(
      request.text,
      "消息",
      MAX_ASSISTANT_MESSAGE_CHARACTERS,
      { multiline: true },
    );
    const profile = this.requireEnabledProfile(assistantId);
    return this.enqueueTurn(profile, {
      source: "desktop",
      request: text,
    });
  }

  async resetOwnerConversation(
    assistantId: string,
  ): Promise<AssistantConversationRecord> {
    const profile = this.requireProfile(
      requireText(assistantId, "私人助理 ID", 200),
    );
    if (this.hasActiveTurns(profile.id)) {
      throw new Error("当前仍有消息正在处理，请先停止或等待完成。");
    }
    const conversation = await this.ensureOwnerConversation(profile.id);
    const reset = await this.store.resetConversation(conversation.id, this.now());
    this.emitStateChanged();
    return reset;
  }

  async cancelTurn(conversationId: string): Promise<void> {
    const id = requireText(conversationId, "私人助理会话 ID", 200);
    const running = this.store
      .listTurnsForConversation(id)
      .find((turn) => turn.status === "running");
    if (!running || !this.runner.cancel(running.id)) {
      throw new Error("当前会话没有正在运行的轮次。");
    }
  }

  async disableProfilesForProject(projectId: string): Promise<void> {
    const affected = this.store
      .listProfiles()
      .filter((profile) => profile.projectId === projectId);
    await this.store.disableProfilesForProject(projectId, this.now());
    for (const profile of affected) {
      const running = this.store
        .listTurnsForConversation(profile.id)
        .find((turn) => turn.status === "running");
      if (running) {
        this.runner.cancel(running.id);
      }
    }
    await Promise.allSettled(
      affected.flatMap((profile) => {
        const worker = this.workers.get(profile.id);
        return worker ? [worker] : [];
      }),
    );
    this.emitStateChanged();
  }

  readonly handleWeComMessage = async (
    message: AutomationWeComMessage,
  ): Promise<AutomationWeComMessageResult | null> => {
    if (message.chatType !== "single") {
      return null;
    }
    const profile = this.store.findProfileByWeComBot(message.botProfileId);
    if (
      !profile ||
      !profile.ownerWeComUserId ||
      message.userId !== profile.ownerWeComUserId
    ) {
      return null;
    }
    if (!profile.enabled) {
      return {
        status: "rejected",
        message: `私人助理“${profile.name}”当前已停用。`,
      };
    }
    const duplicate = this.store.findTurnByMessageId(
      message.botProfileId,
      message.messageId,
    );
    if (duplicate) {
      return {
        status: "accepted",
        message: `这条消息已经处理，当前状态：${turnStatusLabel(duplicate)}。`,
      };
    }
    const command = message.text.trim().toLocaleLowerCase("en-US");
    if (command === "/help") {
      return {
        status: "accepted",
        message: "可用命令：/new 新对话、/status 查看状态、/stop 停止当前轮次。其他文字会进入与桌面共享的主人会话。",
      };
    }
    if (command === "/status") {
      const latest = this.store.listTurnsForConversation(profile.id).at(-1);
      return {
        status: "accepted",
        message: `${profile.name}：${turnStatusLabel(latest)}。桌面与当前主人单聊共享上下文。`,
      };
    }
    if (command === "/new") {
      try {
        await this.resetOwnerConversation(profile.id);
        return { status: "accepted", message: "已开始一段新的主人会话。" };
      } catch (error) {
        return { status: "rejected", message: readableError(error) };
      }
    }
    if (command === "/stop") {
      try {
        await this.cancelTurn(profile.id);
        return { status: "accepted", message: "已请求停止当前轮次。" };
      } catch (error) {
        return { status: "rejected", message: readableError(error) };
      }
    }
    const turn = await this.enqueueTurn(profile, {
      source: "wecom",
      request: requireText(
        message.text,
        "企业微信消息",
        MAX_ASSISTANT_MESSAGE_CHARACTERS,
        { multiline: true },
      ),
      messageId: message.messageId,
      botProfileId: message.botProfileId,
      userId: message.userId,
    });
    return {
      status: "accepted",
      message: `已交给 ${profile.name}，当前排队编号 ${turn.id.slice(0, 8)}。完成后会在本单聊回复。`,
    };
  };

  dispose(): Promise<void> {
    if (this.disposePromise) {
      return this.disposePromise;
    }
    this.disposePromise = this.disposeInternal();
    return this.disposePromise;
  }

  private async disposeInternal(): Promise<void> {
    this.shuttingDown = true;
    this.runner.dispose();
    await Promise.allSettled([...this.workers.values()]);
    const timestamp = this.now();
    for (const turn of this.store.listTurns().filter(isActiveTurn)) {
      await this.store.completeTurn(
        {
          ...turn,
          status: "cancelled",
          finishedAt: timestamp,
          error: "客户端关闭，本轮对话已取消。",
        },
        undefined,
        timestamp,
      );
    }
    this.emitStateChanged();
  }

  private requireProfile(assistantId: string): AssistantProfileRecord {
    const profile = this.store.getProfile(assistantId);
    if (!profile) {
      throw new Error("私人助理不存在或已经删除。");
    }
    return profile;
  }

  private requireEnabledProfile(assistantId: string): AssistantProfileRecord {
    const profile = this.requireProfile(assistantId);
    if (!profile.enabled) {
      throw new Error("私人助理当前已停用。");
    }
    if (!this.getProject(profile.projectId)) {
      throw new Error("私人助理关联的工程已经被移除。");
    }
    return profile;
  }

  private hasActiveTurns(assistantId: string): boolean {
    return this.store
      .listTurnsForConversation(assistantId)
      .some(isActiveTurn);
  }

  private async ensureOwnerConversation(
    assistantId: string,
  ): Promise<AssistantConversationRecord> {
    const existing = this.store.getConversation(assistantId);
    if (existing) {
      return existing;
    }
    const timestamp = this.now();
    const conversation: AssistantConversationRecord = {
      id: assistantId,
      assistantId,
      kind: "owner",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.store.putConversation(conversation);
    return conversation;
  }

  private async enqueueTurn(
    profile: AssistantProfileRecord,
    input: Pick<
      AssistantTurnRecord,
      "source" | "request" | "messageId" | "botProfileId" | "userId"
    >,
  ): Promise<AssistantTurnRecord> {
    if (this.shuttingDown) {
      throw new Error("客户端正在关闭，不能接收新的助理消息。");
    }
    await this.ensureOwnerConversation(profile.id);
    const activeCount = this.store
      .listTurnsForConversation(profile.id)
      .filter(isActiveTurn).length;
    if (activeCount >= MAX_QUEUED_TURNS_PER_ASSISTANT) {
      throw new Error("当前助理等待处理的消息过多，请稍后再试。");
    }
    const timestamp = this.now();
    const turn: AssistantTurnRecord = {
      id: randomUUID(),
      assistantId: profile.id,
      conversationId: profile.id,
      source: input.source,
      ...(input.messageId ? { messageId: input.messageId } : {}),
      ...(input.botProfileId ? { botProfileId: input.botProfileId } : {}),
      ...(input.userId ? { userId: input.userId } : {}),
      request: input.request,
      status: "queued",
      createdAt: timestamp,
    };
    await this.store.appendTurn(turn);
    this.emitStateChanged();
    this.startWorker(profile.id);
    return turn;
  }

  private startWorker(conversationId: string): void {
    if (this.workers.has(conversationId) || this.shuttingDown) {
      return;
    }
    const worker = this.processConversation(conversationId)
      .catch((error: unknown) =>
        console.error("Failed to process assistant conversation", error),
      )
      .finally(() => {
        this.workers.delete(conversationId);
        this.emitStateChanged();
        if (
          !this.shuttingDown &&
          this.store
            .listTurnsForConversation(conversationId)
            .some((turn) => turn.status === "queued")
        ) {
          this.startWorker(conversationId);
        }
      });
    this.workers.set(conversationId, worker);
    this.emitStateChanged();
  }

  private async processConversation(conversationId: string): Promise<void> {
    while (!this.shuttingDown) {
      const turn = this.store
        .listTurnsForConversation(conversationId)
        .find((candidate) => candidate.status === "queued");
      if (!turn) {
        return;
      }
      let profile: AssistantProfileRecord;
      let project: ProjectRecord | undefined;
      try {
        profile = this.requireEnabledProfile(turn.assistantId);
        project = this.getProject(profile.projectId);
        if (!project) {
          throw new Error("私人助理关联的工程已经被移除。");
        }
      } catch (error) {
        await this.finishTurn(turn, {
          status: "failed",
          error: readableError(error),
        });
        continue;
      }
      const conversation = await this.ensureOwnerConversation(turn.assistantId);
      const running: AssistantTurnRecord = {
        ...turn,
        status: "running",
        startedAt: this.now(),
      };
      await this.store.replaceTurn(running);
      this.emitStateChanged();
      let result: ClaudeCodeAssistantResult;
      try {
        result = await this.runner.run({
          turnId: running.id,
          profile,
          projectRoot: project.rootPath,
          prompt: running.request,
          ...(conversation.claudeSessionId
            ? { sessionId: conversation.claudeSessionId }
            : {}),
        });
      } catch (error) {
        result = { status: "failed", error: readableError(error) };
      }
      await this.finishTurn(running, result);
    }
  }

  private async finishTurn(
    turn: AssistantTurnRecord,
    result: ClaudeCodeAssistantResult,
  ): Promise<void> {
    const timestamp = this.now();
    const normalizedResult: ClaudeCodeAssistantResult =
      result.status === "succeeded" &&
      (!result.response || !result.sessionId)
        ? {
            status: "failed",
            error: "私人助理没有返回完整的回复或会话 ID。",
          }
        : result;
    const completed: AssistantTurnRecord = {
      ...turn,
      status: normalizedResult.status,
      finishedAt: timestamp,
      ...(normalizedResult.response
        ? { response: normalizedResult.response }
        : {}),
      ...(normalizedResult.error ? { error: normalizedResult.error } : {}),
    };
    await this.store.completeTurn(
      completed,
      normalizedResult.status === "succeeded"
        ? normalizedResult.sessionId
        : undefined,
      timestamp,
    );
    this.emitStateChanged();

    if (turn.source !== "wecom" || !turn.botProfileId || !turn.userId) {
      return;
    }
    const content =
      normalizedResult.status === "succeeded" && normalizedResult.response
        ? normalizedResult.response
        : `本轮处理未完成：${normalizedResult.error ?? "未知错误"}`;
    try {
      await this.wecomBots.sendMarkdown(turn.botProfileId, turn.userId, content);
    } catch (error) {
      await this.store.replaceTurn({
        ...completed,
        deliveryError: `企业微信回复失败：${readableError(error)}`,
      });
      this.emitStateChanged();
    }
  }

  private emitStateChanged(): void {
    if (this.initialized) {
      this.emit("stateChanged", this.getSnapshot());
    }
  }
}
