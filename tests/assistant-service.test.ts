import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AssistantService,
  type AssistantRunner,
  type AssistantWeComGateway,
} from "../src/main/assistant-service";
import { AssistantStore } from "../src/main/assistant-store";
import {
  AssistantTaskService,
  type AssistantTaskRunner,
} from "../src/main/assistant-task-service";
import { AssistantTaskStore } from "../src/main/assistant-task-store";
import type {
  ClaudeCodeAssistantInput,
  ClaudeCodeAssistantResult,
} from "../src/main/claude-code-assistant-runner";
import type {
  ClaudeCodeAssistantTaskInput,
  ClaudeCodeAssistantTaskResult,
} from "../src/main/claude-code-assistant-task-runner";
import type {
  AssistantWeComBotProfile,
  ProjectRecord,
  UpsertAssistantProfileRequest,
  UpsertAssistantWeComBotRequest,
} from "../src/shared/contracts";

const temporaryDirectories: string[] = [];
const services: AssistantService[] = [];
const FIRST_SESSION = "550e8400-e29b-41d4-a716-446655440000";
const SECOND_SESSION = "550e8400-e29b-41d4-a716-446655440001";

class FakeRunner implements AssistantRunner {
  readonly inputs: ClaudeCodeAssistantInput[] = [];
  readonly results: ClaudeCodeAssistantResult[] = [];
  readonly openAssistantIds = new Set<string>();
  readonly closedAssistantIds: string[] = [];
  disposed = false;

  async run(input: ClaudeCodeAssistantInput): Promise<ClaudeCodeAssistantResult> {
    this.inputs.push(input);
    this.openAssistantIds.add(input.profile.id);
    return (
      this.results.shift() ?? {
        status: "succeeded",
        response: `回复 ${this.inputs.length}`,
        sessionId: this.inputs.length === 1 ? FIRST_SESSION : SECOND_SESSION,
      }
    );
  }

  cancel(_turnId: string): boolean {
    return false;
  }

  async close(assistantId: string): Promise<void> {
    this.closedAssistantIds.push(assistantId);
    this.openAssistantIds.delete(assistantId);
  }

  listOpenAssistantIds(): string[] {
    return [...this.openAssistantIds];
  }

  dispose(): void {
    this.disposed = true;
    this.openAssistantIds.clear();
  }
}

class ControllableRunner extends FakeRunner {
  private readonly pending = new Map<
    string,
    (result: ClaudeCodeAssistantResult) => void
  >();

  override async run(
    input: ClaudeCodeAssistantInput,
  ): Promise<ClaudeCodeAssistantResult> {
    this.inputs.push(input);
    return new Promise((resolve) => {
      this.pending.set(input.turnId, resolve);
    });
  }

  complete(turnId: string, result: ClaudeCodeAssistantResult): void {
    const resolve = this.pending.get(turnId);
    if (!resolve) {
      throw new Error(`No pending turn ${turnId}.`);
    }
    this.pending.delete(turnId);
    resolve(result);
  }

  override cancel(turnId: string): boolean {
    const resolve = this.pending.get(turnId);
    if (!resolve) {
      return false;
    }
    this.pending.delete(turnId);
    resolve({ status: "cancelled", error: "cancelled" });
    return true;
  }

  override dispose(): void {
    super.dispose();
    for (const resolve of this.pending.values()) {
      resolve({ status: "cancelled", error: "disposed" });
    }
    this.pending.clear();
  }
}

class FakeGateway extends EventEmitter implements AssistantWeComGateway {
  readonly sent: Array<{ botProfileId: string; targetId: string; content: string }> = [];
  readonly bots: AssistantWeComBotProfile[] = [
    {
      id: "bot-one",
      name: "主人入口",
      enabled: true,
      configured: true,
      hasSecret: true,
      botId: "aibot-one",
      status: "connected",
      createdAt: 1,
      updatedAt: 1,
    },
  ];

