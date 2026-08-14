import type { SessionRecord } from "../shared/contracts";

function timeLabel(now: Date): string {
  const hours = String(now.getHours()).padStart(2, "0");
  const minutes = String(now.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

export function nextSessionTitle(
  existingSessions: SessionRecord[],
  now = new Date(),
): string {
  const usedNumbers = new Set(
    existingSessions
      .map((session) => /^会话 (\d+)(?: · \d{2}:\d{2})?$/u.exec(session.title)?.[1])
      .filter((number): number is string => Boolean(number))
      .map(Number),
  );
  let candidate = 1;
  while (usedNumbers.has(candidate)) {
    candidate += 1;
  }
  return `会话 ${candidate} · ${timeLabel(now)}`;
}
