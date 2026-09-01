import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AssistantTaskStore } from "../src/main/assistant-task-store";
import type {
  AssistantTaskRecord,
  AssistantTaskRunRecord,
} from "../src/shared/contracts";

const temporaryDirectories: string[] = [];

function task(): AssistantTaskRecord {
  return {
    id: "task-one",
    assistantId: "assistant-one",
    name: "每日简报",
    enabled: true,
    schedule: "0 9 * * *",
    prompt: "整理今日简报",
    timeoutMinutes: 20,
    maxTurns: 20,
    createdAt: 1,
    updatedAt: 1,
  };
}

function run(
  overrides: Partial<AssistantTaskRunRecord> = {},
): AssistantTaskRunRecord {
  return {
    id: "run-one",
    taskId: "task-one",
    assistantId: "assistant-one",
    taskName: "每日简报",
    trigger: "scheduled",
    status: "queued",
    createdAt: 2,
    scheduledFor: 2,
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("AssistantTaskStore", () => {
  it("marks interrupted queued and running records failed without retrying them", async () => {
    const root = await mkdtemp(join(tmpdir(), "assistant-task-store-"));
    temporaryDirectories.push(root);
    const storePath = join(root, "assistant-tasks.json");
    const first = new AssistantTaskStore(storePath);
    await first.initialize();
    await first.putTask(task());
    await first.appendRun(run());
    await first.appendRun(
      run({
        id: "run-two",
        status: "running",
        startedAt: 3,
        scheduledFor: 3,
      }),
    );

    const restored = new AssistantTaskStore(storePath);
    await restored.initialize();
    expect(await restored.recoverInterruptedRuns(100)).toBe(2);
    expect(restored.listRuns()).toEqual([
      expect.objectContaining({
        id: "run-one",
        status: "failed",
        finishedAt: 100,
        error: expect.stringContaining("不会自动重跑"),
      }),
      expect.objectContaining({
        id: "run-two",
        status: "failed",
        finishedAt: 100,
        error: expect.stringContaining("结果未知"),
      }),
    ]);
  });

  it("persists execution and delivery failures as separate diagnostics", async () => {
    const root = await mkdtemp(join(tmpdir(), "assistant-task-errors-"));
    temporaryDirectories.push(root);
    const storePath = join(root, "assistant-tasks.json");
    const store = new AssistantTaskStore(storePath);
    await store.initialize();
    await store.putTask(task());
    await store.appendRun(run());
    await store.replaceRun(
      run({
        status: "failed",
        finishedAt: 9,
        error: "Claude Code 执行失败",
        deliveryError: "企业微信投递失败",
      }),
    );

    const persisted = await readFile(storePath, "utf8");
    expect(persisted).toContain("Claude Code 执行失败");
    expect(persisted).toContain("企业微信投递失败");
    expect(store.getRun("run-one")).toMatchObject({
      status: "failed",
      error: "Claude Code 执行失败",
      deliveryError: "企业微信投递失败",
    });
  });
});
