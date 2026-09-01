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
  AssistantTaskRecord,
  AssistantTaskRunRecord,
  AssistantTaskRunStatus,
  AssistantTaskRunTrigger,
} from "../shared/contracts";
import { parseCronSchedule } from "./cron-schedule";

interface AssistantTaskStoreData {
  version: 1;
  tasks: AssistantTaskRecord[];
  runs: AssistantTaskRunRecord[];
}

const EMPTY_STORE: AssistantTaskStoreData = {
  version: 1,
  tasks: [],
  runs: [],
};

const MAX_TASKS = 200;
const MAX_STORED_RUNS = 500;
const MAX_STORE_BYTES = 128 * 1024 * 1024;
const RUN_STATUSES = new Set<AssistantTaskRunStatus>([
  "queued",
  "running",
  "succeeded",
  "failed",
  "timed-out",
  "cancelled",
  "skipped",
]);
const RUN_TRIGGERS = new Set<AssistantTaskRunTrigger>([
  "scheduled",
  "manual",
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

function validIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Boolean(value) &&
    [...value].length <= 200 &&
    !/\p{Cc}|\s/u.test(value)
  );
}

function validText(value: unknown, maximum: number, allowEmpty = false): value is string {
  return (
    typeof value === "string" &&
    (allowEmpty || Boolean(value.trim())) &&
    [...value].length <= maximum &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value)
  );
}

function normalizeTask(value: unknown): AssistantTaskRecord | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as Partial<AssistantTaskRecord>;
  let schedule: string;
  try {
    schedule = parseCronSchedule(candidate.schedule as string).expression;
  } catch {
    return null;
  }
  if (
    !validIdentifier(candidate.id) ||
    !validIdentifier(candidate.assistantId) ||
    !validText(candidate.name, 80) ||
    typeof candidate.enabled !== "boolean" ||
    !validText(candidate.prompt, 20_000) ||
    !Number.isInteger(candidate.timeoutMinutes) ||
    (candidate.timeoutMinutes ?? 0) < 1 ||
    (candidate.timeoutMinutes ?? 0) > 120 ||
    !Number.isInteger(candidate.maxTurns) ||
    (candidate.maxTurns ?? 0) < 1 ||
    (candidate.maxTurns ?? 0) > 100 ||
    typeof candidate.createdAt !== "number" ||
    !Number.isFinite(candidate.createdAt) ||
    typeof candidate.updatedAt !== "number" ||
    !Number.isFinite(candidate.updatedAt)
  ) {
    return null;
  }
  return {
    id: candidate.id,
    assistantId: candidate.assistantId,
    name: candidate.name.trim(),
    enabled: candidate.enabled,
    schedule,
    prompt: candidate.prompt.trim(),
    timeoutMinutes: candidate.timeoutMinutes as number,
    maxTurns: candidate.maxTurns as number,
    createdAt: candidate.createdAt,
    updatedAt: candidate.updatedAt,
  };
}

function normalizeRun(value: unknown): AssistantTaskRunRecord | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as Partial<AssistantTaskRunRecord>;
  if (
    !validIdentifier(candidate.id) ||
    !validIdentifier(candidate.taskId) ||
    !validIdentifier(candidate.assistantId) ||
    !validText(candidate.taskName, 80) ||
    typeof candidate.trigger !== "string" ||
    !RUN_TRIGGERS.has(candidate.trigger as AssistantTaskRunTrigger) ||
    typeof candidate.status !== "string" ||
    !RUN_STATUSES.has(candidate.status as AssistantTaskRunStatus) ||
    typeof candidate.createdAt !== "number" ||
    !Number.isFinite(candidate.createdAt) ||
    !optionalNumber(candidate.startedAt) ||
    !optionalNumber(candidate.finishedAt) ||
    !optionalNumber(candidate.scheduledFor) ||
    !optionalString(candidate.response) ||
    !optionalString(candidate.error) ||
    !optionalString(candidate.deliveryError) ||
    (candidate.response !== undefined && !validText(candidate.response, 50_000, true)) ||
    (candidate.error !== undefined && !validText(candidate.error, 10_000, true)) ||
    (candidate.deliveryError !== undefined &&
      !validText(candidate.deliveryError, 10_000, true))
  ) {
    return null;
  }
  return clone(candidate as AssistantTaskRunRecord);
}

