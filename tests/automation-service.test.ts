import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AutomationService,
  type AutomationRunner,
  type AutomationWeComGateway,
} from "../src/main/automation-service";
import { AutomationStore } from "../src/main/automation-store";
import type {
  ClaudeCodeJobInput,
  ClaudeCodeJobResult,
} from "../src/main/claude-code-job-runner";
import type {
  AutomationWeComBotProfile,
  ProjectRecord,
  UpsertAutomationWeComBotRequest,
  UpsertAutomationJobRequest,
} from "../src/shared/contracts";
import type {
  AutomationWeComMessageHandler,
} from "../src/main/automation-wecom-bot-manager";

const temporaryDirectories: string[] = [];
const services: AutomationService[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "claude-automation-service-"));
  temporaryDirectories.push(directory);
  return directory;
}

function successResult(): ClaudeCodeJobResult {
  return {
    status: "succeeded",
    sessionId: "claude-session-one",
    exitCode: 0,
    output: {
      outcome: "notify",
      summary: "发现一条新信息。",
      wecomMarkdown: "## 新信息\n\n内容摘要。",
      evidence: [{ title: "来源", url: "https://example.com/news" }],
      email: {
        status: "not-requested",
        recipients: [],
        detail: "没有要求发送邮件。",
      },
    },
  };
}

class FakeRunner implements AutomationRunner {
  readonly inputs: ClaudeCodeJobInput[] = [];
  readonly results: ClaudeCodeJobResult[] = [];
  disposed = false;

  async run(input: ClaudeCodeJobInput): Promise<ClaudeCodeJobResult> {
    this.inputs.push(input);
    return this.results.shift() ?? successResult();
  }

  cancel(): boolean {
    return false;
  }

  dispose(): void {
    this.disposed = true;
  }
}

class FakeGateway extends EventEmitter implements AutomationWeComGateway {
  handler: AutomationWeComMessageHandler | null = null;
  readonly sent: Array<{
    botProfileId: string;
    targetId: string;
    content: string;
  }> = [];
  fail = false;
  readonly bots: AutomationWeComBotProfile[] = [
    {
      id: "bot-profile-one",
      name: "资讯机器人",
      enabled: true,
      configured: true,
      hasSecret: true,
      botId: "aibot-one",
      status: "connected",
      createdAt: 1,
      updatedAt: 1,
    },
  ];

  listBots(): AutomationWeComBotProfile[] {
    return this.bots.map((bot) => ({ ...bot }));
  }

  async upsertBot(
    _request: UpsertAutomationWeComBotRequest,
  ): Promise<AutomationWeComBotProfile> {
    return this.bots[0];
  }

  async deleteBot(): Promise<void> {}

  setBusinessMessageHandler(handler: AutomationWeComMessageHandler | null): void {
    this.handler = handler;
  }

  async sendMarkdown(
    botProfileId: string,
    targetId: string,
    content: string,
  ): Promise<void> {
    if (this.fail) {
      throw new Error("gateway offline");
    }
    this.sent.push({ botProfileId, targetId, content });
  }

  dispose(): void {}
}

function request(
  overrides: Partial<UpsertAutomationJobRequest> = {},
): UpsertAutomationJobRequest {
  return {
    name: "每日资讯",
    enabled: true,
    projectId: "project-one",
    schedule: "0 9 * * 1-5",
    mcpConfigPath: ".mcp.json",
    allowedMcpServers: ["web", "mail"],
    prompt: "读取网页并整理。",
    emailRecipients: [],
    wecomBotProfileId: "bot-profile-one",
    wecomTargetIds: ["group-one"],
    allowedWecomUserIds: ["zhangsan"],
    timeoutMinutes: 20,
    maxTurns: 20,
    ...overrides,
  };
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("Timed out waiting for automation state.");
}

async function fixture(options: { now?: () => number } = {}) {
  const root = await temporaryDirectory();
  const projectRoot = join(root, "project");
  await mkdir(projectRoot);
  const project: ProjectRecord = {
    id: "project-one",
    name: "project",
    pinned: false,
    rootPath: projectRoot,
    createdAt: 1,
    lastOpenedAt: 1,
  };
  const store = new AutomationStore(join(root, "automation.json"));
  const runner = new FakeRunner();
  const gateway = new FakeGateway();
  const service = new AutomationService(
    store,
    runner,
    (projectId) => (projectId === project.id ? project : undefined),
    gateway,
    options.now,
  );
  services.push(service);
  await service.initialize();
  return { service, store, runner, gateway };
}

