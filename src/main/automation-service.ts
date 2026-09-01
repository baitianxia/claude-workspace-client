import { EventEmitter } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import type {
  AutomationDeliveryRecord,
  AutomationJobRecord,
  AutomationRunRecord,
  AutomationRunTrigger,
  AutomationSnapshot,
  DiscoveredWeComGroup,
  ProjectRecord,
  UpdateAutomationWeComGroupAliasRequest,
  UpsertAutomationJobRequest,
} from "../shared/contracts";
import { AutomationStore } from "./automation-store";
import {
  type ClaudeCodeJobInput,
  type ClaudeCodeJobResult,
} from "./claude-code-job-runner";
import { parseCronSchedule } from "./cron-schedule";
import { ScheduledJobService } from "./scheduled-job-service";
import type {
  WeComBusinessMessage,
  WeComBusinessMessageHandler,
  WeComBusinessMessageResult,
} from "./wecom-bridge";

const DELIVERY_RETRY_INTERVAL_MILLISECONDS = 30_000;
const MAX_DELIVERY_ATTEMPTS = 5;
const REPORT_CODE_PATTERN = /\[RPT-([A-F0-9]{10})\]/iu;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

interface AutomationServiceEvents {
  stateChanged: [state: AutomationSnapshot];
}

export interface AutomationRunner {
  initialize?(): Promise<void>;
  run(input: ClaudeCodeJobInput): Promise<ClaudeCodeJobResult>;
  cancel(runId: string): boolean;
  dispose(): void;
}

export interface AutomationWeComGateway {
  setBusinessMessageHandler(handler: WeComBusinessMessageHandler | null): void;
  sendMarkdown(targetId: string, content: string): Promise<void>;
  getState(): { status: string };
  on(event: "stateChanged", listener: () => void): unknown;
  off(event: "stateChanged", listener: () => void): unknown;
}

interface RunContext {
  scheduledFor?: number;
  triggerMessageId?: string;
  sourceRunId?: string;
  requestedBy?: string;
  requestText?: string;
  quoteText?: string;
  deliveryTargetIds?: string[];
  prompt?: string;
}

