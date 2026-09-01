import {
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";
import type {
  AssistantConversationRecord,
  AssistantProfileRecord,
  AssistantTurnRecord,
  AssistantTurnStatus,
} from "../shared/contracts";

export interface StoredAssistantWeComBot {
  id: string;
  name: string;
  enabled: boolean;
  botId: string;
  encryptedSecret: string;
  createdAt: number;
  updatedAt: number;
}

interface AssistantStoreData {
  version: 2;
  profiles: AssistantProfileRecord[];
  conversations: AssistantConversationRecord[];
  turns: AssistantTurnRecord[];
  wecomBots: StoredAssistantWeComBot[];
  legacyWeComBotsImported: boolean;
}

const EMPTY_STORE: AssistantStoreData = {
  version: 2,
  profiles: [],
  conversations: [],
  turns: [],
  wecomBots: [],
  legacyWeComBotsImported: false,
};

const MAX_ASSISTANT_PROFILES = 20;
const MAX_ASSISTANT_CONVERSATIONS = MAX_ASSISTANT_PROFILES;
const MAX_ASSISTANT_TURNS = 500;
const MAX_ACTIVE_TURNS_PER_CONVERSATION = 10;
const MAX_ASSISTANT_WECOM_BOTS = 20;
const MAX_ASSISTANT_FILE_BYTES = 128 * 1024 * 1024;
const TURN_STATUSES = new Set<AssistantTurnStatus>([
  "queued",
  "running",
  "succeeded",
  "failed",
  "timed-out",
  "cancelled",
]);

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function optionalNumber(value: unknown): value is number | undefined {
  return value === undefined || (typeof value === "number" && Number.isFinite(value));
}

function validIdentifier(value: string, allowEmpty = false): boolean {
  return (
    (allowEmpty || Boolean(value)) &&
    [...value].length <= 200 &&
    !/\p{Cc}|\s/u.test(value)
  );
}

function validMultilineText(value: string, maximum: number): boolean {
  return (
    [...value].length <= maximum &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value)
  );
}

function normalizeProfile(value: unknown): AssistantProfileRecord | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as Partial<AssistantProfileRecord>;
  if (
    typeof candidate.id !== "string" ||
    typeof candidate.name !== "string" ||
    typeof candidate.enabled !== "boolean" ||
    typeof candidate.projectId !== "string" ||
    typeof candidate.instructions !== "string" ||
    typeof candidate.ownerWeComUserId !== "string" ||
    !optionalString(candidate.wecomBotProfileId) ||
    typeof candidate.timeoutMinutes !== "number" ||
    typeof candidate.maxTurns !== "number" ||
    typeof candidate.createdAt !== "number" ||
    !Number.isFinite(candidate.createdAt) ||
    typeof candidate.updatedAt !== "number" ||
    !Number.isFinite(candidate.updatedAt) ||
    !validIdentifier(candidate.id) ||
    !candidate.name.trim() ||
    [...candidate.name].length > 80 ||
    /\p{Cc}/u.test(candidate.name) ||
    !validIdentifier(candidate.projectId) ||
    !validMultilineText(candidate.instructions, 4_000) ||
    !validIdentifier(candidate.ownerWeComUserId, true) ||
    (candidate.wecomBotProfileId !== undefined &&
      !validIdentifier(candidate.wecomBotProfileId)) ||
    !Number.isInteger(candidate.timeoutMinutes) ||
    candidate.timeoutMinutes < 1 ||
    candidate.timeoutMinutes > 120 ||
    !Number.isInteger(candidate.maxTurns) ||
    candidate.maxTurns < 1 ||
    candidate.maxTurns > 100
  ) {
    return null;
  }
  return {
    id: candidate.id,
    name: candidate.name,
    enabled: candidate.enabled,
    projectId: candidate.projectId,
    instructions: candidate.instructions,
    ownerWeComUserId: candidate.ownerWeComUserId,
    ...(candidate.wecomBotProfileId
      ? { wecomBotProfileId: candidate.wecomBotProfileId }
      : {}),
    timeoutMinutes: candidate.timeoutMinutes,
    maxTurns: candidate.maxTurns,
    createdAt: candidate.createdAt,
    updatedAt: candidate.updatedAt,
  };
}

