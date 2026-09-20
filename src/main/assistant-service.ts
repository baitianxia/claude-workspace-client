import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type {
  AssistantConversationRecord,
  AssistantProfileRecord,
  AssistantSnapshot,
  AssistantTurnRecord,
  AssistantWeComBotDraft,
  AssistantWeComBotProfile,
  ProjectRecord,
  SendAssistantMessageRequest,
  UpsertAssistantProfileRequest,
  UpsertAssistantWeComBotRequest,
} from "../shared/contracts";
import type {
  AssistantWeComMessage,
  AssistantWeComMessageResult,
} from "./assistant-wecom-bot-manager";
import { AssistantStore } from "./assistant-store";
import {
  assistantRuntimePathKey,
  legacyRuntimePath,
  validateAssistantRuntimePath,
} from "./assistant-runtime-path";
import type { AssistantTaskService } from "./assistant-task-service";
import type {
  AssistantTaskMcpServer,
  ClaudeCodeAssistantInput,
  ClaudeCodeAssistantResult,
} from "./claude-code-assistant-runner";
import { withTimeout } from "./promise-timeout";

const MAX_QUEUED_TURNS_PER_ASSISTANT = 10;
const MAX_ASSISTANT_MESSAGE_CHARACTERS = 4_000;
const MAX_ASSISTANT_INSTRUCTION_CHARACTERS = 4_000;
const WECOM_DELIVERY_TIMEOUT_MILLISECONDS = 15_000;
const CHAT_ID_COMMAND_PATTERN =
  /(?:^|[^\p{L}\p{N}_])\/chatid(?=$|[^\p{L}\p{N}_])/iu;

interface AssistantServiceEvents {
  stateChanged: [state: AssistantSnapshot];
}

export interface AssistantRunner {
  initialize?(): Promise<void>;
  run(input: ClaudeCodeAssistantInput): Promise<ClaudeCodeAssistantResult>;
  cancel(turnId: string): boolean;
  close(assistantId: string): Promise<void>;
  listOpenAssistantIds(): string[];
  dispose(): void;
  on?(event: "stateChanged", listener: () => void): unknown;
  off?(event: "stateChanged", listener: () => void): unknown;
}

export interface AssistantWeComGateway {
  listBots(): AssistantWeComBotProfile[];
  upsertBot(
    request: UpsertAssistantWeComBotRequest,
  ): Promise<AssistantWeComBotProfile>;
  deleteBot(botProfileId: string): Promise<void>;
  sendMarkdown(
    botProfileId: string,
    targetId: string,
    content: string,
  ): Promise<void>;
  on?(event: "stateChanged", listener: () => void): unknown;
  off?(event: "stateChanged", listener: () => void): unknown;
}

function readableError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu,
      " ",
    )
    .slice(-8_000);
}

