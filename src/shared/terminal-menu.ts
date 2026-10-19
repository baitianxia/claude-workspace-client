const NUMBERED_MENU_LINE =
  /^\s*(?:[❯›>│|]\s*)?(\d{1,2})\.[ \t\u00a0]*(.+?)\s*$/u;

/**
 * Extract the latest contiguous numbered menu from visible terminal rows.
 * xterm rows are already plain text, while PTY fallbacks can pass rows after
 * ANSI removal. A menu must start at option 1 and continue without gaps.
 */
export function extractNumberedMenuOptions(
  lines: readonly string[],
): string[] | null {
  for (let start = lines.length - 1; start >= 0; start -= 1) {
    const first = NUMBERED_MENU_LINE.exec(lines[start]);
    if (!first || Number(first[1]) !== 1) {
      continue;
    }
    const options = [first[2].trim()];
    let expected = 2;
    for (let index = start + 1; index < lines.length; index += 1) {
      const match = NUMBERED_MENU_LINE.exec(lines[index]);
      if (!match || Number(match[1]) !== expected) {
        break;
      }
      options.push(match[2].trim());
      expected += 1;
    }
    return options.length > 0 ? options : null;
  }
  return null;
}
