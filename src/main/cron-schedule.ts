const FIELD_COUNT = 5;

interface CronFieldDefinition {
  label: string;
  minimum: number;
  maximum: number;
  normalize?: (value: number) => number;
}

interface ParsedCronField {
  values: Set<number>;
  wildcard: boolean;
}

export interface ParsedCronSchedule {
  expression: string;
  minute: ParsedCronField;
  hour: ParsedCronField;
  dayOfMonth: ParsedCronField;
  month: ParsedCronField;
  dayOfWeek: ParsedCronField;
}

const FIELD_DEFINITIONS: CronFieldDefinition[] = [
  { label: "分钟", minimum: 0, maximum: 59 },
  { label: "小时", minimum: 0, maximum: 23 },
  { label: "日期", minimum: 1, maximum: 31 },
  { label: "月份", minimum: 1, maximum: 12 },
  {
    label: "星期",
    minimum: 0,
    maximum: 7,
    normalize: (value) => (value === 7 ? 0 : value),
  },
];

function parseInteger(
  value: string,
  definition: CronFieldDefinition,
): number {
  if (!/^\d+$/u.test(value)) {
    throw new Error(`${definition.label}字段包含不支持的值“${value}”。`);
  }
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < definition.minimum ||
    parsed > definition.maximum
  ) {
    throw new Error(
      `${definition.label}必须在 ${definition.minimum}-${definition.maximum} 之间。`,
    );
  }
  return parsed;
}

function parseCronField(
  source: string,
  definition: CronFieldDefinition,
): ParsedCronField {
  const values = new Set<number>();
  // Follow Vixie cron: a field whose text starts with "*" (including "*/2")
  // counts as unrestricted for the day-of-month/day-of-week OR rule. Only
  // when both day fields are restricted does either one select the day.
  const wildcard = source.startsWith("*");
  const parts = source.split(",");
  if (parts.some((part) => !part)) {
    throw new Error(`${definition.label}字段包含空白列表项。`);
  }

  for (const part of parts) {
    const stepParts = part.split("/");
    if (stepParts.length > 2 || !stepParts[0]) {
      throw new Error(`${definition.label}字段“${part}”格式无效。`);
    }
    const step =
      stepParts.length === 2
        ? parseInteger(stepParts[1], {
            label: `${definition.label}步长`,
            minimum: 1,
            maximum: definition.maximum - definition.minimum + 1,
          })
        : 1;
    const base = stepParts[0];
    let start: number;
    let end: number;

    if (base === "*") {
      start = definition.minimum;
      end = definition.maximum;
    } else {
      const rangeParts = base.split("-");
      if (rangeParts.length > 2 || !rangeParts[0]) {
        throw new Error(`${definition.label}字段“${part}”格式无效。`);
      }
      start = parseInteger(rangeParts[0], definition);
      end =
        rangeParts.length === 2
          ? parseInteger(rangeParts[1], definition)
          : stepParts.length === 2
            ? definition.maximum
            : start;
      if (end < start) {
        throw new Error(`${definition.label}范围不能倒序：${base}。`);
      }
    }

    for (let value = start; value <= end; value += step) {
      values.add(definition.normalize?.(value) ?? value);
    }
  }

  if (values.size === 0) {
    throw new Error(`${definition.label}字段没有可执行的值。`);
  }
  return { values, wildcard };
}

export function parseCronSchedule(value: string): ParsedCronSchedule {
  if (typeof value !== "string") {
    throw new Error("定时表达式必须是字符串。");
  }
  const expression = value.trim().replace(/\s+/gu, " ");
  if (!expression || expression.length > 100 || /\p{Cc}/u.test(expression)) {
    throw new Error("定时表达式格式无效。");
  }
  const fields = expression.split(" ");
  if (fields.length !== FIELD_COUNT) {
    throw new Error("定时表达式必须包含 5 个字段：分 时 日 月 星期。");
  }
  const parsed = fields.map((field, index) =>
    parseCronField(field, FIELD_DEFINITIONS[index]),
  );
  return {
    expression,
    minute: parsed[0],
    hour: parsed[1],
    dayOfMonth: parsed[2],
    month: parsed[3],
    dayOfWeek: parsed[4],
  };
}

export function matchesParsedCronSchedule(
  schedule: ParsedCronSchedule,
  date: Date,
): boolean {
  if (Number.isNaN(date.getTime())) {
    return false;
  }
  if (
    !schedule.minute.values.has(date.getMinutes()) ||
    !schedule.hour.values.has(date.getHours()) ||
    !schedule.month.values.has(date.getMonth() + 1)
  ) {
    return false;
  }

  const dayOfMonthMatches = schedule.dayOfMonth.values.has(date.getDate());
  const dayOfWeekMatches = schedule.dayOfWeek.values.has(date.getDay());
  // Vixie cron: if either day field starts with "*", both must match (a plain
  // "*" contains every value, so this reduces to the other field). Only when
  // both are restricted can either one select the day.
  if (schedule.dayOfMonth.wildcard || schedule.dayOfWeek.wildcard) {
    return dayOfMonthMatches && dayOfWeekMatches;
  }
  return dayOfMonthMatches || dayOfWeekMatches;
}

export function matchesCronSchedule(expression: string, date: Date): boolean {
  return matchesParsedCronSchedule(parseCronSchedule(expression), date);
}