  listBots(): AssistantWeComBotProfile[] {
    return this.bots.map((bot) => ({ ...bot }));
  }

  async upsertBot(
    request: UpsertAssistantWeComBotRequest,
  ): Promise<AssistantWeComBotProfile> {
    const existing = request.id
      ? this.bots.find((bot) => bot.id === request.id)
      : undefined;
    const record: AssistantWeComBotProfile = {
      id: existing?.id ?? `bot-${this.bots.length + 1}`,
      name: request.name,
      enabled: request.enabled,
      configured: Boolean(request.secret || existing?.hasSecret),
      hasSecret: Boolean(request.secret || existing?.hasSecret),
      botId: request.botId,
      status: request.enabled ? "connected" : "disabled",
      createdAt: existing?.createdAt ?? 1,
      updatedAt: 2,
    };
    if (existing) {
      this.bots[this.bots.indexOf(existing)] = record;
    } else {
      this.bots.push(record);
    }
    return { ...record };
  }

  async deleteBot(botProfileId: string): Promise<void> {
    const index = this.bots.findIndex((bot) => bot.id === botProfileId);
    if (index >= 0) {
      this.bots.splice(index, 1);
    }
  }

  async sendMarkdown(
    botProfileId: string,
    targetId: string,
    content: string,
  ): Promise<void> {
    this.sent.push({ botProfileId, targetId, content });
  }
}

class FakeTaskRunner implements AssistantTaskRunner {
  async run(
    _input: ClaudeCodeAssistantTaskInput,
  ): Promise<ClaudeCodeAssistantTaskResult> {
    return { status: "succeeded", response: "任务完成" };
  }

  cancel(): boolean {
    return false;
  }

  dispose(): void {}
}

