import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AutomationStore } from "../src/main/automation-store";
import type {
  AutomationJobRecord,
  AutomationRunRecord,
} from "../src/shared/contracts";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "claude-automation-store-"));
  temporaryDirectories.push(directory);
  return directory;
}

function job(): AutomationJobRecord {
  return {
    id: "daily-news",
    name: "每日资讯",
    enabled: true,
    projectId: "project-one",
    schedule: "0 9 * * 1-5",
    mcpConfigPath: ".mcp.json",
    allowedMcpServers: ["web", "mail"],
    prompt: "读取网页并整理。",
    emailRecipients: ["owner@example.com"],
    wecomTargetIds: ["group-one"],
    allowedWecomUserIds: ["zhangsan"],
    timeoutMinutes: 20,
    maxTurns: 20,
    createdAt: 1,
    updatedAt: 1,
  };
}

function run(status: AutomationRunRecord["status"] = "running"): AutomationRunRecord {
  return {
    id: "run-one",
    reportCode: "A1B2C3D4E5",
    jobId: "daily-news",
    jobName: "每日资讯",
    trigger: "scheduled",
    status,
    attempt: 1,
    createdAt: 2,
    startedAt: 3,
    scheduledFor: 0,
    deliveries: [
      {
        targetId: "group-one",
        status: "sending",
        attempts: 0,
      },
    ],
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("AutomationStore", () => {
  it("persists jobs and execution history independently from workspace data", async () => {
    const root = await temporaryDirectory();
    const storePath = join(root, "automation.json");
    const store = new AutomationStore(storePath);
    await store.initialize();
    await store.putJob(job());
    await store.addRun(run("succeeded"));

    const reloaded = new AutomationStore(storePath);
    await reloaded.initialize();

    expect(reloaded.listJobs()).toEqual([job()]);
    expect(reloaded.listRuns()).toEqual([run("succeeded")]);
    expect(JSON.parse(await readFile(storePath, "utf8"))).toMatchObject({
      version: 1,
    });
  });

  it("marks unfinished agent runs and uncertain deliveries after restart", async () => {
    const root = await temporaryDirectory();
    const store = new AutomationStore(join(root, "automation.json"));
    await store.initialize();
    await store.putJob(job());
    await store.addRun(run());

    await store.recoverInterruptedRuns(100);

    expect(store.getRun("run-one")).toMatchObject({
      status: "failed",
      finishedAt: 100,
      error: expect.stringContaining("结果未知"),
      deliveries: [
        expect.objectContaining({
          status: "failed",
          error: expect.stringContaining("投递结果未知"),
        }),
      ],
    });
  });

  it("deduplicates scheduled minutes and persists inbound message identity", async () => {
    const root = await temporaryDirectory();
    const store = new AutomationStore(join(root, "automation.json"));
    await store.initialize();
    const record = run("succeeded");
    record.triggerMessageId = "wecom-message-one";
    await store.addRun(record);

    expect(store.hasScheduledRun("daily-news", 0)).toBe(true);
    expect(store.findRunByReportCode("a1b2c3d4e5")?.id).toBe("run-one");
    expect(store.findRunByTriggerMessageId("wecom-message-one")?.id).toBe(
      "run-one",
    );
  });

  it("backs up malformed automation data before starting empty", async () => {
    const root = await temporaryDirectory();
    const storePath = join(root, "automation.json");
    await writeFile(storePath, "not json", "utf8");
    const store = new AutomationStore(storePath);

    await store.initialize();

    expect(store.listJobs()).toEqual([]);
    expect(
      (await readdir(root)).some((entry) =>
        entry.startsWith("automation.json.corrupt-"),
      ),
    ).toBe(true);
  });
});
