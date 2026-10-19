// "❯ 1. Yes", "  2. No", "│ ❯ 1. Yes │" (dialog border), "1.Yes" (a cursor
// move removed between the number and the label).
const NUMBERED_MENU_LINE =
  /^(\s*)(?:([❯›>])\s*)?(\d{1,2})\.(?:[ \t ]+|(?=\S))(\S.*?)\s*$/u;
const BORDER_CHARACTERS = /^[\s│┃|]*$/u;
// Separator rows Claude Code draws between regular and extra options.
const SOFT_LINE = /^[\s─━—\-═╌┄┈·.]*$/u;
const CHECKBOX_PREFIX = /^(?:\[[ xX✓✔×*]\]|[☐☑☒◯◉●○])\s*/u;
const MAX_SOFT_LINES = 2;

interface ParsedOption {
  number: number;
  label: string;
  labelColumn: number;
  pointer: boolean;
}

/** Remove a dialog border on either side of a row, keeping inner indentation. */
function withoutBorders(line: string): string {
  let value = line.replace(/\s+$/u, "");
  const leading = /^(\s*)[│┃|]/u.exec(value);
  if (leading) {
    value = value.slice(leading[0].length);
  }
  const trailing = /\s[│┃|]$/u.exec(value);
  if (trailing) {
    value = value.slice(0, -1);
  }
  return value.replace(/\s+$/u, "");
}

function parseOption(line: string): ParsedOption | null {
  const match = NUMBERED_MENU_LINE.exec(line);
  if (!match) {
    return null;
  }
  const label = match[4].replace(CHECKBOX_PREFIX, "").trim();
  if (!label) {
    return null;
  }
  return {
    number: Number(match[3]),
    label,
    // The row was right-trimmed, so the label runs to the end of the row.
    labelColumn: line.trimEnd().length - match[4].length,
    pointer: Boolean(match[2]),
  };
}

function indentation(line: string): number {
  return line.length - line.trimStart().length;
}

function menuStartingAt(rows: string[], start: number): string[] | null {
  const first = parseOption(rows[start]);
  if (!first || first.number !== 1) {
    return null;
  }
  const options = [first];
  let softLines = 0;
  for (let index = start + 1; index < rows.length; index += 1) {
    const row = rows[index];
    const option = parseOption(row);
    if (option) {
      if (option.number !== options.length + 1) {
        break;
      }
      options.push(option);
      softLines = 0;
      continue;
    }
    if (BORDER_CHARACTERS.test(row) || SOFT_LINE.test(row)) {
      softLines += 1;
      if (softLines > MAX_SOFT_LINES) {
        break;
      }
      continue;
    }
    const last = options[options.length - 1];
    // A wrapped label or an option description is indented at least to the
    // label column. Footer hints ("Esc to cancel") start further left. After
    // a blank or separator row only another numbered option may follow.
    if (softLines > 0 || indentation(row) < last.labelColumn) {
      break;
    }
    last.label = `${last.label} ${row.trim()}`;
  }
  // Claude Code marks the focused option with a pointer. A numbered list in
  // Claude's answer has none, so it is never mistaken for a menu.
  if (options.length < 2 || !options.some((option) => option.pointer)) {
    return null;
  }
  return options.map((option) => option.label);
}

/**
 * Extract the menu Claude Code currently shows from terminal rows (xterm
 * rows, or PTY text split into lines after ANSI removal).
 *
 * The latest block that starts at option 1, numbers its options without gaps
 * and marks one of them with Claude Code's focus pointer wins. Wrapped labels
 * and option descriptions are joined to the option they belong to, so a
 * question whose options have descriptions still yields every option.
 */
export function extractNumberedMenuOptions(
  lines: readonly string[],
): string[] | null {
  const rows = lines.map(withoutBorders);
  for (let start = rows.length - 1; start >= 0; start -= 1) {
    const menu = menuStartingAt(rows, start);
    if (menu) {
      return menu;
    }
  }
  return null;
}

function compactLabel(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, "").toLocaleLowerCase("en-US");
}

/**
 * Whether the option label shown in a notification matches the label on
 * screen. Whitespace is ignored (a wrapped CJK label gains a space when its
 * rows are joined), the screen label may carry a description after the label,
 * and Ink may cut a long label with an ellipsis.
 */
export function menuLabelMatches(expected: string, visible: string): boolean {
  const wanted = compactLabel(expected);
  const shown = compactLabel(visible);
  if (!wanted) {
    return true;
  }
  if (shown.startsWith(wanted)) {
    return true;
  }
  const truncated = /(?:…|\.\.\.)$/u.exec(shown);
  if (truncated) {
    const prefix = shown.slice(0, -truncated[0].length);
    return prefix.length >= 4 && wanted.startsWith(prefix);
  }
  return false;
}

function withoutEllipsis(value: string): { text: string; truncated: boolean } {
  const match = /(?:…|\.\.\.)$/u.exec(value);
  return match
    ? { text: value.slice(0, -match[0].length), truncated: true }
    : { text: value, truncated: false };
}

/**
 * Whether two labels read from the screen name the same option. Used when a
 * notification was built from the rendered menu: the label must be the same,
 * not merely start the same way ("allow access" vs "allow access to X").
 */
export function menuLabelsEqual(left: string, right: string): boolean {
  const a = withoutEllipsis(compactLabel(left));
  const b = withoutEllipsis(compactLabel(right));
  if (a.text === b.text) {
    return true;
  }
  if (a.truncated && a.text.length >= 4 && b.text.startsWith(a.text)) {
    return true;
  }
  return b.truncated && b.text.length >= 4 && a.text.startsWith(b.text);
}