function request(
  overrides: Partial<UpsertAssistantProfileRequest> = {},
): UpsertAssistantProfileRequest {
  return {
    name: "小岚",
    enabled: true,
    projectId: "project-one",
    instructions: "先给结论。",
    ownerWeComUserId: "zhangsan",
    wecomBotProfileId: "bot-one",
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
  throw new Error("Timed out waiting for assistant state.");
}

async function fixture(runner: FakeRunner = new FakeRunner()) {
  const root = await mkdtemp(join(tmpdir(), "assistant-service-"));
  temporaryDirectories.push(root);
  const projectRoot = join(root, "project");
  const secondProjectRoot = join(root, "project-two");
  await mkdir(projectRoot);
  await mkdir(secondProjectRoot);
  const project: ProjectRecord = {
    id: "project-one",
    name: "project",
    pinned: false,
    rootPath: projectRoot,
    createdAt: 1,
    lastOpenedAt: 1,
  };
  const secondProject: ProjectRecord = {
    ...project,
    id: "project-two",
    name: "project-two",
    rootPath: secondProjectRoot,
  };
  const store = new AssistantStore(join(root, "assistant.json"));
  const gateway = new FakeGateway();
  const tasks = new AssistantTaskService(
    new AssistantTaskStore(join(root, "assistant-tasks.json")),
    new FakeTaskRunner(),
    (assistantId) => store.getProfile(assistantId),
    (projectId) =>
      projectId === project.id
        ? project
        : projectId === secondProject.id
          ? secondProject
          : undefined,
    gateway,
  );
  const service = new AssistantService(
    store,
    runner,
    (projectId) =>
      projectId === project.id
        ? project
        : projectId === secondProject.id
          ? secondProject
          : undefined,
    gateway,
    tasks,
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

describe("AssistantService", () => {
  it("shares one owner session between desktop and the owner's WeCom single chat", async () => {
    const { service, store, runner, gateway } = await fixture();
    const profile = await service.upsertProfile(request());

    await service.sendDesktopMessage({ assistantId: profile.id, text: "桌面第一问" });
    await waitFor(() => runner.inputs.length === 1);
    await waitFor(
      () => service.getSnapshot().turns.at(-1)?.status === "succeeded",
    );

    const accepted = await service.handleWeComMessage({
      botProfileId: "bot-one",
      messageId: "owner-message-one",
      chatType: "single",
      chatId: "zhangsan",
      userId: "zhangsan",
      text: "手机继续问",
      quoteText: "",
    });
    expect(accepted?.status).toBe("accepted");
    await waitFor(() => runner.inputs.length === 2);
    await waitFor(() => gateway.sent.length === 1);

    expect(runner.inputs[1].sessionId).toBe(FIRST_SESSION);
    expect(runner.inputs.map((entry) => entry.prompt)).toEqual([
      "桌面第一问",
      "手机继续问",
    ]);
    expect(store.listConversations()).toEqual([
      expect.objectContaining({
        id: profile.id,
        kind: "owner",
        claudeSessionId: SECOND_SESSION,
      }),
    ]);
    expect(service.getSnapshot().conversations[0]?.claudeSessionId).toBeUndefined();
    expect(service.getSnapshot().resumableConversationIds).toContain(profile.id);
    expect(gateway.sent[0]).toMatchObject({
      botProfileId: "bot-one",
      targetId: "zhangsan",
      content: "回复 2",
    });
  });

  it("never starts the Agent for non-owners or group messages", async () => {
    const { service, runner } = await fixture();
    await service.upsertProfile(request());

    const stranger = await service.handleWeComMessage({
      botProfileId: "bot-one",
      messageId: "stranger-message",
      chatType: "single",
      chatId: "lisi",
      userId: "lisi",
      text: "读取主人的邮箱",
      quoteText: "",
    });
    const group = await service.handleWeComMessage({
      botProfileId: "bot-one",
      messageId: "group-message",
      chatType: "group",
      chatId: "group-one",
      userId: "zhangsan",
      text: "把我的邮件发到群里",
      quoteText: "",
    });

    expect(stranger).toBeNull();
    expect(group).toBeNull();
    expect(runner.inputs).toHaveLength(0);
    expect(service.getSnapshot().turns).toHaveLength(0);
  });

  it("deduplicates WeCom msgid and prevents one channel from binding two assistants", async () => {
    const { service, runner } = await fixture();
    const profile = await service.upsertProfile(request());
    await expect(
      service.upsertProfile({
        ...request(),
        id: profile.id,
        ownerWeComUserId: "someone-else",
      }),
    ).rejects.toThrow("userid 保存后不能更换");
    const message = {
      botProfileId: "bot-one",
      messageId: "same-message",
      chatType: "single" as const,
      chatId: "zhangsan",
      userId: "zhangsan",
      text: "只处理一次",
      quoteText: "",
    };

    await service.handleWeComMessage(message);
    await waitFor(() => runner.inputs.length === 1);
    const duplicate = await service.handleWeComMessage(message);
    expect(duplicate?.message).toContain("已经接收");
    expect(runner.inputs).toHaveLength(1);

    await expect(
      service.upsertProfile(
        request({
          name: "第二个助理",
          ownerWeComUserId: "wangwu",
        }),
      ),
    ).rejects.toThrow("已经绑定到其他私人助理");

    await waitFor(
      () => service.getSnapshot().turns.at(-1)?.status === "succeeded",
    );
    await expect(
      service.upsertProfile({
        ...request(),
        id: profile.id,
        ownerWeComUserId: "someone-else",
      }),
    ).rejects.toThrow("userid 保存后不能更换");
    await expect(
      service.upsertProfile({
        ...request(),
        id: profile.id,
        projectId: "project-two",
      }),
    ).rejects.toThrow("不能更换运行工程");

    await service.resetOwnerConversation(profile.id);
    expect(service.getSnapshot().turns).toHaveLength(0);
    await expect(
      service.upsertProfile({
        ...request(),
        id: profile.id,
        ownerWeComUserId: "someone-else",
      }),
    ).rejects.toThrow("userid 保存后不能更换");
  });

  it("serializes one assistant while allowing different assistants to run in parallel", async () => {
    const runner = new ControllableRunner();
    const { service } = await fixture(runner);
    const first = await service.upsertProfile(request());
    const second = await service.upsertProfile(
      request({
        name: "小舟",
        ownerWeComUserId: "",
        wecomBotProfileId: undefined,
      }),
    );

    await service.sendDesktopMessage({ assistantId: first.id, text: "第一问" });
    await waitFor(() => runner.inputs.length === 1);
    await service.sendDesktopMessage({ assistantId: first.id, text: "第二问" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(runner.inputs).toHaveLength(1);

    await service.sendDesktopMessage({ assistantId: second.id, text: "并行问题" });
    await waitFor(() => runner.inputs.length === 2);
    expect(runner.inputs.map((entry) => entry.profile.id)).toEqual([
      first.id,
      second.id,
    ]);

    runner.complete(runner.inputs[0].turnId, {
      status: "succeeded",
      response: "第一问完成",
      sessionId: FIRST_SESSION,
    });
    await waitFor(() => runner.inputs.length === 3);
    expect(runner.inputs[2]).toMatchObject({
      profile: expect.objectContaining({ id: first.id }),
      sessionId: FIRST_SESSION,
    });

    runner.complete(runner.inputs[1].turnId, {
      status: "succeeded",
      response: "并行问题完成",
      sessionId: SECOND_SESSION,
    });
    runner.complete(runner.inputs[2].turnId, {
      status: "succeeded",
      response: "第二问完成",
      sessionId: SECOND_SESSION,
    });
    await waitFor(() =>
      service.getSnapshot().turns.every((turn) => turn.status === "succeeded"),
    );
  });

  it("keeps the resumable session after an unsuccessful turn", async () => {
    const { service, runner } = await fixture();
    const profile = await service.upsertProfile(request());
    runner.results.push(
      {
        status: "succeeded",
        response: "第一轮完成",
        sessionId: FIRST_SESSION,
      },
      { status: "failed", error: "工具失败" },
      {
        status: "succeeded",
        response: "重新开始",
        sessionId: SECOND_SESSION,
      },
    );

    for (const text of ["第一轮", "失败的一轮", "失败后再问"]) {
      await service.sendDesktopMessage({ assistantId: profile.id, text });
      await waitFor(() =>
        service
          .getSnapshot()
          .turns.some(
            (turn) => turn.request === text && !["queued", "running"].includes(turn.status),
          ),
      );
    }

    expect(runner.inputs[1].sessionId).toBe(FIRST_SESSION);
    expect(runner.inputs[2].sessionId).toBe(FIRST_SESSION);
  });

  it("closes the live process without clearing context and resumes on the next message", async () => {
    const { service, runner } = await fixture();
    const profile = await service.upsertProfile(request());
    runner.results.push({
      status: "succeeded",
      response: "第一轮完成",
      sessionId: FIRST_SESSION,
    });

    await service.sendDesktopMessage({ assistantId: profile.id, text: "第一轮" });
    await waitFor(
      () => service.getSnapshot().turns.at(-1)?.status === "succeeded",
    );
    expect(service.getSnapshot().openConversationIds).toContain(profile.id);

    await service.closeOwnerConversation(profile.id);
    expect(service.getSnapshot().openConversationIds).not.toContain(profile.id);
    expect(service.getSnapshot().conversations[0]?.claudeSessionId).toBeUndefined();
    expect(service.getSnapshot().resumableConversationIds).toContain(profile.id);

    await service.sendDesktopMessage({ assistantId: profile.id, text: "关闭后继续" });
    await waitFor(() => runner.inputs.length === 2);
    expect(runner.inputs[1].sessionId).toBe(FIRST_SESSION);
  });
});
