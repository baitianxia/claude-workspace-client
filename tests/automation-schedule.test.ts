import { describe, expect, it } from "vitest";
import {
  automationScheduleExpression,
  automationScheduleFields,
  automationScheduleLabel,
} from "../src/renderer/automation-schedule";

describe("automation schedule presentation", () => {
  it("presents common daily and weekday schedules as simple choices", () => {
    expect(automationScheduleFields("30 8 * * *")).toEqual({
      mode: "daily",
      time: "08:30",
    });
    expect(automationScheduleFields("0 9 * * 1-5")).toEqual({
      mode: "weekdays",
      time: "09:00",
    });
    expect(automationScheduleLabel("0 9 * * 1-5")).toBe("工作日 09:00");
  });

  it("keeps complex cron expressions in custom mode", () => {
    expect(automationScheduleFields("15 9 * * 1,3,5")).toEqual({
      mode: "custom",
      time: "09:00",
    });
    expect(automationScheduleExpression("custom", "09:00", "15 9 * * 1,3,5"))
      .toBe("15 9 * * 1,3,5");
  });

  it("converts simple choices back to five-field cron", () => {
    expect(automationScheduleExpression("daily", "07:05", "unchanged")).toBe(
      "5 7 * * *",
    );
    expect(
      automationScheduleExpression("weekdays", "18:30", "unchanged"),
    ).toBe("30 18 * * 1-5");
  });
});
