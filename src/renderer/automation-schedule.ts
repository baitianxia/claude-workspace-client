export type AutomationScheduleMode = "daily" | "weekdays" | "custom";

const SIMPLE_SCHEDULE_PATTERN =
  /^([0-5]?\d)\s+([01]?\d|2[0-3])\s+\*\s+\*\s+(\*|1-5)$/u;

export function automationScheduleFields(schedule: string): {
  mode: AutomationScheduleMode;
  time: string;
} {
  const match = SIMPLE_SCHEDULE_PATTERN.exec(schedule.trim());
  if (!match) {
    return { mode: "custom", time: "09:00" };
  }
  const [, minute, hour, weekdays] = match;
  return {
    mode: weekdays === "1-5" ? "weekdays" : "daily",
    time: `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`,
  };
}

export function automationScheduleExpression(
  mode: AutomationScheduleMode,
  time: string,
  customSchedule: string,
): string {
  if (mode === "custom") {
    return customSchedule;
  }
  const match = /^(\d{2}):(\d{2})$/u.exec(time);
  if (!match) {
    return customSchedule;
  }
  const [, hour, minute] = match;
  return `${Number(minute)} ${Number(hour)} * * ${
    mode === "weekdays" ? "1-5" : "*"
  }`;
}

export function automationScheduleLabel(schedule: string): string {
  const fields = automationScheduleFields(schedule);
  if (fields.mode === "daily") {
    return `每天 ${fields.time}`;
  }
  if (fields.mode === "weekdays") {
    return `工作日 ${fields.time}`;
  }
  return schedule;
}