function parseStore(raw: string): AssistantTaskStoreData {
  const parsed = JSON.parse(raw) as {
    version?: unknown;
    tasks?: unknown;
    runs?: unknown;
  };
  if (
    parsed.version !== 1 ||
    !Array.isArray(parsed.tasks) ||
    !Array.isArray(parsed.runs)
  ) {
    throw new Error("Assistant task data has an unsupported format.");
  }
  const tasks = parsed.tasks.map(normalizeTask);
  const runs = parsed.runs.map(normalizeRun);
  if (
    tasks.some((entry) => entry === null) ||
    runs.some((entry) => entry === null) ||
    tasks.length > MAX_TASKS ||
    new Set((tasks as AssistantTaskRecord[]).map((entry) => entry.id)).size !==
      tasks.length ||
    new Set((runs as AssistantTaskRunRecord[]).map((entry) => entry.id)).size !==
      runs.length
  ) {
    throw new Error("Assistant task data contains invalid records.");
  }
  return {
    version: 1,
    tasks: tasks as AssistantTaskRecord[],
    runs: (runs as AssistantTaskRunRecord[]).slice(-MAX_STORED_RUNS),
  };
}

export class AssistantTaskStore {
  private data: AssistantTaskStoreData = clone(EMPTY_STORE);
  private initialized = false;
  private persistQueue: Promise<void> = Promise.resolve();

  constructor(private readonly storePath: string) {}

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    await mkdir(dirname(this.storePath), { recursive: true });
    try {
      const storeStat = await stat(this.storePath);
      if (!storeStat.isFile() || storeStat.size > MAX_STORE_BYTES) {
        throw new Error("Assistant task data file is not a regular file or is too large.");
      }
      this.data = parseStore(await readFile(this.storePath, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        await this.backupCorruptStore().catch(() => undefined);
      }
      this.data = clone(EMPTY_STORE);
    }
    this.initialized = true;
  }

  listTasks(assistantId?: string): AssistantTaskRecord[] {
    this.assertInitialized();
    return this.data.tasks
      .filter((task) => assistantId === undefined || task.assistantId === assistantId)
      .map((task) => clone(task))
      .sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
  }

  getTask(taskId: string): AssistantTaskRecord | undefined {
    this.assertInitialized();
    const task = this.data.tasks.find((candidate) => candidate.id === taskId);
    return task ? clone(task) : undefined;
  }

  async putTask(task: AssistantTaskRecord): Promise<void> {
    this.assertInitialized();
    const normalized = normalizeTask(task);
    if (!normalized) {
      throw new Error("定时任务格式无效。");
    }
    const index = this.data.tasks.findIndex(
      (candidate) => candidate.id === normalized.id,
    );
    if (index < 0) {
      if (this.data.tasks.length >= MAX_TASKS) {
        throw new Error(`定时任务最多可以保存 ${MAX_TASKS} 个。`);
      }
      this.data.tasks.push(normalized);
    } else {
      const existing = this.data.tasks[index];
      if (existing.assistantId !== normalized.assistantId) {
        throw new Error("定时任务不能转移到其他助理。");
      }
      this.data.tasks[index] = normalized;
    }
    await this.persist();
  }

  async removeTask(taskId: string): Promise<void> {
    this.assertInitialized();
    const next = this.data.tasks.filter((candidate) => candidate.id !== taskId);
    if (next.length === this.data.tasks.length) {
      throw new Error("定时任务不存在或已经删除。");
    }
    this.data.tasks = next;
    this.data.runs = this.data.runs.filter((run) => run.taskId !== taskId);
    await this.persist();
  }