function normalizeConversation(
  value: unknown,
): AssistantConversationRecord | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as Partial<AssistantConversationRecord>;
  if (
    typeof candidate.id !== "string" ||
    typeof candidate.assistantId !== "string" ||
    candidate.id !== candidate.assistantId ||
    candidate.kind !== "owner" ||
    !optionalString(candidate.claudeSessionId) ||
    typeof candidate.createdAt !== "number" ||
    !Number.isFinite(candidate.createdAt) ||
    typeof candidate.updatedAt !== "number" ||
    !Number.isFinite(candidate.updatedAt) ||
    !optionalNumber(candidate.lastMessageAt) ||
    !validIdentifier(candidate.id) ||
    !validIdentifier(candidate.assistantId) ||
    (candidate.claudeSessionId !== undefined &&
      !validIdentifier(candidate.claudeSessionId))
  ) {
    return null;
  }
  return clone(candidate as AssistantConversationRecord);
}

function limitTurns(turns: AssistantTurnRecord[]): AssistantTurnRecord[] {
  const sorted = [...turns].sort(
    (left, right) => left.createdAt - right.createdAt,
  );
  if (sorted.length <= MAX_ASSISTANT_TURNS) {
    return sorted;
  }
  const active = sorted.filter(
    (turn) => turn.status === "queued" || turn.status === "running",
  );
  if (active.length > MAX_ASSISTANT_TURNS) {
    throw new Error("Assistant data contains too many active turns.");
  }
  const activeIds = new Set(active.map((turn) => turn.id));
  const completed = sorted.filter((turn) => !activeIds.has(turn.id));
  return [
    ...completed.slice(-(MAX_ASSISTANT_TURNS - active.length)),
    ...active,
  ].sort((left, right) => left.createdAt - right.createdAt);
}

function normalizeTurn(value: unknown): AssistantTurnRecord | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as Partial<AssistantTurnRecord>;
  if (
    typeof candidate.id !== "string" ||
    typeof candidate.assistantId !== "string" ||
    typeof candidate.conversationId !== "string" ||
    (candidate.source !== "desktop" && candidate.source !== "wecom") ||
    !optionalString(candidate.messageId) ||
    !optionalString(candidate.botProfileId) ||
    !optionalString(candidate.userId) ||
    typeof candidate.request !== "string" ||
    typeof candidate.status !== "string" ||
    !TURN_STATUSES.has(candidate.status as AssistantTurnStatus) ||
    !optionalString(candidate.response) ||
    !optionalString(candidate.error) ||
    !optionalString(candidate.deliveryError) ||
    typeof candidate.createdAt !== "number" ||
    !Number.isFinite(candidate.createdAt) ||
    !optionalNumber(candidate.startedAt) ||
    !optionalNumber(candidate.finishedAt) ||
    !validIdentifier(candidate.id) ||
    !validIdentifier(candidate.assistantId) ||
    !validIdentifier(candidate.conversationId) ||
    !candidate.request.trim() ||
    !validMultilineText(candidate.request, 4_000) ||
    (candidate.response !== undefined &&
      !validMultilineText(candidate.response, 50_000)) ||
    (candidate.error !== undefined &&
      !validMultilineText(candidate.error, 10_000)) ||
    (candidate.deliveryError !== undefined &&
      !validMultilineText(candidate.deliveryError, 10_000)) ||
    (candidate.source === "desktop" &&
      (candidate.messageId !== undefined ||
        candidate.botProfileId !== undefined ||
        candidate.userId !== undefined ||
        candidate.deliveryError !== undefined)) ||
    (candidate.source === "wecom" &&
      (!candidate.messageId ||
        !candidate.botProfileId ||
        !candidate.userId ||
        !validIdentifier(candidate.messageId) ||
        !validIdentifier(candidate.botProfileId) ||
        !validIdentifier(candidate.userId)))
  ) {
    return null;
  }
  return clone(candidate as AssistantTurnRecord);
}