function isChatIdCommand(value: string): boolean {
  return CHAT_ID_COMMAND_PATTERN.test(value.trim());
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

function validWeComUserId(value: string): boolean {
  return !/\s|\p{Cc}/u.test(value) && [...value].length <= 200;
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
  private nestedStateChangeSuppressionDepth = 0;
  private nestedStateChangePending = false;
  private readonly onNestedStateChanged = () => {
    if (this.nestedStateChangeSuppressionDepth > 0) {
      this.nestedStateChangePending = true;
      return;
    }
    this.emitStateChanged();
  };

  constructor(
    private readonly store: AssistantStore,
    private readonly runner: AssistantRunner,
    private readonly getProject:
      | ((projectId: string) => ProjectRecord | undefined)
      | undefined,
    private readonly wecomBots: AssistantWeComGateway,
    private readonly tasks: AssistantTaskService,
    private readonly now: () => number = Date.now,
  ) {
    super();
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    await this.store.initialize();
    await this.migrateLegacyRuntimePaths();
    await this.store.recoverInterruptedTurns(this.now());
    await this.runner.initialize?.();
    await this.tasks.initialize();
    this.runner.on?.("stateChanged", this.onNestedStateChanged);
    this.wecomBots.on?.("stateChanged", this.onNestedStateChanged);
    this.tasks.on("stateChanged", this.onNestedStateChanged);
    this.initialized = true;
    this.emitStateChanged();
  }

  getSnapshot(): AssistantSnapshot {
    const conversations = this.store.listConversations();
    const schedulerError = this.tasks.getSchedulerError();
    const schedulerErrorAt = this.tasks.getSchedulerErrorAt();
    const lastSchedulerCheckAt = this.tasks.getLastSchedulerCheckAt();
    return {
      profiles: this.store.listProfiles(),
      conversations: conversations.map((conversation) => {
        const publicConversation = { ...conversation };
        delete publicConversation.claudeSessionId;
        return publicConversation;
      }),
      turns: this.store.listTurns(),
      wecomBots: this.wecomBots.listBots(),
      tasks: this.tasks.listTasks(),
      taskRuns: this.tasks.listRuns(),
      runningConversationIds: [...this.workers.keys()],
      openConversationIds: this.runner.listOpenAssistantIds(),
      resumableConversationIds: conversations
        .filter((conversation) => Boolean(conversation.claudeSessionId))
        .map((conversation) => conversation.assistantId),
      runningTaskIds: this.tasks.listRunningTaskIds(),
      schedulerActive: this.tasks.isSchedulerActive(),
      ...(lastSchedulerCheckAt === undefined ? {} : { lastSchedulerCheckAt }),
      ...(schedulerError ? { schedulerError } : {}),
      ...(schedulerErrorAt === undefined ? {} : { schedulerErrorAt }),
    };
  }

  hasRunningTurns(): boolean {
    return this.store.listTurns().some(isActiveTurn);
  }

  hasRunningWork(): boolean {
    return this.hasRunningTurns() || this.tasks.hasRunningRuns();
  }

  async upsertProfile(
    request: UpsertAssistantProfileRequest,
  ): Promise<AssistantProfileRecord> {
    // Saving an inline WeCom bot updates the bot runtime before the profile
    // itself is persisted. Coalesce nested state events so the renderer never
    // receives an intermediate snapshot that contains the new bot but still
    // has the old (or missing) profile binding.
    return this.withNestedStateChangesSuppressed(() =>
      this.upsertProfileInternal(request),
    );
  }

  private async upsertProfileInternal(
    request: UpsertAssistantProfileRequest,
  ): Promise<AssistantProfileRecord> {
    if (!request || typeof request !== "object") {
      throw new Error("私人助理配置请求无效。");
    }
    if (typeof request.enabled !== "boolean") {
      throw new Error("私人助理启用状态无效。");
    }
    const existing = request.id ? this.store.getProfile(request.id) : undefined;
    if (request.id && !existing) {
      throw new Error("私人助理不存在或已经删除。");
    }
    const id = existing?.id ?? randomUUID();
    if (this.hasActiveTurns(id) || this.tasks.hasRunningRunsForAssistant(id)) {
      throw new Error("私人助理正在处理消息或任务，暂时不能修改配置。");
    }
    const name = requireText(request.name, "助理名称", 80);
    if (
      this.store
        .listProfiles()
        .some(
          (profile) =>
            profile.id !== id &&
            profile.name.toLocaleLowerCase("zh-CN") ===
              name.toLocaleLowerCase("zh-CN"),
        )
    ) {
      throw new Error("已经存在同名私人助理。");
    }
    const requestedProjectPath = requireText(
      request.projectPath ?? "",
      "运行目录",
      4_000,
      { allowEmpty: true },
    );
    let projectPath: string;
    if (requestedProjectPath) {
      projectPath = await validateAssistantRuntimePath(requestedProjectPath);
    } else if (request.projectId) {
      const legacyProjectId = requireText(request.projectId, "运行工程", 200);
      const legacyProject = this.getProject?.(legacyProjectId);
      if (!legacyProject) {
        throw new Error("旧助理关联的工程不存在，请重新选择运行目录。");
      }
      projectPath = await validateAssistantRuntimePath(legacyProject.rootPath);
    } else {
      throw new Error("请选择私人助理运行目录。");
    }
    const existingProjectPath = existing
      ? legacyRuntimePath(existing, this.getProject)
      : undefined;
    if (
      existing &&
      (!existingProjectPath ||
        assistantRuntimePathKey(existingProjectPath) !==
          assistantRuntimePathKey(projectPath)) &&
      (this.store.listTurnsForConversation(id).length > 0 ||
        this.tasks.hasAssistantData(id))
    ) {
      throw new Error("私人助理产生过聊天或定时任务后不能更换运行目录，请新建助理。");
    }
    const ownerWeComUserId = requireText(
      request.ownerWeComUserId,
      "主人 userid",
      200,
      { allowEmpty: true },
    );
    if (!validWeComUserId(ownerWeComUserId)) {
      throw new Error("主人 userid 格式无效。");
    }
    if (
      existing?.ownerWeComUserId &&
      ownerWeComUserId !== existing.ownerWeComUserId
    ) {
      throw new Error("主人 userid 保存后不能更换，请新建私人助理。");
    }

    // New renderer clients submit the bot details together with the assistant
    // profile. Keep accepting the old profile-id-only shape so an upgraded
    // client can migrate without losing its existing binding.
    // `undefined` is treated like an omitted field so older renderer builds
    // that spread an optional value keep an existing binding. Use `null` to
    // explicitly remove a binding.
    const hasInlineBot = request.wecomBot !== undefined;
    const inlineBot = hasInlineBot ? request.wecomBot : undefined;
    if (
      hasInlineBot &&
      inlineBot !== null &&
      (typeof inlineBot !== "object" || Array.isArray(inlineBot))
    ) {
      throw new Error("企业微信智能机器人配置格式无效。");
    }
    const legacyBotProfileId =
      !hasInlineBot && request.wecomBotProfileId
        ? requireText(request.wecomBotProfileId, "企业微信机器人配置", 200)
        : undefined;
    let wecomBotProfileId = hasInlineBot
      ? undefined
      : legacyBotProfileId ?? existing?.wecomBotProfileId;
    const shouldBindBot = hasInlineBot
      ? inlineBot !== null
      : Boolean(wecomBotProfileId);
    if (shouldBindBot && !ownerWeComUserId) {
      throw new Error("绑定企业微信智能机器人前必须填写主人 userid。");
    }
    if (
      legacyBotProfileId &&
      !this.wecomBots.listBots().some((bot) => bot.id === legacyBotProfileId)
    ) {
      throw new Error("选择的企业微信智能机器人不存在，请在助理配置中重新配置。");
    }
    if (
      hasInlineBot &&
      inlineBot &&
      typeof inlineBot.id === "string" &&
      existing?.wecomBotProfileId &&
      inlineBot.id !== existing.wecomBotProfileId
    ) {
      throw new Error(
        "当前助理已经绑定其他企业微信智能机器人；请先取消绑定并保存，再绑定新的机器人。",
      );
    }
    if (
      hasInlineBot &&
      inlineBot &&
      typeof inlineBot.id === "string" &&
      this.store
        .listProfiles()
        .some(
          (profile) =>
            profile.id !== id && profile.wecomBotProfileId === inlineBot.id,
        )
    ) {
      throw new Error("这个企业微信智能机器人已经绑定到其他私人助理。");
    }

    // Finish validating every profile field before mutating the bot store.
    // This keeps a rejected assistant save from creating a partially configured
    // robot that is no longer reachable from the form.
    const instructions = requireText(
      request.instructions,
      "助理指令",
      MAX_ASSISTANT_INSTRUCTION_CHARACTERS,
      { allowEmpty: true, multiline: true },
    );
    const timeoutMinutes = requireInteger(
      request.timeoutMinutes,
      "超时分钟",
      1,
      120,
    );
    const maxTurns = requireInteger(request.maxTurns, "最大轮数", 1, 100);

    let createdInlineBotId: string | undefined;
    if (hasInlineBot && inlineBot) {
      let inlineBotRequest = inlineBot as AssistantWeComBotDraft;
      const knownInlineBot = inlineBotRequest.id
        ? this.wecomBots.listBots().some(
            (bot) => bot.id === inlineBotRequest.id,
          )
        : false;
      if (
        inlineBotRequest.id &&
        !knownInlineBot &&
        existing?.wecomBotProfileId === inlineBotRequest.id
      ) {
        // The profile and bot snapshots can briefly arrive in different IPC
        // events. If the current profile still points at the missing record,
        // let the submitted Bot ID recreate that connection instead of
        // leaving the configuration form permanently unusable.
        inlineBotRequest = { ...inlineBotRequest, id: undefined };
      }
      // A legacy upgrade may already have a saved, currently unbound bot with
      // the same Bot ID. Reuse that record so configuring the assistant does
      // not fail with a duplicate-ID error or create a second long connection.
      // Never reuse a record that another assistant owns.
      if (!inlineBotRequest.id && typeof inlineBotRequest.botId === "string") {
        const botIdKey = inlineBotRequest.botId.trim().toLocaleLowerCase("en-US");
        const reusableBot = this.wecomBots
          .listBots()
          .find(
            (bot) =>
              bot.botId.toLocaleLowerCase("en-US") === botIdKey,
          );
        if (reusableBot) {
          const owner = this.store.findProfileByWeComBot(reusableBot.id);
          if (owner && owner.id !== id) {
            throw new Error("这个企业微信智能机器人已经绑定到其他私人助理。");
          }
          inlineBotRequest = { ...inlineBotRequest, id: reusableBot.id };
        }
      }
      const savedBot = await this.wecomBots.upsertBot(
        inlineBotRequest,
      );
      wecomBotProfileId = savedBot.id;
      if (!inlineBotRequest.id) {
        createdInlineBotId = savedBot.id;
      }
      if (
        this.store
          .listProfiles()
          .some(
            (profile) =>
              profile.id !== id && profile.wecomBotProfileId === savedBot.id,
          )
      ) {
        if (createdInlineBotId) {
          await this.wecomBots.deleteBot(createdInlineBotId).catch(() => undefined);
        }
        throw new Error("这个企业微信智能机器人已经绑定到其他私人助理。");
      }
    }
    const timestamp = this.now();
    const profile: AssistantProfileRecord = {
      id,
      name,
      enabled: request.enabled,
      projectPath,
      instructions,
      ownerWeComUserId,
      ...(wecomBotProfileId ? { wecomBotProfileId } : {}),
      timeoutMinutes,
      maxTurns,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    if (existing) {
      await this.runner.close(id);
    }
    try {
      await this.store.putProfile(profile);
    } catch (error) {
      // A newly created bot has no other owner at this point. Remove it if
      // profile persistence fails so a rejected save does not leave a hidden
      // orphan connection behind.
      if (createdInlineBotId) {
        await this.wecomBots.deleteBot(createdInlineBotId).catch(() => undefined);
      }
      throw error;
    }
    if (
      existing?.wecomBotProfileId &&
      existing.wecomBotProfileId !== wecomBotProfileId
    ) {
      // The old binding is no longer reachable from the profile. Disconnect
      // and remove it from the internal credential store; failure here should
      // not roll back a successfully saved assistant configuration.
      await this.wecomBots
        .deleteBot(existing.wecomBotProfileId)
        .catch((error: unknown) =>
          console.error("Failed to remove replaced assistant WeCom bot", error),
        );
    }
    if (!profile.enabled) {
      await this.tasks.disableTasksForAssistant(profile.id);
    }
    this.emitStateChanged();
    return profile;
  }

  async deleteProfile(assistantId: string): Promise<void> {
    const profile = this.requireProfile(assistantId);
    if (this.hasActiveTurns(assistantId)) {
      throw new Error("私人助理仍有消息正在处理，暂时不能删除。");
    }
    if (this.tasks.hasRunningRunsForAssistant(assistantId)) {
      throw new Error("私人助理仍有定时任务正在运行，暂时不能删除。");
    }
    await this.runner.close(assistantId);
    await this.tasks.removeAssistant(assistantId);
    await this.store.removeProfile(assistantId);
    if (profile.wecomBotProfileId) {
      await this.wecomBots
        .deleteBot(profile.wecomBotProfileId)
        .catch((error: unknown) =>
          console.error("Failed to remove deleted assistant WeCom bot", error),
        );
    }
    this.emitStateChanged();
  }

  async sendDesktopMessage(
    request: SendAssistantMessageRequest,
  ): Promise<AssistantTurnRecord> {
    if (!request || typeof request !== "object") {
      throw new Error("私人助理消息请求无效。");
    }
    const profile = this.requireEnabledProfile(
      requireText(request.assistantId, "助理 ID", 200),
    );
    return this.enqueueTurn(profile, {
      source: "desktop",
      request: requireText(
        request.text,
        "消息",
        MAX_ASSISTANT_MESSAGE_CHARACTERS,
        { multiline: true },
      ),
    });
  }

  async resetOwnerConversation(
    assistantId: string,
  ): Promise<AssistantConversationRecord> {
    this.requireProfile(assistantId);
    if (this.hasActiveTurns(assistantId)) {
      throw new Error("仍有消息正在处理，暂时不能开始新对话。");
    }
    await this.ensureOwnerConversation(assistantId);
    await this.runner.close(assistantId);
    const conversation = await this.store.resetConversation(
      assistantId,
      this.now(),
    );
    this.emitStateChanged();
    return conversation;
  }

  async closeOwnerConversation(assistantId: string): Promise<void> {
    this.requireProfile(assistantId);
    if (this.hasActiveTurns(assistantId)) {
      throw new Error("仍有消息正在处理，暂时不能关闭会话。");
    }
    await this.runner.close(assistantId);
    this.emitStateChanged();
  }

  async cancelTurn(conversationId: string, turnId?: string): Promise<void> {
    this.requireProfile(conversationId);
    const turns = this.store.listTurnsForConversation(conversationId);
    const active = turnId
      ? turns.find((turn) => turn.id === turnId)
      : turns.find((turn) => turn.status === "running") ??
        turns.find((turn) => turn.status === "queued");
    if (!active || !isActiveTurn(active)) {
      throw new Error(
        turnId
          ? "这条消息已经结束或不存在。"
          : "当前没有可停止的助理消息。",
      );
    }
    if (turnId && active.status !== "queued") {
      throw new Error("这条消息已经开始处理，请使用“停止”。");
    }
    if (active.status === "running") {
      if (!this.runner.cancel(active.id)) {
        throw new Error("当前对话轮次已经结束或无法中断。");
      }
      return;
    }
    await this.store.completeTurn(
      {
        ...active,
        status: "cancelled",
        finishedAt: this.now(),
        error: "主人在执行前取消了这条消息。",
      },
      undefined,
      this.now(),
    );
    this.emitStateChanged();
  }

  async disableProfilesForProject(projectId: string): Promise<void> {
    const profiles = this.store
      .listProfiles()
      .filter((profile) => profile.projectId === projectId);
    if (
      profiles.some(
        (profile) =>
          this.hasActiveTurns(profile.id) ||
          this.tasks.hasRunningRunsForAssistant(profile.id),
      )
    ) {
      throw new Error("工程仍有私人助理聊天或定时任务正在运行。");
    }
    for (const profile of profiles) {
      await this.runner.close(profile.id);
      await this.tasks.disableTasksForAssistant(profile.id);
    }
    await this.store.disableProfilesForProject(projectId, this.now());
    this.emitStateChanged();
  }

  handleWeComMessage = async (
    message: AssistantWeComMessage,
  ): Promise<AssistantWeComMessageResult | null> => {
    const profile = this.store.findProfileByWeComBot(message.botProfileId);
    if (!profile) {
      return null;
    }
    if (message.chatType !== "single") {
      // A group may ask for its own WeCom chat ID as a diagnostic. This is a
      // deliberately narrow exception: it never opens the assistant session
      // or routes arbitrary group content to Claude. Other group messages
      // remain silent and never enter the owner's assistant session.
      if (message.chatType === "group" && isChatIdCommand(message.text)) {
        if (!profile.enabled) {
          return {
            status: "rejected",
            message: "私人助理当前已停用。",
          };
        }
        const chatId = message.chatId.trim();
        if (!chatId) {
          return {
            status: "rejected",
            message: "本条群聊消息缺少 chatid，无法返回群 ID。",
          };
        }
        return {
          status: "accepted",
          message: `本群 chatid：\`${chatId}\`。此命令只用于查看群 ID，不会把群消息交给私人助理。`,
        };
      }
      return {
        status: "rejected",
        message: "当前只接受主人单聊，群聊消息已静默忽略。",
        silent: true,
      };
    }
    if (!profile.ownerWeComUserId) {
      return {
        status: "rejected",
        message: "尚未配置主人 userid，消息已静默忽略。请在助理配置中填写真实 userid。",
        silent: true,
      };
    }
    if (message.userId !== profile.ownerWeComUserId) {
      return {
        status: "rejected",
        message:
          "发送者不是当前助理配置的主人 userid，消息已静默忽略。若机器人由非企业超级管理员创建，企业微信回调可能返回加密 userid，请使用回调值或改用超级管理员创建的机器人。",
        silent: true,
      };
    }
    const duplicate = this.store.findTurnByMessageId(
      message.botProfileId,
      message.messageId,
    );
    if (duplicate) {
      return { status: "accepted", message: "这条消息已经接收，不会重复执行。" };
    }
    if (!profile.enabled) {
      return {
        status: "rejected",
        message: "私人助理当前已停用。",
      };
    }
    const command = message.text.trim().toLocaleLowerCase("en-US");
    if (command === "/help") {
      return {
        status: "accepted",
        message:
          "可用命令：/status 查看状态，/stop 停止当前轮次，/close 关闭常驻会话并保留上下文，/new 开始全新对话。其他文字会直接交给私人助理，也可以自然语言创建和管理定时任务。",
      };
    }
    if (command === "/status") {
      const turns = this.store.listTurnsForConversation(profile.id);
      const latest = turns.at(-1);
      const tasks = this.tasks.listTasks(profile.id);
      const recentRuns = this.tasks.listRuns({ assistantId: profile.id, limit: 20 });
      const failedRuns = recentRuns.filter(
        (run) => run.status === "failed" || run.status === "timed-out",
      ).length;
      const online = this.runner.listOpenAssistantIds().includes(profile.id);
      return {
        status: "accepted",
        message: [
          `助理：${profile.name}`,
          `主人会话：${online ? "在线" : "已关闭，下条消息将恢复"}`,
          `聊天：${turnStatusLabel(latest)}`,
          `定时任务：${tasks.filter((task) => task.enabled).length}/${tasks.length} 个启用`,
          `最近任务失败：${failedRuns} 次`,
          ...(this.tasks.getSchedulerError()
            ? [`调度异常：${this.tasks.getSchedulerError()}`]
            : []),
        ].join("\n"),
      };
    }
    if (command === "/stop") {
      try {
        await this.cancelTurn(profile.id);
        return { status: "accepted", message: "已请求停止当前助理轮次。" };
      } catch (error) {
        return { status: "rejected", message: readableError(error) };
      }
    }
    if (command === "/close") {
      try {
        await this.closeOwnerConversation(profile.id);
        return {
          status: "accepted",
          message: "主人会话进程已关闭；上下文已保留，下条消息会恢复。",
        };
      } catch (error) {
        return { status: "rejected", message: readableError(error) };
      }
    }
    if (command === "/new") {
      try {
        await this.resetOwnerConversation(profile.id);
        return { status: "accepted", message: "已开始全新的主人对话。" };
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
      message: `已交给 ${profile.name}，排队编号 ${turn.id.slice(0, 8)}；完成后会在本单聊回复。`,
    };
  };

  dispose(): Promise<void> {
    this.disposePromise ??= this.disposeInternal();
    return this.disposePromise;
  }

  private async disposeInternal(): Promise<void> {
    this.shuttingDown = true;
    this.runner.off?.("stateChanged", this.onNestedStateChanged);
    this.wecomBots.off?.("stateChanged", this.onNestedStateChanged);
    this.tasks.off("stateChanged", this.onNestedStateChanged);
    this.runner.dispose();
    await this.tasks.dispose();
    await Promise.allSettled([...this.workers.values()]);
    const timestamp = this.now();
    for (const turn of this.store.listTurns().filter(isActiveTurn)) {
      await this.store.completeTurn(
        {
          ...turn,
          status: "cancelled",
          finishedAt: timestamp,
          error: "客户端关闭，本轮对话已取消；已保存的会话仍可恢复。",
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
    if (!legacyRuntimePath(profile, this.getProject)) {
      throw new Error("私人助理没有配置可用的运行目录，请在配置中重新选择。");
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
      let projectRoot: string;
      let taskMcpServer: AssistantTaskMcpServer;
      try {
        profile = this.requireEnabledProfile(turn.assistantId);
        const configuredPath = legacyRuntimePath(profile, this.getProject);
        if (!configuredPath) {
          throw new Error("私人助理没有配置可用的运行目录，请在配置中重新选择。");
        }
        projectRoot = await validateAssistantRuntimePath(configuredPath);
        taskMcpServer = await this.tasks.createMcpServer(profile.id);
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
          projectRoot,
          prompt: running.request,
          taskMcpServer,
          onSessionId: async (sessionId) => {
            await this.store.setConversationSessionId(
              running.conversationId,
              sessionId,
              this.now(),
            );
            this.emitStateChanged();
          },
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
            sessionId: result.sessionId,
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
      normalizedResult.sessionId,
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
      await withTimeout(
        this.wecomBots.sendMarkdown(turn.botProfileId, turn.userId, content),
        WECOM_DELIVERY_TIMEOUT_MILLISECONDS,
        "企业微信回复超过 15 秒仍未完成。",
      );
    } catch (error) {
      await this.store.replaceTurn({
        ...completed,
        deliveryError: `企业微信回复失败：${readableError(error)}`,
      });
      this.emitStateChanged();
    }
  }

  private emitStateChanged(): void {
    if (!this.initialized) {
      return;
    }
    if (this.nestedStateChangeSuppressionDepth > 0) {
      this.nestedStateChangePending = true;
      return;
    }
    this.emit("stateChanged", this.getSnapshot());
  }

  private async withNestedStateChangesSuppressed<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    this.nestedStateChangeSuppressionDepth += 1;
    try {
      return await operation();
    } finally {
      this.nestedStateChangeSuppressionDepth -= 1;
      if (
        this.nestedStateChangeSuppressionDepth === 0 &&
        this.nestedStateChangePending
      ) {
        this.nestedStateChangePending = false;
        this.emitStateChanged();
      }
    }
  }

  /**
   * Older assistant.json files stored a workbench project id. Resolve that id
   * once to an absolute path and then drop the id so future workbench changes
   * cannot disable or redirect the assistant.
   */
  private async migrateLegacyRuntimePaths(): Promise<void> {
    for (const profile of this.store.listProfiles()) {
      if (!profile.projectId) {
        continue;
      }
      if (profile.projectPath.trim()) {
        const migrated = { ...profile };
        delete migrated.projectId;
        await this.store.putProfile(migrated).catch((error: unknown) => {
          console.error("Failed to migrate assistant runtime path", error);
        });
        continue;
      }
      const legacyProject = this.getProject?.(profile.projectId);
      if (!legacyProject) {
        continue;
      }
      try {
        const migratedPath = await validateAssistantRuntimePath(
          legacyProject.rootPath,
        );
        const migrated = { ...profile, projectPath: migratedPath };
        delete migrated.projectId;
        await this.store.putProfile(migrated);
      } catch (error) {
        console.error("Failed to migrate assistant runtime path", error);
      }
    }
  }
}