  listRuns(options: { assistantId?: string; taskId?: string; limit?: number } = {}): AssistantTaskRunRecord[] {
    this.assertInitialized();
    const limit = Math.max(0, Math.min(options.limit ?? MAX_STORED_RUNS, MAX_STORED_RUNS));
    if (limit === 0) {
      return [];
    }
    return this.data.runs
      .filter(
        (run) =>
          (options.assistantId === undefined || run.assistantId === options.assistantId) &&
          (options.taskId === undefined || run.taskId === options.taskId),
      )
      .slice(-limit)
      .map((run) => clone(run));
  }

  getRun(runId: string): AssistantTaskRunRecord | undefined {
    this.assertInitialized();
    const run = this.data.runs.find((candidate) => candidate.id === runId);
    return run ? clone(run) : undefined;
  }

  async appendRun(run: AssistantTaskRunRecord): Promise<void> {
    this.assertInitialized();
    const normalized = normalizeRun(run);
    if (!normalized) {
      throw new Error("定时任务运行记录格式无效。");
    }
    if (!this.data.tasks.some((task) => task.id === normalized.taskId)) {
      throw new Error("定时任务运行关联的任务不存在。");
    }
    if (this.data.runs.some((candidate) => candidate.id === normalized.id)) {
      throw new Error("同一定时任务运行已经存在。");
    }
    this.data.runs = [...this.data.runs, normalized].slice(-MAX_STORED_RUNS);
    await this.persist();
  }

  async replaceRun(run: AssistantTaskRunRecord): Promise<void> {
    this.assertInitialized();
    const normalized = normalizeRun(run);
    if (!normalized) {
      throw new Error("定时任务运行记录格式无效。");
    }
    const index = this.data.runs.findIndex((candidate) => candidate.id === run.id);
    if (index < 0) {
      throw new Error("定时任务运行记录不存在或已经清理。");
    }
    const existing = this.data.runs[index];
    if (
      existing.taskId !== normalized.taskId ||
      existing.assistantId !== normalized.assistantId ||
      existing.taskName !== normalized.taskName ||
      existing.trigger !== normalized.trigger ||
      existing.createdAt !== normalized.createdAt ||
      existing.scheduledFor !== normalized.scheduledFor
    ) {
      throw new Error("定时任务运行的身份和触发信息不可修改。");
    }
    this.data.runs[index] = normalized;
    await this.persist();
  }

  hasAssistantData(assistantId: string): boolean {
    this.assertInitialized();
    return (
      this.data.tasks.some((task) => task.assistantId === assistantId) ||
      this.data.runs.some((run) => run.assistantId === assistantId)
    );
  }

  async removeAssistant(assistantId: string): Promise<void> {
    this.assertInitialized();
    this.data.tasks = this.data.tasks.filter(
      (task) => task.assistantId !== assistantId,
    );
    this.data.runs = this.data.runs.filter(
      (run) => run.assistantId !== assistantId,
    );
    await this.persist();
  }

  async disableTasksForAssistant(assistantId: string, now = Date.now()): Promise<void> {
    this.assertInitialized();
    let changed = false;
    for (const task of this.data.tasks) {
      if (task.assistantId === assistantId && task.enabled) {
        task.enabled = false;
        task.updatedAt = now;
        changed = true;
      }
    }
    if (changed) {
      await this.persist();
    }
  }

  async recoverInterruptedRuns(now = Date.now()): Promise<number> {
    this.assertInitialized();
    let recovered = 0;
    for (const run of this.data.runs) {
      if (run.status !== "queued" && run.status !== "running") {
        continue;
      }
      run.status = "failed";
      run.finishedAt = now;
      run.error = "客户端上次退出时任务尚未完成，结果未知；为避免重复副作用，本次不会自动重跑。";
      recovered += 1;
    }
    if (recovered > 0) {
      await this.persist();
    }
    return recovered;
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
      throw new Error("Assistant task store has not been initialized.");
    }
  }
}
