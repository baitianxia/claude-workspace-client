import { describe, expect, it } from "vitest";
import {
  buildAssistantTaskPrompt,
  buildAssistantTaskSdkOptions,
  ClaudeCodeAssistantTaskRunner,
  type ClaudeCodeAssistantTaskInput,
  type ClaudeTaskSdkQueryFactory,
} from "../src/main/claude-code-assistant-task-runner";
import type {
  AssistantProfileRecord,
  AssistantTaskRecord,
} from "../src/shared/contracts";

function taskInput(
  overrides: Partial<ClaudeCodeAssistantTaskInput> = {},
): ClaudeCodeAssistantTaskInput {
  const profile: AssistantProfileRecord = {
    id: "assistant-one",
    name: "小岚",
    enabled: true,
    projectPath: "/project",
    projectId: "project-one",
    instructions: "先给结论。",
    ownerWeComUserId: "zhangsan",
    timeoutMinutes: 20,
    maxTurns: 20,
    createdAt: 1,
    updatedAt: 1,
  };
  const task: AssistantTaskRecord = {
    id: "task-one",
    assistantId: profile.id,
    name: "工作日简报",
    enabled: true,
    schedule: "0 9 * * 1-5",
    prompt: "读取已授权信息并整理三条重点。",
    timeoutMinutes: 10,
    maxTurns: 12,
    createdAt: 2,
    updatedAt: 2,
  };
  return {
    runId: "run-one",
    profile,
    task,
    projectRoot: "/project",
    ...overrides,
  };
}

function successfulFactory(
  calls: Array<Parameters<ClaudeTaskSdkQueryFactory>[0]>,
): ClaudeTaskSdkQueryFactory {
  return ((parameters: Parameters<ClaudeTaskSdkQueryFactory>[0]) => {
    calls.push(parameters);
    const query = {
      close: () => undefined,
      interrupt: async () => undefined,
      async *[Symbol.asyncIterator]() {
        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          result: `任务结果 ${calls.length}`,
        };
      },
    };
    return query as unknown as ReturnType<ClaudeTaskSdkQueryFactory>;
  }) as ClaudeTaskSdkQueryFactory;
}

describe("ClaudeCodeAssistantTaskRunner", () => {
  it("starts a fresh non-persistent Claude query for every task run", async () => {
    const calls: Array<Parameters<ClaudeTaskSdkQueryFactory>[0]> = [];
    const runner = new ClaudeCodeAssistantTaskRunner(
      () => "/usr/bin/claude",
      successfulFactory(calls),
    );

    const first = await runner.run(taskInput());
    const second = await runner.run(taskInput({ runId: "run-two" }));

    expect(first).toEqual({ status: "succeeded", response: "任务结果 1" });
    expect(second).toEqual({ status: "succeeded", response: "任务结果 2" });
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(typeof call.prompt).toBe("string");
      expect(call.prompt).toContain("任务内容：");
      expect(call.prompt).toContain("读取已授权信息并整理三条重点");
      expect(call.options).toMatchObject({
        cwd: "/project",
        persistSession: false,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        tools: { type: "preset", preset: "claude_code" },
        skills: "all",
      });
      expect(call.options).not.toHaveProperty("resume");
    }
  });

  it("builds a task-only prompt without a main chat transcript", () => {
    const prompt = buildAssistantTaskPrompt(taskInput());

    expect(prompt).toContain("任务名称：工作日简报");
    expect(prompt).toContain("结果投递目标：助理主人企业微信单聊");
    expect(prompt).toContain("触发方式：主人手动立即执行");
    expect(prompt).not.toContain("主人上一轮对话");
    expect(prompt).not.toContain("聊天记录");
  });

  it("includes a configured group chatid in the independent task prompt", () => {
    const prompt = buildAssistantTaskPrompt(
      taskInput({
        task: {
          ...taskInput().task,
          deliveryTarget: "wrhR_group-chatid",
        },
      }),
    );

    expect(prompt).toContain("结果投递目标：wrhR_group-chatid");
  });

  it("does not persist or resume sessions in the SDK options", () => {
    const abortController = new AbortController();
    const options = buildAssistantTaskSdkOptions(
      taskInput(),
      "/usr/bin/claude",
      abortController,
    );

    expect(options.persistSession).toBe(false);
    expect(options).not.toHaveProperty("resume");
    expect(options.abortController).toBe(abortController);
    expect(options.maxTurns).toBe(12);
    expect(options.disallowedTools).toEqual([
      "CronCreate",
      "CronDelete",
      "CronList",
      "ScheduleWakeup",
      "RemoteTrigger",
    ]);
  });

  it("uses the Windows script wrapper for npm-installed Claude Code", () => {
    const options = buildAssistantTaskSdkOptions(
      taskInput(),
      "C:\\Users\\developer\\AppData\\Roaming\\npm\\claude.cmd",
      new AbortController(),
      "win32",
    );

    expect(options.spawnClaudeCodeProcess).toBeTypeOf("function");
  });

  it("turns an SDK execution exception into a visible failed result", async () => {
    const factory = (() => {
      const query = {
        close: () => undefined,
        interrupt: async () => undefined,
        async *[Symbol.asyncIterator]() {
          throw new Error("browser process crashed");
        },
      };
      return query as unknown as ReturnType<ClaudeTaskSdkQueryFactory>;
    }) as ClaudeTaskSdkQueryFactory;
    const runner = new ClaudeCodeAssistantTaskRunner(
      () => "/usr/bin/claude",
      factory,
    );

    await expect(runner.run(taskInput())).resolves.toMatchObject({
      status: "failed",
      error: expect.stringContaining("browser process crashed"),
    });
  });
});