function normalizeStoredWeComBot(
  value: unknown,
): StoredAssistantWeComBot | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as Partial<StoredAssistantWeComBot>;
  if (
    typeof candidate.id !== "string" ||
    !validIdentifier(candidate.id) ||
    typeof candidate.name !== "string" ||
    !candidate.name.trim() ||
    candidate.name !== candidate.name.trim() ||
    [...candidate.name].length > 80 ||
    /\p{Cc}/u.test(candidate.name) ||
    typeof candidate.enabled !== "boolean" ||
    typeof candidate.botId !== "string" ||
    !validIdentifier(candidate.botId) ||
    typeof candidate.encryptedSecret !== "string" ||
    [...candidate.encryptedSecret].length > 10_000 ||
    typeof candidate.createdAt !== "number" ||
    !Number.isFinite(candidate.createdAt) ||
    typeof candidate.updatedAt !== "number" ||
    !Number.isFinite(candidate.updatedAt)
  ) {
    return null;
  }
  return clone(candidate as StoredAssistantWeComBot);
}

function parseStore(raw: string): AssistantStoreData {
  const parsed = JSON.parse(raw) as {
    version?: unknown;
    profiles?: unknown;
    conversations?: unknown;
    turns?: unknown;
    wecomBots?: unknown;
    legacyWeComBotsImported?: unknown;
  };
  if (
    (parsed.version !== 1 && parsed.version !== 2) ||
    !Array.isArray(parsed.profiles) ||
    !Array.isArray(parsed.conversations) ||
    !Array.isArray(parsed.turns)
  ) {
    throw new Error("Assistant data has an unsupported format.");
  }
  const profiles = parsed.profiles.map(normalizeProfile);
  const conversations = parsed.conversations.map(normalizeConversation);
  const turns = parsed.turns.map(normalizeTurn);
  const wecomBots =
    parsed.version === 1 && parsed.wecomBots === undefined
      ? []
      : Array.isArray(parsed.wecomBots)
        ? parsed.wecomBots.map(normalizeStoredWeComBot)
        : null;
  if (
    profiles.some((entry) => entry === null) ||
    conversations.some((entry) => entry === null) ||
    turns.some((entry) => entry === null) ||
    wecomBots === null ||
    wecomBots.some((entry) => entry === null)
  ) {
    throw new Error("Assistant data contains an invalid record.");
  }
  if (
    profiles.length > MAX_ASSISTANT_PROFILES ||
    conversations.length > MAX_ASSISTANT_CONVERSATIONS ||
    wecomBots.length > MAX_ASSISTANT_WECOM_BOTS
  ) {
    throw new Error("Assistant data exceeds its configured record limits.");
  }
  if (
    new Set((profiles as AssistantProfileRecord[]).map((entry) => entry.id))
      .size !== profiles.length ||
    new Set(
      (conversations as AssistantConversationRecord[]).map((entry) => entry.id),
    ).size !== conversations.length ||
    new Set((turns as AssistantTurnRecord[]).map((entry) => entry.id)).size !==
      turns.length ||
    new Set((wecomBots as StoredAssistantWeComBot[]).map((entry) => entry.id))
      .size !== wecomBots.length
  ) {
    throw new Error("Assistant data contains duplicate record IDs.");
  }
  const configuredBotProfileIds = (profiles as AssistantProfileRecord[])
    .flatMap((profile) =>
      profile.wecomBotProfileId ? [profile.wecomBotProfileId] : [],
    );
  if (
    new Set(configuredBotProfileIds).size !== configuredBotProfileIds.length
  ) {
    throw new Error("Assistant data binds one WeCom entry more than once.");
  }
  const profileRecords = profiles as AssistantProfileRecord[];
  const profileIds = new Set(profileRecords.map((profile) => profile.id));
  const conversationRecords = (conversations as AssistantConversationRecord[])
    .filter((conversation) => profileIds.has(conversation.assistantId))
    .sort((left, right) => right.updatedAt - left.updatedAt);
  const conversationIds = new Set(
    conversationRecords.map((conversation) => conversation.id),
  );
  const turnRecords = limitTurns(
    (turns as AssistantTurnRecord[]).filter(
      (turn) =>
        profileIds.has(turn.assistantId) &&
        conversationIds.has(turn.conversationId) &&
        turn.assistantId === turn.conversationId,
    ),
  );
  for (const conversation of conversationRecords) {
    if (conversation.lastMessageAt !== undefined) {
      continue;
    }
    const latestTurn = turnRecords
      .filter((turn) => turn.conversationId === conversation.id)
      .at(-1);
    if (latestTurn) {
      conversation.lastMessageAt = latestTurn.createdAt;
      conversation.updatedAt = Math.max(
        conversation.updatedAt,
        latestTurn.createdAt,
      );
    }
  }
  return {
    version: 2,
    profiles: profileRecords,
    conversations: conversationRecords,
    turns: turnRecords,
    wecomBots: wecomBots as StoredAssistantWeComBot[],
    legacyWeComBotsImported:
      parsed.version === 2 && parsed.legacyWeComBotsImported === true,
  };
}

