import { describe, expect, it, vi } from "vitest";
import {
  ScheduledJobService,
  type ScheduledItem,
} from "../src/main/scheduled-job-service";

function job(
  schedule: string,
  overrides: Partial<ScheduledItem> = {},
): ScheduledItem {
  return {
    id: "job-one",
    enabled: true,
    schedule,
    ...overrides,
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

  it("reports a task trigger failure and continues checking other tasks", async () => {
    const first = job("* * * * *", { id: "task-failing" });
    const second = job("* * * * *", { id: "task-healthy" });
    const trigger = vi.fn(async (item: ScheduledItem) => {
      if (item.id === first.id) {
        throw new Error("cannot persist queued run");
      }
    });
    const onError = vi.fn();
    const service = new ScheduledJobService(
      () => [first, second],
      trigger,
      () => undefined,
      Date.now,
      onError,
    );

    await service.tick(new Date(2026, 7, 31, 9, 0).getTime());

    expect(trigger).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "cannot persist queued run" }),
      "task-failing",
    );
  });
});