function readableError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requireText(
  value: unknown,
  label: string,
  maximum: number,
  allowMultiline = false,
): string {
  if (typeof value !== "string") {
    throw new Error(`${label}必须是字符串。`);
  }
  const normalized = value.trim();
  if (
    !normalized ||
    [...normalized].length > maximum ||
    (allowMultiline
      ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(
          normalized,
        )
      : /\p{Cc}/u.test(normalized))
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

function requireStringList(
  value: unknown,
  label: string,
  options: {
    maximumItems: number;
    maximumLength: number;
    validate?: (entry: string) => boolean;
    allowEmpty?: boolean;
  },
): string[] {
  if (!Array.isArray(value) || value.length > options.maximumItems) {
    throw new Error(`${label}列表格式无效。`);
  }
  const result: string[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (typeof raw !== "string") {
      throw new Error(`${label}列表包含非字符串值。`);
    }
    const entry = raw.trim();
    if (
      !entry ||
      [...entry].length > options.maximumLength ||
      /\p{Cc}/u.test(entry) ||
      (options.validate && !options.validate(entry))
    ) {
      throw new Error(`${label}“${entry || "空值"}”格式无效。`);
    }
    const key = entry.toLocaleLowerCase("en-US");
    if (!seen.has(key)) {
      seen.add(key);
      result.push(entry);
    }
  }
  if (!options.allowEmpty && result.length === 0) {
    throw new Error(`${label}至少需要一项。`);
  }
  return result;
}

function validMcpServerName(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(value);
}

function validWeComIdentifier(value: string): boolean {
  return value === "*" || (!/\s/u.test(value) && [...value].length <= 200);
}

function validateMcpConfigPath(value: unknown): string {
  const path = requireText(value, "MCP 配置路径", 500);
  if (
    isAbsolute(path) ||
    path.split(/[\\/]+/u).some((segment) => segment === "..") ||
    !path.toLocaleLowerCase("en-US").endsWith(".json")
  ) {
    throw new Error("MCP 配置必须是工程内的相对 JSON 路径。");
  }
  return path;
}

function deliveryRecords(targetIds: string[]): AutomationDeliveryRecord[] {
  return targetIds.map((targetId) => ({
    targetId,
    status: "pending",
    attempts: 0,
  }));
}

function isRunningStatus(status: AutomationRunRecord["status"]): boolean {
  return status === "queued" || status === "running";
}

function formatReportMessage(run: AutomationRunRecord): string {
  const body =
    run.result?.wecomMarkdown.trim() ||
    run.result?.summary.trim() ||
    "任务已完成。";
  const time = new Date(run.finishedAt ?? Date.now()).toLocaleString("zh-CN", {
    hour12: false,
  });
  return [
    `# ${run.jobName}`,
    `> [RPT-${run.reportCode}] · ${time}`,
    "",
    body,
  ].join("\n");
}

function followUpPrompt(
  job: AutomationJobRecord,
  message: WeComBusinessMessage,
  sourceRun?: AutomationRunRecord,
): string {
  const previous = sourceRun?.result
    ? [
        `上一份报告编号：[RPT-${sourceRun.reportCode}]`,
        `上一份报告摘要：${sourceRun.result.summary.slice(0, 12_000)}`,
        `上一份群消息：${sourceRun.result.wecomMarkdown.slice(0, 12_000)}`,
      ].join("\n")
    : "没有明确引用上一份报告；请根据本任务的业务范围处理请求。";
  return [
    job.prompt,
    "",
    "这是企业微信群中的后续请求，不是一次常规定时广播。",
    "只回答当前群聊问题；除非用户明确要求，否则不要发送邮件。",
    "如果用户明确要求邮件操作，也只能使用任务配置中的固定收件人和本次幂等键。",
    "本次结果应返回给发起请求的群，不要面向任务的其他群生成广播措辞。",
    "",
    previous,
    `引用内容：${message.quoteText || "（无）"}`,
    `请求用户：${message.userId}`,
    `用户请求：${message.text}`,
  ].join("\n");
}

export class AutomationService extends EventEmitter<AutomationServiceEvents> {
  private readonly runningJobs = new Map<string, string>();
  private readonly scheduler: ScheduledJobService;
  private deliveryTimer: NodeJS.Timeout | null = null;
  private flushingDeliveries = false;
  private deliveryFlushRequested = false;
  private initialized = false;
  private readonly backgroundTasks = new Set<Promise<void>>();
  private readonly cancelRequestedRuns = new Set<string>();
  private disposePromise: Promise<void> | null = null;
  private shuttingDown = false;

  constructor(
    private readonly store: AutomationStore,
    private readonly runner: AutomationRunner,
    private readonly getProject: (
      projectId: string,
    ) => ProjectRecord | undefined,
    private readonly wecomBridge: AutomationWeComGateway,
    private readonly now: () => number = Date.now,
  ) {
    super();
    this.scheduler = new ScheduledJobService(
      () => this.store.listJobs(),
      (job, scheduledFor) => this.handleScheduledJob(job, scheduledFor),
      () => this.emitStateChanged(),
      this.now,
    );
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    await this.runner.initialize?.();
    await this.store.initialize();
    await this.store.recoverInterruptedRuns(this.now());
    this.initialized = true;
    this.wecomBridge.setBusinessMessageHandler(this.handleWeComMessage);
    this.wecomBridge.on("stateChanged", this.handleWeComStateChanged);
    this.scheduler.start();
    this.deliveryTimer = setInterval(
      () =>
        this.runInBackground(
          this.flushPendingDeliveries(),
          "retrying pending WeCom deliveries",
        ),
      DELIVERY_RETRY_INTERVAL_MILLISECONDS,
    );
    this.deliveryTimer.unref();
    this.runInBackground(
      this.flushPendingDeliveries(),
      "flushing pending WeCom deliveries during startup",
    );
  }

  getSnapshot(): AutomationSnapshot {
    return {
      jobs: this.store.listJobs(),
      runs: this.store.listRuns(),
      discoveredWeComGroups: this.store.listDiscoveredWeComGroups(),
      runningJobIds: [...this.runningJobs.keys()],
      schedulerActive: this.scheduler.isActive(),
      ...(this.scheduler.getLastCheckedAt() === undefined
        ? {}
        : { lastSchedulerCheckAt: this.scheduler.getLastCheckedAt() }),
    };
  }

  hasRunningRuns(): boolean {
    return this.runningJobs.size > 0;
  }

  async upsertJob(
    request: UpsertAutomationJobRequest,
  ): Promise<AutomationJobRecord> {
    if (!request || typeof request !== "object") {
      throw new Error("自动化任务请求无效。");
    }
    if (typeof request.enabled !== "boolean") {
      throw new Error("自动化任务启用状态无效。");
    }
    const id =
      request.id === undefined
        ? randomUUID()
        : requireText(request.id, "任务 ID", 200);
    const existing = this.store.getJob(id);
    if (request.id !== undefined && !existing) {
      throw new Error("自动化任务不存在或已经删除。");
    }
    const projectId = requireText(request.projectId, "工程 ID", 200);
    if (!this.getProject(projectId)) {
      throw new Error("自动化任务关联的工程不存在。");
    }
    const name = requireText(request.name, "任务名称", 80);
    const duplicate = this.store.listJobs().find(
      (job) =>
        job.id !== id &&
        job.name.toLocaleLowerCase("zh-CN") === name.toLocaleLowerCase("zh-CN"),
    );
    if (duplicate) {
      throw new Error("已经存在同名自动化任务。");
    }
    const schedule = parseCronSchedule(
      requireText(request.schedule, "定时表达式", 100),
    ).expression;
    const now = this.now();
    const job: AutomationJobRecord = {
      id,
      name,
      enabled: request.enabled,
      projectId,
      schedule,
      mcpConfigPath: validateMcpConfigPath(request.mcpConfigPath),
      allowedMcpServers: requireStringList(
        request.allowedMcpServers,
        "允许的 MCP 服务器",
        {
          maximumItems: 30,
          maximumLength: 64,
          validate: validMcpServerName,
        },
      ),
      prompt: requireText(request.prompt, "任务提示词", 50_000, true),
      emailRecipients: requireStringList(
        request.emailRecipients,
        "邮件收件人",
        {
          maximumItems: 100,
          maximumLength: 320,
          validate: (value) => EMAIL_PATTERN.test(value),
          allowEmpty: true,
        },
      ),
      wecomTargetIds: requireStringList(
        request.wecomTargetIds,
        "企业微信投递目标",
        {
          maximumItems: 100,
          maximumLength: 200,
          validate: (value) => value !== "*" && validWeComIdentifier(value),
          allowEmpty: true,
        },
      ),
      allowedWecomUserIds: requireStringList(
        request.allowedWecomUserIds,
        "企业微信交互用户",
        {
          maximumItems: 200,
          maximumLength: 200,
          validate: validWeComIdentifier,
          allowEmpty: true,
        },
      ),
      timeoutMinutes: requireInteger(
        request.timeoutMinutes,
        "任务超时分钟数",
        1,
        120,
      ),
      maxTurns: requireInteger(request.maxTurns, "最大 Agent 轮数", 1, 100),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    await this.store.putJob(job);
    this.emitStateChanged();
    return job;
  }

  async updateWeComGroupAlias(
    request: UpdateAutomationWeComGroupAliasRequest,
  ): Promise<DiscoveredWeComGroup> {
    if (!request || typeof request !== "object") {
      throw new Error("企业微信群名称请求无效。");
    }
    const chatId = requireText(request.chatId, "企业微信群 ID", 200);
    if (chatId === "*" || !validWeComIdentifier(chatId)) {
      throw new Error("企业微信群 ID 格式无效。");
    }
    if (typeof request.alias !== "string") {
      throw new Error("群名称必须是字符串。");
    }
    const alias = request.alias.trim();
    if ([...alias].length > 80 || /\p{Cc}/u.test(alias)) {
      throw new Error("群名称格式无效。");
    }
    const group = await this.store.updateDiscoveredWeComGroupAlias(
      chatId,
      alias,
    );
    this.emitStateChanged();
    return group;
  }

  async deleteJob(jobId: string): Promise<void> {
    const id = requireText(jobId, "任务 ID", 200);
    if (this.runningJobs.has(id)) {
      throw new Error("任务正在运行，请先取消本次执行再删除。");
    }
    await this.store.removeJob(id);
    this.emitStateChanged();
  }

  async disableJobsForProject(projectId: string): Promise<void> {
    await this.store.disableJobsForProject(projectId, this.now());
    this.emitStateChanged();
  }

  async runJob(jobId: string): Promise<AutomationRunRecord> {
    const job = this.requireJob(jobId);
    if (this.runningJobs.has(job.id)) {
      throw new Error("这个自动化任务已有一次执行正在运行。");
    }
    return this.enqueue(job, "manual");
  }

  async retryRun(runId: string): Promise<AutomationRunRecord> {
    if (this.shuttingDown) {
      throw new Error("自动化服务正在关闭。");
    }
    const run = this.store.getRun(requireText(runId, "执行记录 ID", 200));
    if (!run) {
      throw new Error("自动化执行记录不存在。");
    }
    if (
      run.status !== "failed" &&
      run.status !== "timed-out" &&
      run.status !== "cancelled"
    ) {
      throw new Error("只有失败、超时或取消的执行可以重试。");
    }
    if (run.deliveries.some((delivery) => delivery.status === "sent")) {
      throw new Error("这次执行已经产生企业微信投递，不能重新运行 Agent。");
    }
    const job = this.requireJob(run.jobId);
    if (this.runningJobs.has(job.id)) {
      throw new Error("这个自动化任务已有一次执行正在运行。");
    }
    run.status = "queued";
    run.attempt += 1;
    delete run.startedAt;
    delete run.finishedAt;
    delete run.sessionId;
    delete run.exitCode;
    delete run.result;
    delete run.error;
    delete run.diagnostic;
    run.deliveries = run.deliveries.map((delivery) => ({
      targetId: delivery.targetId,
      status: "pending",
      attempts: 0,
    }));
    this.runningJobs.set(job.id, run.id);
    try {
      await this.store.replaceRun(run);
    } catch (error) {
      if (this.runningJobs.get(job.id) === run.id) {
        this.runningJobs.delete(job.id);
      }
      throw error;
    }
    this.emitStateChanged();
    this.runInBackground(
      this.execute(job, run, this.promptForRun(job, run)),
      `retrying automation run ${run.id}`,
    );
    return run;
  }

  async cancelRun(runId: string): Promise<void> {
    const run = this.store.getRun(requireText(runId, "执行记录 ID", 200));
    if (!run || !isRunningStatus(run.status)) {
      throw new Error("自动化执行不在可取消状态。");
    }
    if (this.runner.cancel(run.id)) {
      return;
    }
    if (this.runningJobs.get(run.jobId) === run.id) {
      this.cancelRequestedRuns.add(run.id);
      return;
    }
    throw new Error("后台 Claude Code 进程尚未启动或已经结束。");
  }

  dispose(): Promise<void> {
    if (this.disposePromise) {
      return this.disposePromise;
    }
    this.disposePromise = this.disposeInternal();
    return this.disposePromise;
  }

  private async disposeInternal(): Promise<void> {
    this.shuttingDown = true;
    for (const runId of this.runningJobs.values()) {
      this.cancelRequestedRuns.add(runId);
    }
    this.scheduler.stop();
    if (this.deliveryTimer) {
      clearInterval(this.deliveryTimer);
      this.deliveryTimer = null;
    }
    this.wecomBridge.off("stateChanged", this.handleWeComStateChanged);
    this.wecomBridge.setBusinessMessageHandler(null);
    await this.scheduler.settle();
    this.runner.dispose();
    while (this.backgroundTasks.size > 0) {
      await Promise.allSettled([...this.backgroundTasks]);
    }
  }

  private requireJob(jobId: string): AutomationJobRecord {
    const job = this.store.getJob(requireText(jobId, "任务 ID", 200));
    if (!job) {
      throw new Error("自动化任务不存在或已经删除。");
    }
    if (!this.getProject(job.projectId)) {
      throw new Error("自动化任务关联的工程已经被移除。");
    }
    return job;
  }

  private async handleScheduledJob(
    job: AutomationJobRecord,
    scheduledFor: number,
  ): Promise<void> {
    if (this.shuttingDown) {
      return;
    }
    if (this.store.hasScheduledRun(job.id, scheduledFor)) {
      return;
    }
    if (this.runningJobs.has(job.id)) {
      await this.addSkippedRun(
        job,
        scheduledFor,
        "上一次执行尚未结束，本次计划触发已跳过。",
      );
      return;
    }
    await this.enqueue(job, "scheduled", { scheduledFor });
  }

  private async addSkippedRun(
    job: AutomationJobRecord,
    scheduledFor: number,
    error: string,
  ): Promise<void> {
    const now = this.now();
    const run: AutomationRunRecord = {
      id: randomUUID(),
      reportCode: this.nextReportCode(),
      jobId: job.id,
      jobName: job.name,
      trigger: "scheduled",
      status: "skipped",
      attempt: 0,
      createdAt: now,
      finishedAt: now,
      scheduledFor,
      error,
      deliveries: [],
    };
    await this.store.addRun(run);
    this.emitStateChanged();
  }

  private async enqueue(
    job: AutomationJobRecord,
    trigger: AutomationRunTrigger,
    context: RunContext = {},
  ): Promise<AutomationRunRecord> {
    if (this.shuttingDown) {
      throw new Error("自动化服务正在关闭。");
    }
    if (this.runningJobs.has(job.id)) {
      throw new Error("这个自动化任务已有一次执行正在运行。");
    }
    const run: AutomationRunRecord = {
      id: randomUUID(),
      reportCode: this.nextReportCode(),
      jobId: job.id,
      jobName: job.name,
      trigger,
      status: "queued",
      attempt: 1,
      createdAt: this.now(),
      ...(context.scheduledFor === undefined
        ? {}
        : { scheduledFor: context.scheduledFor }),
      ...(context.triggerMessageId
        ? { triggerMessageId: context.triggerMessageId }
        : {}),
      ...(context.sourceRunId ? { sourceRunId: context.sourceRunId } : {}),
      ...(context.requestedBy ? { requestedBy: context.requestedBy } : {}),
      ...(context.requestText ? { requestText: context.requestText } : {}),
      ...(context.quoteText ? { quoteText: context.quoteText } : {}),
      deliveries: deliveryRecords(
        context.deliveryTargetIds ?? job.wecomTargetIds,
      ),
    };
    this.runningJobs.set(job.id, run.id);
    try {
      await this.store.addRun(run);
    } catch (error) {
      if (this.runningJobs.get(job.id) === run.id) {
        this.runningJobs.delete(job.id);
      }
      throw error;
    }
    this.emitStateChanged();
    this.runInBackground(
      this.execute(job, run, context.prompt ?? job.prompt),
      `executing automation run ${run.id}`,
    );
    return run;
  }

  private async execute(
    job: AutomationJobRecord,
    initialRun: AutomationRunRecord,
    prompt: string,
  ): Promise<void> {
    let run = this.store.getRun(initialRun.id) ?? initialRun;
    run.status = "running";
    run.startedAt = this.now();
    await this.store.replaceRun(run);
    this.emitStateChanged();

    let result: ClaudeCodeJobResult;
    if (this.cancelRequestedRuns.delete(run.id)) {
      result = {
        status: "cancelled",
        error: "后台任务在启动前已取消。",
      };
    } else {
      try {
        const project = this.getProject(job.projectId);
        if (!project) {
          throw new Error("自动化任务关联的工程已经被移除。");
        }
        result = await this.runner.run({
          runId: run.id,
          job,
          projectRoot: project.rootPath,
          prompt,
        });
      } catch (error) {
        result = {
          status: "failed",
          error: readableError(error),
        };
      }
    }

    run = this.store.getRun(run.id) ?? run;
    run.status = result.status;
    run.finishedAt = this.now();
    if (result.exitCode !== undefined) {
      run.exitCode = result.exitCode;
    }
    if (result.sessionId) {
      run.sessionId = result.sessionId;
    }
    if (result.output) {
      run.result = result.output;
    }
    if (result.error) {
      run.error = result.error;
    }
    if (result.diagnostic) {
      run.diagnostic = result.diagnostic;
    }
    if (
      result.status === "succeeded" &&
      result.output?.outcome === "no-change" &&
      run.trigger !== "wecom"
    ) {
      run.deliveries = run.deliveries.map((delivery) => ({
        ...delivery,
        status: "skipped",
      }));
    }
    if (result.status !== "succeeded") {
      run.deliveries = run.deliveries.map((delivery) => ({
        ...delivery,
        status: "skipped",
      }));
    }
    await this.store.replaceRun(run);
    if (this.runningJobs.get(job.id) === run.id) {
      this.runningJobs.delete(job.id);
    }
    this.cancelRequestedRuns.delete(run.id);
    this.emitStateChanged();
    if (result.status === "succeeded") {
      await this.flushPendingDeliveries();
    }
  }

  private promptForRun(
    job: AutomationJobRecord,
    run: AutomationRunRecord,
  ): string {
    if (run.trigger !== "wecom") {
      return job.prompt;
    }
    const source = run.sourceRunId
      ? this.store.getRun(run.sourceRunId)
      : undefined;
    return followUpPrompt(
      job,
      {
        messageId: run.triggerMessageId ?? "retry",
        chatId: run.deliveries[0]?.targetId ?? "unknown",
        userId: run.requestedBy ?? "unknown",
        text: run.requestText ?? "",
        quoteText: run.quoteText ?? "",
      },
      source,
    );
  }

  private readonly handleWeComMessage = async (
    message: WeComBusinessMessage,
  ): Promise<WeComBusinessMessageResult> => {
    if (
      await this.store.touchDiscoveredWeComGroup(message.chatId, this.now())
    ) {
      this.emitStateChanged();
    }
    if (/(?:^|\s)\/chatid(?:\s|$)/iu.test(message.text)) {
      return {
        status: "accepted",
        message: `本群 chatid：\`${message.chatId}\`。客户端已自动记录，可在自动化任务中直接选择。`,
      };
    }
    const duplicate = this.store.findRunByTriggerMessageId(message.messageId);
    if (duplicate) {
      return {
        status: "accepted",
        message: `这条请求已经登记为 [RPT-${duplicate.reportCode}]，当前状态：${duplicate.status}。`,
      };
    }

    const sourceCode = REPORT_CODE_PATTERN.exec(
      `${message.quoteText}\n${message.text}`,
    )?.[1]?.toLocaleUpperCase("en-US");
    const sourceRun = sourceCode
      ? this.store.findRunByReportCode(sourceCode)
      : undefined;
    if (sourceCode && !sourceRun) {
      return {
        status: "rejected",
        message: "引用的报告不存在或已超出本机保留的运行历史。",
      };
    }
    const eligibleJobs = this.store
      .listJobs()
      .filter(
        (job) =>
          job.enabled &&
          job.wecomTargetIds.includes(message.chatId) &&
          (job.allowedWecomUserIds.includes("*") ||
            job.allowedWecomUserIds.includes(message.userId)),
      );
    let job: AutomationJobRecord | undefined;
    if (sourceRun) {
      if (
        !sourceRun.deliveries.some(
          (delivery) => delivery.targetId === message.chatId,
        )
      ) {
        return {
          status: "rejected",
          message: "引用的报告未投递到本群，不能在这里继续处理。",
        };
      }
      job = eligibleJobs.find((candidate) => candidate.id === sourceRun.jobId);
      if (!job) {
        return {
          status: "rejected",
          message: "引用的报告不属于本群可用任务，或当前用户没有执行权限。",
        };
      }
    } else {
      const command = /\/run\s+([^\r\n]+)/iu.exec(message.text)?.[1]?.trim();
      if (command) {
        const normalized = command.toLocaleLowerCase("zh-CN");
        const matches = eligibleJobs.filter(
          (candidate) =>
            candidate.id.toLocaleLowerCase("en-US").startsWith(normalized) ||
            candidate.name.toLocaleLowerCase("zh-CN") === normalized,
        );
        if (matches.length === 1) {
          job = matches[0];
        }
      } else if (eligibleJobs.length === 1) {
        job = eligibleJobs[0];
      }
    }
    if (!job) {
      return {
        status: "rejected",
        message:
          eligibleJobs.length === 0
            ? "本群没有允许当前用户调用的自动化任务。"
            : "无法唯一确定任务。请引用带 [RPT-…] 的报告，或发送 /run 任务名称。",
      };
    }
    if (this.runningJobs.has(job.id)) {
      return {
        status: "rejected",
        message: `任务“${job.name}”正在运行，请等待当前执行结束。`,
      };
    }
    const run = await this.enqueue(job, "wecom", {
      triggerMessageId: message.messageId,
      ...(sourceRun ? { sourceRunId: sourceRun.id } : {}),
      requestedBy: message.userId,
      requestText: message.text.slice(0, 10_000),
      quoteText: message.quoteText.slice(0, 10_000),
      deliveryTargetIds: [message.chatId],
      prompt: followUpPrompt(job, message, sourceRun),
    });
    return {
      status: "accepted",
      message: `已登记 [RPT-${run.reportCode}]，Claude Code 将在后台调用该任务允许的 MCP 处理。`,
    };
  };

  private readonly handleWeComStateChanged = () => {
    if (this.wecomBridge.getState().status === "connected") {
      this.runInBackground(
        this.flushPendingDeliveries(),
        "flushing pending WeCom deliveries after reconnect",
      );
    }
  };

  private async flushPendingDeliveries(): Promise<void> {
    if (this.flushingDeliveries) {
      this.deliveryFlushRequested = true;
      return;
    }
    this.flushingDeliveries = true;
    try {
      do {
        this.deliveryFlushRequested = false;
        const now = this.now();
        for (const summary of this.store.listRuns(500).reverse()) {
          if (summary.status !== "succeeded" || !summary.result) {
            continue;
          }
          let run = this.store.getRun(summary.id) ?? summary;
          for (let index = 0; index < run.deliveries.length; index += 1) {
            const delivery = run.deliveries[index];
            if (
              (delivery.status !== "pending" && delivery.status !== "failed") ||
              delivery.attempts >= MAX_DELIVERY_ATTEMPTS ||
              (delivery.nextAttemptAt !== undefined &&
                delivery.nextAttemptAt > now)
            ) {
              continue;
            }
            delivery.status = "sending";
            delete delivery.error;
            delete delivery.nextAttemptAt;
            await this.store.replaceRun(run);
            this.emitStateChanged();
            try {
              await this.wecomBridge.sendMarkdown(
                delivery.targetId,
                formatReportMessage(run),
              );
              delivery.status = "sent";
              delivery.attempts += 1;
              delivery.sentAt = this.now();
            } catch (error) {
              delivery.status = "failed";
              delivery.attempts += 1;
              delivery.error = readableError(error).slice(0, 2_000);
              delivery.nextAttemptAt =
                this.now() +
                Math.min(
                  15 * 60_000,
                  DELIVERY_RETRY_INTERVAL_MILLISECONDS *
                    2 ** Math.max(0, delivery.attempts - 1),
                );
            }
            await this.store.replaceRun(run);
            this.emitStateChanged();
            run = this.store.getRun(run.id) ?? run;
          }
        }
      } while (this.deliveryFlushRequested);
    } finally {
      this.flushingDeliveries = false;
    }
  }

  private nextReportCode(): string {
    for (;;) {
      const code = randomBytes(5).toString("hex").toLocaleUpperCase("en-US");
      if (!this.store.findRunByReportCode(code)) {
        return code;
      }
    }
  }

  private runInBackground(task: Promise<void>, description: string): void {
    let tracked: Promise<void>;
    tracked = task
      .catch((error: unknown) => {
        console.error(`Automation service failed while ${description}`, error);
      })
      .finally(() => {
        this.backgroundTasks.delete(tracked);
      });
    this.backgroundTasks.add(tracked);
  }

  private emitStateChanged(): void {
    if (this.initialized) {
      this.emit("stateChanged", this.getSnapshot());
    }
  }
}
