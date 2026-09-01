import {
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";
import type {
  AutomationDeliveryRecord,
  AutomationJobRecord,
  AutomationRunOutput,
  AutomationRunRecord,
  AutomationRunStatus,
  AutomationRunTrigger,
  DiscoveredWeComGroup,
} from "../shared/contracts";

interface AutomationStoreData {
  version: 1;
  jobs: AutomationJobRecord[];
  runs: AutomationRunRecord[];
  discoveredWeComGroups: DiscoveredWeComGroup[];
}

const EMPTY_STORE: AutomationStoreData = {
  version: 1,
  jobs: [],
  runs: [],
  discoveredWeComGroups: [],
};
const MAX_STORED_RUNS = 500;
const MAX_DISCOVERED_WECOM_GROUPS = 200;
const WECOM_GROUP_LAST_SEEN_WRITE_INTERVAL_MILLISECONDS = 60_000;

const RUN_STATUSES = new Set<AutomationRunStatus>([
  "queued",
  "running",
  "succeeded",
  "failed",
  "timed-out",
  "cancelled",
  "skipped",
]);
const RUN_TRIGGERS = new Set<AutomationRunTrigger>([
  "scheduled",
  "manual",
  "wecom",
]);
const DELIVERY_STATUSES = new Set<AutomationDeliveryRecord["status"]>([
  "pending",
  "sending",
  "sent",
  "failed",
  "skipped",
]);

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function optionalNumber(value: unknown): value is number | undefined {
  return (
    value === undefined ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function normalizeJob(value: unknown): AutomationJobRecord | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as Partial<AutomationJobRecord>;
  if (
    typeof candidate.id !== "string" ||
    typeof candidate.name !== "string" ||
    typeof candidate.enabled !== "boolean" ||
    typeof candidate.projectId !== "string" ||
    typeof candidate.schedule !== "string" ||
    typeof candidate.mcpConfigPath !== "string" ||
    !isStringArray(candidate.allowedMcpServers) ||
    typeof candidate.prompt !== "string" ||
    !isStringArray(candidate.emailRecipients) ||
    !isStringArray(candidate.wecomTargetIds) ||
    !isStringArray(candidate.allowedWecomUserIds) ||
    typeof candidate.timeoutMinutes !== "number" ||
    typeof candidate.maxTurns !== "number" ||
    typeof candidate.createdAt !== "number" ||
    typeof candidate.updatedAt !== "number"
  ) {
    return null;
  }
  return clone(candidate as AutomationJobRecord);
}

function normalizeDelivery(value: unknown): AutomationDeliveryRecord | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as Partial<AutomationDeliveryRecord>;
  if (
    typeof candidate.targetId !== "string" ||
    typeof candidate.status !== "string" ||
    !DELIVERY_STATUSES.has(
      candidate.status as AutomationDeliveryRecord["status"],
    ) ||
    typeof candidate.attempts !== "number" ||
    !optionalNumber(candidate.sentAt) ||
    !optionalNumber(candidate.nextAttemptAt) ||
    !optionalString(candidate.error)
  ) {
    return null;
  }
  return clone(candidate as AutomationDeliveryRecord);
}

function normalizeRunOutput(value: unknown): AutomationRunOutput | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as Partial<AutomationRunOutput>;
  if (
    (candidate.outcome !== "notify" && candidate.outcome !== "no-change") ||
    typeof candidate.summary !== "string" ||
    typeof candidate.wecomMarkdown !== "string" ||
    !Array.isArray(candidate.evidence) ||
    !candidate.evidence.every(
      (entry) =>
        entry &&
        typeof entry === "object" &&
        typeof (entry as { title?: unknown }).title === "string" &&
        typeof (entry as { url?: unknown }).url === "string",
    ) ||
    !candidate.email ||
    typeof candidate.email !== "object" ||
    (candidate.email.status !== "not-requested" &&
      candidate.email.status !== "sent" &&
      candidate.email.status !== "failed") ||
    !isStringArray(candidate.email.recipients) ||
    typeof candidate.email.detail !== "string"
  ) {
    return null;
  }
  return clone(candidate as AutomationRunOutput);
}

