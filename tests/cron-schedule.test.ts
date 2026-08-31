import { describe, expect, it } from "vitest";
import {
  matchesCronSchedule,
  parseCronSchedule,
} from "../src/main/cron-schedule";

describe("cron schedule", () => {
  it("matches five-field weekday schedules in local time", () => {
    const mondayAtNine = new Date(2026, 7, 31, 9, 0, 0);
    const mondayAtTen = new Date(2026, 7, 31, 10, 0, 0);
    const sundayAtNine = new Date(2026, 7, 30, 9, 0, 0);

    expect(matchesCronSchedule("0 9 * * 1-5", mondayAtNine)).toBe(true);
    expect(matchesCronSchedule("0 9 * * 1-5", mondayAtTen)).toBe(false);
    expect(matchesCronSchedule("0 9 * * 1-5", sundayAtNine)).toBe(false);
  });

  it("supports lists, ranges, steps and Sunday value 7", () => {
    expect(matchesCronSchedule("*/15 8-10 * 1,8 0,7", new Date(2026, 7, 30, 8, 30))).toBe(
      true,
    );
    expect(matchesCronSchedule("*/15 8-10 * 1,8 0,7", new Date(2026, 7, 30, 8, 31))).toBe(
      false,
    );
    expect(matchesCronSchedule("5/10 * * * *", new Date(2026, 7, 30, 8, 25))).toBe(
      true,
    );
  });

  it("uses traditional cron OR semantics when both day fields are restricted", () => {
    // 2026-08-31 is both the 31st and a Monday.
    expect(matchesCronSchedule("0 9 15 * 1", new Date(2026, 7, 31, 9, 0))).toBe(
      true,
    );
    // 2026-09-15 is a Tuesday but still matches day-of-month 15.
    expect(matchesCronSchedule("0 9 15 * 1", new Date(2026, 8, 15, 9, 0))).toBe(
      true,
    );
  });

  it("normalizes whitespace and rejects unsupported expressions", () => {
    expect(parseCronSchedule("  0   9  * *  1-5 ").expression).toBe(
      "0 9 * * 1-5",
    );
    expect(() => parseCronSchedule("0 9 * *")).toThrow("5 个字段");
    expect(() => parseCronSchedule("0 25 * * *")).toThrow("小时");
    expect(() => parseCronSchedule("0 9 * * MON")).toThrow("星期");
    expect(() => parseCronSchedule("0 9 * * 5-1")).toThrow("倒序");
  });
});