afterEach(async () => {
  for (const service of services.splice(0)) {
    await service.dispose();
  }
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("AutomationService", () => {
  it("runs a saved job and reliably records its WeCom delivery", async () => {
    const { service, runner, gateway } = await fixture();
    const job = await service.upsertJob(request());

    const queued = await service.runJob(job.id);
    await waitFor(
      () => service.getSnapshot().runs[0]?.deliveries[0]?.status === "sent",
    );

    const completed = service.getSnapshot().runs[0];
    expect(completed).toMatchObject({
      id: queued.id,
      status: "succeeded",
      sessionId: "claude-session-one",
      deliveries: [{ targetId: "group-one", status: "sent", attempts: 1 }],
    });
    expect(runner.inputs).toHaveLength(1);
    expect(runner.inputs[0].projectRoot).toContain("project");
    expect(gateway.sent[0]).toMatchObject({
      botProfileId: "bot-profile-one",
      targetId: "group-one",
    });
    expect(gateway.sent[0].content).toContain(`[RPT-${completed.reportCode}]`);
  });

  it("routes authorized group follow-ups and persistently deduplicates msgid", async () => {
    const { service, runner, gateway } = await fixture();
    await service.upsertJob(request());
    gateway.bots.push({
      ...gateway.bots[0],
      id: "bot-profile-two",
      name: "运营机器人",
      botId: "aibot-two",
    });
    const wrongBot = await service.routeWeComMessage({
      botProfileId: "bot-profile-two",
      messageId: "wrong-bot",
      chatType: "group",
      chatId: "group-one",
      userId: "zhangsan",
      text: "分析影响",
      quoteText: "",
    });
    expect(wrongBot).toBeNull();
    expect(runner.inputs).toHaveLength(0);

    const chatIdResult = await service.routeWeComMessage({
      botProfileId: "bot-profile-one",
      messageId: "chat-id-query",
      chatType: "group",
      chatId: "group-one",
      userId: "unknown",
      text: "@机器人 /chatid",
      quoteText: "",
    });
    expect(chatIdResult?.message).toContain("group-one");
    expect(service.getSnapshot().discoveredWeComGroups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          botProfileId: "bot-profile-one",
          chatId: "group-one",
        }),
        expect.objectContaining({
          botProfileId: "bot-profile-two",
          chatId: "group-one",
        }),
      ]),
    );

    await expect(
      service.updateWeComGroupAlias({
        botProfileId: "bot-profile-one",
        chatId: "group-one",
        alias: "每日资讯群",
      }),
    ).resolves.toMatchObject({
      chatId: "group-one",
      alias: "每日资讯群",
    });
    expect(
      service
        .getSnapshot()
        .discoveredWeComGroups.find(
          (group) => group.botProfileId === "bot-profile-one",
        )?.alias,
    ).toBe("每日资讯群");

    const ordinary = await service.routeWeComMessage({
      botProfileId: "bot-profile-one",
      messageId: "ordinary-group-message",
      chatType: "group",
      chatId: "group-one",
      userId: "zhangsan",
      text: "今天大家先同步一下进度",
      quoteText: "",
    });
    expect(ordinary).toBeNull();
    expect(runner.inputs).toHaveLength(0);

    const unauthorized = await service.routeWeComMessage({
      botProfileId: "bot-profile-one",
      messageId: "unauthorized",
      chatType: "group",
      chatId: "group-one",
      userId: "lisi",
      text: "/run 每日资讯",
      quoteText: "",
    });
    expect(unauthorized?.status).toBe("rejected");

    const message = {
      botProfileId: "bot-profile-one",
      messageId: "message-one",
      chatType: "group" as const,
      chatId: "group-one",
      userId: "zhangsan",
      text: "/run 每日资讯",
      quoteText: "",
    };
    const accepted = await service.routeWeComMessage(message);
    expect(accepted?.status).toBe("accepted");
    expect(accepted?.message).toContain("[RPT-");
    await waitFor(() => service.getSnapshot().runs[0]?.status === "succeeded");

    const duplicate = await service.routeWeComMessage(message);
    expect(duplicate?.status).toBe("accepted");
    expect(duplicate?.message).toContain(service.getSnapshot().runs[0].reportCode);
    expect(runner.inputs).toHaveLength(1);
    expect(runner.inputs[0].prompt).toContain("/run 每日资讯");
  });

  it("reserves a job before persistence so simultaneous starts cannot overlap", async () => {
    const { service, runner } = await fixture();
    const job = await service.upsertJob(
      request({ wecomBotProfileId: undefined, wecomTargetIds: [] }),
    );

    const [first, second] = await Promise.allSettled([
      service.runJob(job.id),
      service.runJob(job.id),
    ]);

    expect([first.status, second.status].sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
    await waitFor(() => service.getSnapshot().runs[0]?.status === "succeeded");
    expect(runner.inputs).toHaveLength(1);
  });

  it("does not downgrade unknown or cross-group report quotes to a default task", async () => {
    const { service, runner, gateway } = await fixture();
    const job = await service.upsertJob(request());
    const source = await service.runJob(job.id);
    await waitFor(() => {
      const snapshot = service.getSnapshot();
      return (
        snapshot.runs[0]?.deliveries[0]?.status === "sent" &&
        !snapshot.runningJobIds.includes(job.id)
      );
    });

    const unknown = await service.routeWeComMessage({
      botProfileId: "bot-profile-one",
      messageId: "unknown-report",
      chatType: "group",
      chatId: "group-one",
      userId: "zhangsan",
      text: "继续分析",
      quoteText: "[RPT-FFFFFFFFFF]",
    });
    expect(unknown).toMatchObject({ status: "rejected" });

    const wrongGroup = await service.routeWeComMessage({
      botProfileId: "bot-profile-one",
      messageId: "wrong-group",
      chatType: "group",
      chatId: "group-two",
      userId: "zhangsan",
      text: "继续分析",
      quoteText: `[RPT-${source.reportCode}]`,
    });
    expect(wrongGroup?.message).toContain("未投递到本群");

    const accepted = await service.routeWeComMessage({
      botProfileId: "bot-profile-one",
      messageId: "valid-quote",
      chatType: "group",
      chatId: "group-one",
      userId: "zhangsan",
      text: "继续分析影响",
      quoteText: `[RPT-${source.reportCode}]`,
    });
    expect(accepted?.status).toBe("accepted");
    await waitFor(() => runner.inputs.length === 2);
    expect(runner.inputs[1].prompt).toContain("上一份报告摘要：发现一条新信息");
  });

  it("retries a failed WeCom Outbox delivery after the connection recovers", async () => {
    let now = new Date(2026, 7, 31, 8, 30).getTime();
    const { service, gateway } = await fixture({ now: () => now });
    const job = await service.upsertJob(request());
    gateway.fail = true;

    await service.runJob(job.id);
    await waitFor(
      () => service.getSnapshot().runs[0]?.deliveries[0]?.status === "failed",
    );
    expect(service.getSnapshot().runs[0].deliveries[0].attempts).toBe(1);

    now += 31_000;
    gateway.fail = false;
    gateway.emit("stateChanged");
    await waitFor(
      () => service.getSnapshot().runs[0]?.deliveries[0]?.status === "sent",
    );
    expect(gateway.sent).toHaveLength(1);
  });

  it("retries a failed Agent run with the same run and idempotency identity", async () => {
    const { service, runner } = await fixture();
    runner.results.push({ status: "failed", error: "temporary failure" });
    runner.results.push(successResult());
    const job = await service.upsertJob(
      request({ wecomBotProfileId: undefined, wecomTargetIds: [] }),
    );

    const first = await service.runJob(job.id);
    await waitFor(() => {
      const snapshot = service.getSnapshot();
      return (
        snapshot.runs[0]?.status === "failed" &&
        !snapshot.runningJobIds.includes(job.id)
      );
    });
    const retry = await service.retryRun(first.id);
    await waitFor(() => service.getSnapshot().runs[0]?.status === "succeeded");

    expect(retry.id).toBe(first.id);
    expect(retry.reportCode).toBe(first.reportCode);
    expect(service.getSnapshot().runs[0].attempt).toBe(2);
    expect(runner.inputs.map((input) => input.runId)).toEqual([first.id, first.id]);
  });

  it("rejects unsafe MCP paths and empty MCP allowlists", async () => {
    const { service } = await fixture();

    await expect(
      service.upsertJob(request({ mcpConfigPath: "../outside.json" })),
    ).rejects.toThrow("工程内");
    await expect(
      service.upsertJob(request({ allowedMcpServers: [] })),
    ).rejects.toThrow("至少需要一项");

    await expect(
      service.upsertJob(
        request({
          name: "多行提示任务",
          prompt: "读取第一页。\n\n只保留符合条件的信息。",
        }),
      ),
    ).resolves.toMatchObject({
      prompt: "读取第一页。\n\n只保留符合条件的信息。",
    });
  });
});