function normalizeRun(value: unknown): AutomationRunRecord | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as Partial<AutomationRunRecord>;
  const deliveries = Array.isArray(candidate.deliveries)
    ? candidate.deliveries.map(normalizeDelivery)
    : [];
  const result =
    candidate.result === undefined ? undefined : normalizeRunOutput(candidate.result);
  if (
    typeof candidate.id !== "string" ||
    typeof candidate.reportCode !== "string" ||
    typeof candidate.jobId !== "string" ||
    typeof candidate.jobName !== "string" ||
    typeof candidate.trigger !== "string" ||
    !RUN_TRIGGERS.has(candidate.trigger as AutomationRunTrigger) ||
    typeof candidate.status !== "string" ||
    !RUN_STATUSES.has(candidate.status as AutomationRunStatus) ||
    typeof candidate.attempt !== "number" ||
    typeof candidate.createdAt !== "number" ||
    !optionalNumber(candidate.startedAt) ||
    !optionalNumber(candidate.finishedAt) ||
    !optionalNumber(candidate.scheduledFor) ||
    !optionalString(candidate.triggerMessageId) ||
    !optionalString(candidate.sourceRunId) ||
    !optionalString(candidate.requestedBy) ||
    !optionalString(candidate.requestText) ||
    !optionalString(candidate.quoteText) ||
    !optionalString(candidate.sessionId) ||
    !optionalNumber(candidate.exitCode) ||
    !optionalString(candidate.error) ||
    !optionalString(candidate.diagnostic) ||
    deliveries.some((entry) => entry === null) ||
    (candidate.result !== undefined && result === null)
  ) {
    return null;
  }
  return {
    ...(clone(candidate as AutomationRunRecord)),
    deliveries: deliveries as AutomationDeliveryRecord[],
    ...(result ? { result } : {}),
  };
}

function normalizeDiscoveredWeComGroup(
  value: unknown,
): DiscoveredWeComGroup | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as Partial<DiscoveredWeComGroup>;
  if (
    typeof candidate.chatId !== "string" ||
    !candidate.chatId ||
    candidate.chatId !== candidate.chatId.trim() ||
    /\s/u.test(candidate.chatId) ||
    [...candidate.chatId].length > 200 ||
    (candidate.alias !== undefined &&
      (typeof candidate.alias !== "string" ||
        !candidate.alias ||
        candidate.alias !== candidate.alias.trim() ||
        /\p{Cc}/u.test(candidate.alias) ||
        [...candidate.alias].length > 80)) ||
    typeof candidate.discoveredAt !== "number" ||
    !Number.isFinite(candidate.discoveredAt) ||
    typeof candidate.lastSeenAt !== "number" ||
    !Number.isFinite(candidate.lastSeenAt)
  ) {
    return null;
  }
  return clone(candidate as DiscoveredWeComGroup);
}

function parseStore(raw: string): AutomationStoreData {
  const parsed = JSON.parse(raw) as {
    version?: unknown;
    jobs?: unknown;
    runs?: unknown;
    discoveredWeComGroups?: unknown;
  };
  if (
    parsed.version !== 1 ||
    !Array.isArray(parsed.jobs) ||
    !Array.isArray(parsed.runs)
  ) {
    throw new Error("Automation data has an unsupported format.");
  }
  const jobs = parsed.jobs.map(normalizeJob);
  const runs = parsed.runs.map(normalizeRun);
  const discoveredWeComGroups =
    parsed.discoveredWeComGroups === undefined
      ? []
      : Array.isArray(parsed.discoveredWeComGroups)
        ? parsed.discoveredWeComGroups.map(normalizeDiscoveredWeComGroup)
        : null;
  if (
    jobs.some((entry) => entry === null) ||
    runs.some((entry) => entry === null) ||
    discoveredWeComGroups === null ||
    discoveredWeComGroups.some((entry) => entry === null)
  ) {
    throw new Error("Automation data contains an invalid record.");
  }
  return {
    version: 1,
    jobs: jobs as AutomationJobRecord[],
    runs: (runs as AutomationRunRecord[]).slice(-MAX_STORED_RUNS),
    discoveredWeComGroups: (
      discoveredWeComGroups as DiscoveredWeComGroup[]
    )
      .sort((left, right) => right.lastSeenAt - left.lastSeenAt)
      .slice(0, MAX_DISCOVERED_WECOM_GROUPS),
  };
}