export class AssistantStore {
  private data: AssistantStoreData = clone(EMPTY_STORE);
  private initialized = false;
  private persistQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly storePath: string,
    private readonly legacyAutomationStorePath?: string,
  ) {}

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    await mkdir(dirname(this.storePath), { recursive: true });
    try {
      const storeStat = await stat(this.storePath);
      if (!storeStat.isFile() || storeStat.size > MAX_ASSISTANT_FILE_BYTES) {
        throw new Error("Assistant data file is not a regular file or is too large.");
      }
      this.data = parseStore(await readFile(this.storePath, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        await this.backupCorruptStore().catch(() => undefined);
      }
      this.data = clone(EMPTY_STORE);
    }
    this.initialized = true;
    await this.importLegacyWeComBots();
  }

  private async importLegacyWeComBots(): Promise<void> {
    if (this.data.legacyWeComBotsImported) {
      return;
    }
    try {
      if (this.legacyAutomationStorePath) {
        const legacyStat = await stat(this.legacyAutomationStorePath);
        if (!legacyStat.isFile() || legacyStat.size > MAX_ASSISTANT_FILE_BYTES) {
          throw new Error("Legacy automation data is not a regular file or is too large.");
        }
        const legacy = JSON.parse(
          await readFile(this.legacyAutomationStorePath, "utf8"),
        ) as { wecomBots?: unknown };
        if (Array.isArray(legacy.wecomBots)) {
          for (const value of legacy.wecomBots) {
            const bot = normalizeStoredWeComBot(value);
            if (!bot || this.data.wecomBots.length >= MAX_ASSISTANT_WECOM_BOTS) {
              continue;
            }
            const nameKey = bot.name.toLocaleLowerCase("zh-CN");
            const botIdKey = bot.botId.toLocaleLowerCase("en-US");
            if (
              this.data.wecomBots.some(
                (existing) =>
                  existing.id === bot.id ||
                  existing.name.toLocaleLowerCase("zh-CN") === nameKey ||
                  existing.botId.toLocaleLowerCase("en-US") === botIdKey,
              )
            ) {
              continue;
            }
            this.data.wecomBots.push(bot);
          }
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error("Failed to import legacy assistant WeCom entries", error);
      }
    }
    this.data.legacyWeComBotsImported = true;
    await this.persist();
  }

  listStoredWeComBots(): StoredAssistantWeComBot[] {
    this.assertInitialized();
    return this.data.wecomBots
      .map((bot) => clone(bot))
      .sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
  }

  getStoredWeComBot(
    botProfileId: string,
  ): StoredAssistantWeComBot | undefined {
    this.assertInitialized();
    const bot = this.data.wecomBots.find(
      (candidate) => candidate.id === botProfileId,
    );
    return bot ? clone(bot) : undefined;
  }

  async putStoredWeComBot(bot: StoredAssistantWeComBot): Promise<void> {
    this.assertInitialized();
    const normalized = normalizeStoredWeComBot(bot);
    if (!normalized) {
      throw new Error("企业微信助理入口格式无效。");
    }
    const index = this.data.wecomBots.findIndex(
      (candidate) => candidate.id === normalized.id,
    );
    if (index < 0) {
      if (this.data.wecomBots.length >= MAX_ASSISTANT_WECOM_BOTS) {
        throw new Error(`企业微信助理入口最多可以配置 ${MAX_ASSISTANT_WECOM_BOTS} 个。`);
      }
      this.data.wecomBots.push(normalized);
    } else {
      this.data.wecomBots[index] = normalized;
    }
    await this.persist();
  }

  async removeStoredWeComBot(botProfileId: string): Promise<void> {
    this.assertInitialized();
    if (
      this.data.profiles.some(
        (profile) => profile.wecomBotProfileId === botProfileId,
      )
    ) {
      throw new Error("仍有私人助理绑定这个企业微信入口，请先解除绑定。");
    }
    const next = this.data.wecomBots.filter(
      (candidate) => candidate.id !== botProfileId,
    );
    if (next.length === this.data.wecomBots.length) {
      throw new Error("企业微信助理入口不存在或已经删除。");
    }
    this.data.wecomBots = next;
    await this.persist();
  }

  listProfiles(): AssistantProfileRecord[] {
    this.assertInitialized();
    return this.data.profiles
      .map((profile) => clone(profile))
      .sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
  }

  getProfile(assistantId: string): AssistantProfileRecord | undefined {
    this.assertInitialized();
    const profile = this.data.profiles.find((candidate) => candidate.id === assistantId);
    return profile ? clone(profile) : undefined;
  }

  findProfileByWeComBot(
    botProfileId: string,
  ): AssistantProfileRecord | undefined {
    this.assertInitialized();
    const profile = this.data.profiles.find(
      (candidate) => candidate.wecomBotProfileId === botProfileId,
    );
    return profile ? clone(profile) : undefined;
  }

  async putProfile(profile: AssistantProfileRecord): Promise<void> {
    this.assertInitialized();
    const index = this.data.profiles.findIndex(
      (candidate) => candidate.id === profile.id,
    );
    const existing = index < 0 ? undefined : this.data.profiles[index];
    if (
      existing?.ownerWeComUserId &&
      profile.ownerWeComUserId !== existing.ownerWeComUserId
    ) {
      throw new Error("主人 userid 保存后不能更换。");
    }
    if (
      profile.wecomBotProfileId &&
      this.data.profiles.some(
        (candidate) =>
          candidate.id !== profile.id &&
          candidate.wecomBotProfileId === profile.wecomBotProfileId,
      )
    ) {
      throw new Error("这个企业微信入口已经绑定到其他私人助理。");
    }
    if (index < 0) {
      if (this.data.profiles.length >= MAX_ASSISTANT_PROFILES) {
        throw new Error(`私人助理最多可以配置 ${MAX_ASSISTANT_PROFILES} 个。`);
      }
      this.data.profiles.push(clone(profile));
    } else {
      this.data.profiles[index] = clone(profile);
    }
    await this.persist();
  }

  async removeProfile(assistantId: string): Promise<void> {
    this.assertInitialized();
    const nextProfiles = this.data.profiles.filter(
      (candidate) => candidate.id !== assistantId,
    );
    if (nextProfiles.length === this.data.profiles.length) {
      throw new Error("私人助理不存在或已经删除。");
    }
    const removedConversationIds = new Set(
      this.data.conversations
        .filter((conversation) => conversation.assistantId === assistantId)
        .map((conversation) => conversation.id),
    );
    this.data.profiles = nextProfiles;
    this.data.conversations = this.data.conversations.filter(
      (conversation) => conversation.assistantId !== assistantId,
    );
    this.data.turns = this.data.turns.filter(
      (turn) => !removedConversationIds.has(turn.conversationId),
    );
    await this.persist();
  }

  listConversations(assistantId?: string): AssistantConversationRecord[] {
    this.assertInitialized();
    return this.data.conversations
      .filter(
        (conversation) =>
          assistantId === undefined || conversation.assistantId === assistantId,
      )
      .map((conversation) => clone(conversation))
      .sort((left, right) => right.updatedAt - left.updatedAt);
  }

  getConversation(
    conversationId: string,
  ): AssistantConversationRecord | undefined {
    this.assertInitialized();
    const conversation = this.data.conversations.find(
      (candidate) => candidate.id === conversationId,
    );
    return conversation ? clone(conversation) : undefined;
  }

  async putConversation(
    conversation: AssistantConversationRecord,
  ): Promise<void> {
    this.assertInitialized();
    if (
      conversation.kind !== "owner" ||
      conversation.id !== conversation.assistantId
    ) {
      throw new Error("私人助理只允许保存与助理同 ID 的主人会话。");
    }
    if (!this.data.profiles.some((profile) => profile.id === conversation.id)) {
      throw new Error("私人助理会话关联的助理不存在。");
    }
    const index = this.data.conversations.findIndex(
      (candidate) => candidate.id === conversation.id,
    );
    if (index < 0) {
      if (this.data.conversations.length >= MAX_ASSISTANT_CONVERSATIONS) {
        throw new Error("私人助理主人会话数量超过配置上限。");
      }
      this.data.conversations.push(clone(conversation));
    } else {
      this.data.conversations[index] = clone(conversation);
    }
    await this.persist();
  }

  listTurns(limit = MAX_ASSISTANT_TURNS): AssistantTurnRecord[] {
    this.assertInitialized();
    return this.data.turns
      .slice(-Math.max(0, Math.min(limit, MAX_ASSISTANT_TURNS)))
      .map((turn) => clone(turn));
  }

  listTurnsForConversation(
    conversationId: string,
  ): AssistantTurnRecord[] {
    this.assertInitialized();
    return this.data.turns
      .filter((turn) => turn.conversationId === conversationId)
      .map((turn) => clone(turn));
  }

  findTurnByMessageId(
    botProfileId: string,
    messageId: string,
  ): AssistantTurnRecord | undefined {
    this.assertInitialized();
    const turn = this.data.turns.find(
      (candidate) =>
        candidate.source === "wecom" &&
        candidate.botProfileId === botProfileId &&
        candidate.messageId === messageId,
    );
    return turn ? clone(turn) : undefined;
  }

  async appendTurn(turn: AssistantTurnRecord): Promise<void> {
    this.assertInitialized();
    if (
      turn.assistantId !== turn.conversationId ||
      !this.data.conversations.some(
        (conversation) => conversation.id === turn.conversationId,
      )
    ) {
      throw new Error("私人助理轮次没有有效的主人会话。");
    }
    if (this.data.turns.some((candidate) => candidate.id === turn.id)) {
      throw new Error("同一助理轮次已经存在。");
    }
    if (
      (turn.status === "queued" || turn.status === "running") &&
      this.data.turns.filter(
        (candidate) =>
          candidate.conversationId === turn.conversationId &&
          (candidate.status === "queued" || candidate.status === "running"),
      ).length >= MAX_ACTIVE_TURNS_PER_CONVERSATION
    ) {
      throw new Error("当前助理等待处理的消息过多，请稍后再试。");
    }
    this.data.turns = limitTurns([...this.data.turns, clone(turn)]);
    const conversation = this.data.conversations.find(
      (candidate) => candidate.id === turn.conversationId,
    );
    if (conversation) {
      conversation.lastMessageAt = turn.createdAt;
      conversation.updatedAt = Math.max(conversation.updatedAt, turn.createdAt);
    }
    await this.persist();
  }

  async replaceTurn(turn: AssistantTurnRecord): Promise<void> {
    this.assertInitialized();
    this.replaceTurnInMemory(turn);
    await this.persist();
  }

  async completeTurn(
    turn: AssistantTurnRecord,
    claudeSessionId: string | undefined,
    now = Date.now(),
  ): Promise<void> {
    this.assertInitialized();
    if (turn.status === "queued" || turn.status === "running") {
      throw new Error("只有已结束的私人助理轮次可以完成落盘。");
    }
    const conversation = this.data.conversations.find(
      (candidate) => candidate.id === turn.conversationId,
    );
    if (!conversation) {
      throw new Error("私人助理轮次关联的主人会话不存在。");
    }
    this.replaceTurnInMemory(turn);
    if (claudeSessionId) {
      conversation.claudeSessionId = claudeSessionId;
    }
    conversation.updatedAt = Math.max(conversation.updatedAt, now);
    await this.persist();
  }

  async setConversationSessionId(
    conversationId: string,
    claudeSessionId: string,
    now = Date.now(),
  ): Promise<void> {
    this.assertInitialized();
    if (!validIdentifier(claudeSessionId)) {
      throw new Error("Claude Code 会话 ID 格式无效。");
    }
    const conversation = this.data.conversations.find(
      (candidate) => candidate.id === conversationId,
    );
    if (!conversation) {
      throw new Error("私人助理会话不存在。");
    }
    if (conversation.claudeSessionId === claudeSessionId) {
      return;
    }
    conversation.claudeSessionId = claudeSessionId;
    conversation.updatedAt = Math.max(conversation.updatedAt, now);
    await this.persist();
  }

  private replaceTurnInMemory(turn: AssistantTurnRecord): void {
    const index = this.data.turns.findIndex(
      (candidate) => candidate.id === turn.id,
    );
    if (index < 0) {
      throw new Error("私人助理轮次不存在或已经被清理。");
    }
    const existing = this.data.turns[index];
    if (
      turn.assistantId !== existing.assistantId ||
      turn.conversationId !== existing.conversationId ||
      turn.source !== existing.source ||
      turn.messageId !== existing.messageId ||
      turn.botProfileId !== existing.botProfileId ||
      turn.userId !== existing.userId ||
      turn.request !== existing.request ||
      turn.createdAt !== existing.createdAt
    ) {
      throw new Error("私人助理轮次的身份或原始消息不可修改。");
    }
    this.data.turns[index] = clone(turn);
  }

  async resetConversation(
    conversationId: string,
    now = Date.now(),
  ): Promise<AssistantConversationRecord> {
    this.assertInitialized();
    const conversation = this.data.conversations.find(
      (candidate) => candidate.id === conversationId,
    );
    if (!conversation) {
      throw new Error("私人助理会话不存在。");
    }
    delete conversation.claudeSessionId;
    conversation.updatedAt = now;
    this.data.turns = this.data.turns.filter(
      (turn) => turn.conversationId !== conversationId,
    );
    await this.persist();
    return clone(conversation);
  }

  async recoverInterruptedTurns(now = Date.now()): Promise<number> {
    this.assertInitialized();
    const affectedConversationIds = new Set<string>();
    let recovered = 0;
    for (const turn of this.data.turns) {
      if (turn.status !== "queued" && turn.status !== "running") {
        continue;
      }
      turn.status = "failed";
      turn.finishedAt = now;
      turn.error = "客户端上次退出时这一轮尚未完成，结果未知；下一条消息将从已保存的会话恢复。";
      affectedConversationIds.add(turn.conversationId);
      recovered += 1;
    }
    for (const conversation of this.data.conversations) {
      if (affectedConversationIds.has(conversation.id)) {
        conversation.updatedAt = now;
      }
    }
    if (recovered > 0) {
      await this.persist();
    }
    return recovered;
  }

  async disableProfilesForProject(
    projectId: string,
    now = Date.now(),
  ): Promise<void> {
    this.assertInitialized();
    let changed = false;
    for (const profile of this.data.profiles) {
      if (profile.projectId === projectId && profile.enabled) {
        profile.enabled = false;
        profile.updatedAt = now;
        changed = true;
      }
    }
    if (changed) {
      await this.persist();
    }
  }

  private persist(): Promise<void> {
    const serialized = `${JSON.stringify(this.data, null, 2)}\n`;
    const temporaryPath = `${this.storePath}.tmp`;
    const operation = this.persistQueue.then(async () => {
      try {
        await writeFile(temporaryPath, serialized, "utf8");
        await rename(temporaryPath, this.storePath);
      } catch (error) {
        await rm(temporaryPath, { force: true }).catch(() => undefined);
        throw error;
      }
    });
    this.persistQueue = operation.catch(() => undefined);
    return operation;
  }

  private async backupCorruptStore(): Promise<void> {
    await copyFile(
      this.storePath,
      `${this.storePath}.corrupt-${Date.now()}.json`,
    );
  }

  private assertInitialized(): void {
    if (!this.initialized) {
      throw new Error("Assistant store has not been initialized.");
    }
  }
}
