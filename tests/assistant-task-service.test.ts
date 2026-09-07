import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AssistantTaskService,
  type AssistantTaskRunner,
  type AssistantTaskWeComGateway,
} from "../src/main/assistant-task-service";
import { AssistantTaskStore } from "../src/main/assistant-task-store";
import type {
  ClaudeCodeAssistantTaskInput,
  ClaudeCodeAssistantTaskResult,
} from "../src/main/claude-code-assistant-task-runner";
import type {
  AssistantProfileRecord,
  ProjectRecord,
} from "../src/shared/contracts";

const temporaryDirectories: string[] = [];
const services: AssistantTaskService[] = [];

function profile(id = "assistant-one"): AssistantProfileRecord {
  return {
    id,
    name: id === "assistant-one" ? "小岚" : "小舟",
    enabled: true,
    projectPath: process.cwd(),
    projectId: "project-one",
    instructions: "先给结论。",
    ownerWeComUserId: "zhangsan",
    wecomBotProfileId: "bot-one",
    timeoutMinutes: 20,
    maxTurns: 20,
    createdAt: 1,
    updatedAt: 1,
  };
}

class FakeRunner implements AssistantTaskRunner {
  readonly inputs: ClaudeCodeAssistantTaskInput[] = [];
  readonly results: ClaudeCodeAssistantTaskResult[] = [];
  disposed = false;

  async run(
    input: ClaudeCodeAssistantTaskInput,
  ): Promise<ClaudeCodeAssistantTaskResult> {
    this.inputs.push(input);
    return (
      this.results.shift() ?? {
        status: "succeeded",
        response: "任务完成",
      }
    );
  }

  cancel(): boolean {
    return false;
  }

  dispose(): void {
    this.disposed = true;
  }
}

class FakeGateway implements AssistantTaskWeComGateway {
  readonly sent: Array<{
    botProfileId: string;
    targetId: string;
    content: string;
  }> = [];
  error: Error | undefined;

  async sendMarkdown(
    botProfileId: string,
    targetId: string,
    content: string,
  ): Promise<void> {
    this.sent.push({ botProfileId, targetId, content });
    if (this.error) {
      throw this.error;
    }
  }
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("Timed out waiting for assistant task state.");
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "assistant-task-service-"));
  temporaryDirectories.push(root);
  const store = new AssistantTaskStore(join(root, "assistant-tasks.json"));
  const runner = new FakeRunner();
  const gateway = new FakeGateway();
  const profiles = new Map([
    ["assistant-one", profile()],
    ["assistant-two", profile("assistant-two")],
  ]);
  const project: ProjectRecord = {
    id: "project-one",
    name: "project",
    pinned: false,
    rootPath: join(root, "project"),
    createdAt: 1,
    lastOpenedAt: 1,
  };
  const service = new AssistantTaskService(
    store,
    runner,
    (assistantId) => profiles.get(assistantId),
    (projectId) => (projectId === project.id ? project : undefined),
    gateway,
    () => 1_000,
  );
  services.push(service);
  await service.initialize();
  return { service, store, runner, gateway };
}

async function createTask(service: AssistantTaskService) {
  return service.createTask("assistant-one", {
    name: "每日简报",
    schedule: "0 9 * * *",
    prompt: "整理今日简报",
  });
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

describe("AssistantTaskService", () => {
  it("binds task management to the current assistant", async () => {
    const { service, runner } = await fixture();
    const task = await createTask(service);

    await expect(
      service.updateTask("assistant-two", task.id, { enabled: false }),
    ).rejects.toThrow("不属于当前助理");
    await expect(service.runTaskNow("assistant-two", task.id)).rejects.toThrow(
      "不属于当前助理",
    );
    expect(runner.inputs).toHaveLength(0);
  });

  it("persists a failed independent run and proactively reports it to the owner", async () => {
    const { service, runner, gateway } = await fixture();
    const task = await createTask(service);
    runner.results.push({ status: "failed", error: "邮箱服务不可用" });

    const queued = await service.runTaskNow("assistant-one", task.id);
    expect(service.listRuns({ taskId: task.id })).toEqual([
      expect.objectContaining({ id: queued.id }),
    ]);
    await waitFor(
      () =>
        service.listRuns({ taskId: task.id })[0]?.status === "failed" &&
        gateway.sent.length === 1,
    );

    expect(service.listRuns({ taskId: task.id })[0]).toMatchObject({
      status: "failed",
      error: "邮箱服务不可用",
      startedAt: 1_000,
      finishedAt: 1_000,
    });
    expect(runner.inputs).toEqual([
      expect.objectContaining({
        runId: queued.id,
        task: expect.objectContaining({ id: task.id }),
        projectRoot: expect.stringContaining("project"),
      }),
    ]);
    expect(gateway.sent).toEqual([
      expect.objectContaining({
        botProfileId: "bot-one",
        targetId: "zhangsan",
        content: expect.stringContaining("定时任务未完成"),
      }),
    ]);
  });

  it("delivers a successful run through the task assistant's bound bot", async () => {
    const { service, gateway } = await fixture();
    const task = await createTask(service);

    await service.runTaskNow("assistant-one", task.id);
    await waitFor(() => gateway.sent.length === 1);

    expect(gateway.sent).toEqual([
      {
        botProfileId: "bot-one",
        targetId: "zhangsan",
        content: expect.stringContaining("### 定时任务：每日简报"),
      },
    ]);
  });

  it("records a WeCom delivery failure separately from successful execution", async () => {
    const { service, gateway } = await fixture();
    const task = await createTask(service);
    gateway.error = new Error("connection lost");

    await service.runTaskNow("assistant-one", task.id);
    await waitFor(
      () =>
        service.listRuns({ taskId: task.id })[0]?.deliveryError !== undefined,
    );

    expect(service.listRuns({ taskId: task.id })[0]).toMatchObject({
      status: "succeeded",
      response: "任务完成",
      deliveryError: expect.stringContaining("connection lost"),
    });
  });

  it("turns a thrown runner error into a terminal visible failure", async () => {
    const { service, runner } = await fixture();
    const task = await createTask(service);
    runner.run = async () => {
      throw new Error("Claude executable missing");
    };

    await service.runTaskNow("assistant-one", task.id);
    await waitFor(
      () => service.listRuns({ taskId: task.id })[0]?.status === "failed",
    );

    expect(service.listRuns({ taskId: task.id })[0]).toMatchObject({
      status: "failed",
      error: expect.stringContaining("Claude executable missing"),
    });
  });
});