export class AutomationStore {
  private data: AutomationStoreData = clone(EMPTY_STORE);
  private initialized = false;
  private persistQueue: Promise<void> = Promise.resolve();

  constructor(private readonly storePath: string) {}

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    await mkdir(dirname(this.storePath), { recursive: true });
    try {
      this.data = parseStore(await readFile(this.storePath, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        await this.backupCorruptStore().catch(() => undefined);
      }
      this.data = clone(EMPTY_STORE);
    }
    this.initialized = true;
  }

  listDiscoveredWeComGroups(): DiscoveredWeComGroup[] {
    this.assertInitialized();
    return this.data.discoveredWeComGroups
      .map((group) => clone(group))
      .sort(
        (left, right) =>
          right.lastSeenAt - left.lastSeenAt ||
          (left.alias ?? left.chatId).localeCompare(
            right.alias ?? right.chatId,
            "zh-CN",
          ),
      );
  }

  async touchDiscoveredWeComGroup(
    chatId: string,
    now = Date.now(),
  ): Promise<boolean> {
    this.assertInitialized();
    const normalizedChatId = chatId.trim();
    if (
      !normalizedChatId ||
      /\s/u.test(normalizedChatId) ||
      [...normalizedChatId].length > 200 ||
      !Number.isFinite(now)
    ) {
      throw new Error("企业微信群 ID 格式无效。");
    }
    const existing = this.data.discoveredWeComGroups.find(
      (group) => group.chatId === normalizedChatId,
    );
    if (existing) {
      if (
        now <= existing.lastSeenAt ||
        now - existing.lastSeenAt <
          WECOM_GROUP_LAST_SEEN_WRITE_INTERVAL_MILLISECONDS
      ) {
        return false;
      }
      existing.lastSeenAt = now;
      await this.persist();
      return true;
    }
    const group: DiscoveredWeComGroup = {
      chatId: normalizedChatId,
      discoveredAt: now,
      lastSeenAt: now,
    };
    this.data.discoveredWeComGroups.push(group);
    this.data.discoveredWeComGroups = this.data.discoveredWeComGroups
      .sort((left, right) => right.lastSeenAt - left.lastSeenAt)
      .slice(0, MAX_DISCOVERED_WECOM_GROUPS);
    await this.persist();
    return true;
  }

  async updateDiscoveredWeComGroupAlias(
    chatId: string,
    alias: string,
  ): Promise<DiscoveredWeComGroup> {
    this.assertInitialized();
    const group = this.data.discoveredWeComGroups.find(
      (candidate) => candidate.chatId === chatId,
    );
    if (!group) {
      throw new Error("这个企业微信群尚未被客户端发现。");
    }
    const normalizedAlias = alias.trim();
    if (
      [...normalizedAlias].length > 80 ||
      /\p{Cc}/u.test(normalizedAlias)
    ) {
      throw new Error("群名称格式无效。");
    }
    if (normalizedAlias) {
      group.alias = normalizedAlias;
    } else {
      delete group.alias;
    }
    await this.persist();
    return clone(group);
  }

  listJobs(): AutomationJobRecord[] {
    this.assertInitialized();
    return this.data.jobs
      .map((job) => clone(job))
      .sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
  }

  getJob(jobId: string): AutomationJobRecord | undefined {
    this.assertInitialized();
    const job = this.data.jobs.find((candidate) => candidate.id === jobId);
    return job ? clone(job) : undefined;
  }

