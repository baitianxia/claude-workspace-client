import { describe, expect, it, vi } from "vitest";
import { ScheduledJobService } from "../src/main/scheduled-job-service";
import type { AutomationJobRecord } from "../src/shared/contracts";

function job(schedule: string): AutomationJobRecord {
  return {
    id: "job-one",
    name: "任务一",
    enabled: true,
    projectId: "project-one",
    schedule,
    mcpConfigPath: ".mcp.json",
    allowedMcpServers: ["web"],
    prompt: "检查网页",
    emailRecipients: [],
    wecomTargetIds: [],
    allowedWecomUserIds: [],
    timeoutMinutes: 20,
    maxTurns: 20,
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("ScheduledJobService", () => {
  it("triggers a matching minute only once", async () => {
    const trigger = vi.fn(async () => undefined);
    const service = new ScheduledJobService(
      () => [job("* * * * *")],
      trigger,
    );
    const now = new Date(2026, 7, 31, 9, 0, 5).getTime();

    await service.tick(now);
    await service.tick(now + 20_000);

    expect(trigger).toHaveBeenCalledTimes(1);
    expect(trigger).toHaveBeenCalledWith(
      expect.objectContaining({ id: "job-one" }),
      Math.floor(now / 60_000) * 60_000,
    );
  });

  it("runs only the latest matching minute after a short sleep", async () => {
    const trigger = vi.fn(async () => undefined);
    const service = new ScheduledJobService(
      () => [job("* * * * *")],
      trigger,
    );
    const first = new Date(2026, 7, 31, 9, 0, 5).getTime();
    await service.tick(first);
    trigger.mockClear();

    const wake = first + 5 * 60_000;
    await service.tick(wake);

    expect(trigger).toHaveBeenCalledTimes(1);
    expect(trigger).toHaveBeenCalledWith(
      expect.objectContaining({ id: "job-one" }),
      Math.floor(wake / 60_000) * 60_000,
    );
  });

  it("does not trigger disabled jobs", async () => {
    const disabled = job("* * * * *");
    disabled.enabled = false;
    const trigger = vi.fn(async () => undefined);
    const service = new ScheduledJobService(() => [disabled], trigger);

    await service.tick(new Date(2026, 7, 31, 9, 0).getTime());

    expect(trigger).not.toHaveBeenCalled();
  });
});