  async putJob(job: AutomationJobRecord): Promise<void> {
    this.assertInitialized();
    const index = this.data.jobs.findIndex(
      (candidate) => candidate.id === job.id,
    );
    if (index < 0) {
      this.data.jobs.push(clone(job));
    } else {
      this.data.jobs[index] = clone(job);
    }
    await this.persist();
  }

  async removeJob(jobId: string): Promise<void> {
    this.assertInitialized();
    const next = this.data.jobs.filter((candidate) => candidate.id !== jobId);
    if (next.length === this.data.jobs.length) {
      throw new Error("自动化任务不存在或已经删除。");
    }
    this.data.jobs = next;
    await this.persist();
  }

  listRuns(limit = 200): AutomationRunRecord[] {
    this.assertInitialized();
    const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), MAX_STORED_RUNS);
    return this.data.runs
      .slice(-safeLimit)
      .reverse()
      .map((run) => clone(run));
  }

  getRun(runId: string): AutomationRunRecord | undefined {
    this.assertInitialized();
    const run = this.data.runs.find((candidate) => candidate.id === runId);
    return run ? clone(run) : undefined;
  }

  findRunByReportCode(reportCode: string): AutomationRunRecord | undefined {
    this.assertInitialized();
    const normalized = reportCode.toLocaleUpperCase("en-US");
    const run = this.data.runs.find(
      (candidate) => candidate.reportCode === normalized,
    );
    return run ? clone(run) : undefined;
  }

  findRunByTriggerMessageId(messageId: string): AutomationRunRecord | undefined {
    this.assertInitialized();
    const run = this.data.runs.find(
      (candidate) => candidate.triggerMessageId === messageId,
    );
    return run ? clone(run) : undefined;
  }

  hasScheduledRun(jobId: string, scheduledFor: number): boolean {
    this.assertInitialized();
    return this.data.runs.some(
      (run) =>
        run.jobId === jobId &&
        run.trigger === "scheduled" &&
        run.scheduledFor === scheduledFor,
    );
  }

  async addRun(run: AutomationRunRecord): Promise<void> {
    this.assertInitialized();
    if (this.data.runs.some((candidate) => candidate.id === run.id)) {
      throw new Error("自动化执行记录 ID 重复。");
    }
    this.data.runs.push(clone(run));
    if (this.data.runs.length > MAX_STORED_RUNS) {
      this.data.runs = this.data.runs.slice(-MAX_STORED_RUNS);
    }
    await this.persist();
  }

  async replaceRun(run: AutomationRunRecord): Promise<void> {
    this.assertInitialized();
    const index = this.data.runs.findIndex(
      (candidate) => candidate.id === run.id,
    );
    if (index < 0) {
      throw new Error("自动化执行记录不存在。");
    }
    this.data.runs[index] = clone(run);
    await this.persist();
  }

  async recoverInterruptedRuns(now = Date.now()): Promise<boolean> {
    this.assertInitialized();
    let changed = false;
    for (const run of this.data.runs) {
      for (const delivery of run.deliveries) {
        if (delivery.status === "sending") {
          delivery.status = "failed";
          delivery.error = "客户端在投递状态落盘前退出，投递结果未知。";
          changed = true;
        }
      }
      if (run.status !== "queued" && run.status !== "running") {
        continue;
      }
      run.status = "failed";
      run.finishedAt = now;
      run.error = "客户端上次退出时任务尚未结束，执行结果未知，未自动重跑。";
      changed = true;
    }
    if (changed) {
      await this.persist();
    }
    return changed;
  }

  async disableJobsForProject(
    projectId: string,
    now = Date.now(),
  ): Promise<void> {
    this.assertInitialized();
    let changed = false;
    for (const job of this.data.jobs) {
      if (job.projectId === projectId && job.enabled) {
        job.enabled = false;
        job.updatedAt = now;
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
      throw new Error("Automation store has not been initialized.");
    }
  }
}
