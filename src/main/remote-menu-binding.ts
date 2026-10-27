import {
  menuLabelMatches,
  menuLabelsEqual,
  type VisibleMenu,
  type VisibleMenuOption,
} from "../shared/terminal-menu";
import type {
  PendingRemoteReply,
  RemoteReplyStage,
} from "./remote-reply-router";

/**
 * Late binding of a remote reply to the menu Claude Code shows right now.
 *
 * A WeCom notification describes the menu as the Hook payload (or an earlier
 * screen) made it look. The menu actually drawn can differ: Claude Code adds
 * rows the Hook does not describe ("Yes, and enable auto mode", "Chat about
 * this"), drops rows depending on the question type and version, and the
 * owner may have moved the focus pointer locally. Position-based keystrokes
 * are therefore computed here, at reply time, from the visible menu:
 *
 * - permission menus are bound by role: the first row is always "allow once"
 *   and the last row is always "deny", whatever else Claude Code inserted in
 *   between; a middle row is only taken when both sides agree on the shape;
 * - question menus are bound by option label, with the free-text and
 *   "Chat about this" rows recognised by their well-known labels;
 * - everything else is bound by position with a confirmation when the
 *   notification and the screen disagree.
 *
 * Nothing here writes to the terminal. The caller navigates to the bound
 * row, verifies the pointer landed on it, and only then presses Enter.
 */

/** A screen row the reply resolved to (0-based index into menu.options). */
export interface BoundMenuRow {
  index: number;
  label: string;
}

export type MenuBinding =
  | { status: "bound"; rows: BoundMenuRow[] }
  /**
   * The wanted row is not visible but Claude Code may draw it as an
   * unnumbered row below the numbered ones (its "Chat about this" preview
   * layout). The caller moves the pointer one row past the last visible row
   * and accepts only if the focused row then carries one of the labels.
   */
  | { status: "probe"; fromIndex: number; acceptLabels: readonly string[] }
  /** Needs the user's explicit "确认 N" after seeing the real menu. */
  | { status: "confirm"; reason: string }
  /** Cannot be executed; the user must choose again. */
  | { status: "reject"; reason: string }
  /** The chosen row only opens a text field; ask for the text instead. */
  | { status: "text-hint"; reason: string };

const ALLOW_LABEL = /^(?:yes|allow|是|允许|同意)/iu;
const DENY_LABEL = /^(?:no\b|no,|deny|don['’]t|否|不|拒绝)/iu;

const OTHER_ROW_LABELS = [
  "type something",
  "type something.",
  "type something…",
  "other",
  "输入其他回答",
  "其他",
];
const CHAT_ROW_LABELS = ["chat about this", "与 claude 讨论这个问题", "与claude讨论"];

function compact(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, "").toLocaleLowerCase("en-US");
}

function labelStartsWithAny(label: string, candidates: readonly string[]): boolean {
  const shown = compact(label);
  return candidates.some((candidate) => shown.startsWith(compact(candidate)));
}

export function isFreeTextRow(label: string): boolean {
  return labelStartsWithAny(label, OTHER_ROW_LABELS);
}

export function isChatRow(label: string): boolean {
  return labelStartsWithAny(label, CHAT_ROW_LABELS);
}

export function looksLikeAllowRow(label: string): boolean {
  return ALLOW_LABEL.test(label.trim());
}

export function looksLikeDenyRow(label: string): boolean {
  return DENY_LABEL.test(label.trim());
}

/** The numbered rows of a menu; unnumbered rows never take part in counts. */
function numberedRows(menu: VisibleMenu): VisibleMenuOption[] {
  return menu.options.filter((option) => option.number !== null);
}

function row(menu: VisibleMenu, index: number): BoundMenuRow {
  return { index, label: menu.options[index].label };
}

/**
 * Render the visible menu for a WeCom reply so the user sees what the
 * terminal really shows before choosing again.
 */
export function describeVisibleMenu(menu: VisibleMenu | null): string {
  if (!menu) {
    return "终端当前没有可识别的菜单。";
  }
  const lines = menu.options.map((option, index) => {
    const marker = index === menu.pointerIndex ? "❯" : " ";
    const number = option.number === null ? "·" : `${option.number}.`;
    return `${marker} ${number} ${option.label}`;
  });
  return `终端当前菜单：\n${lines.join("\n")}`;
}

/** Guidance appended to confirm/reject replies. */
export const MENU_RECOVERY_HINT =
  "回复「确认 N」选择终端第 N 项，或直接回复终端上的选项文字；回复「菜单」可重新查看。";

/**
 * Whether the screen shows this request. Returns null when the pending reply
 * carries nothing to check; otherwise true when at least one probe (the start
 * of the command, a host, a file name) appears in the visible rows.
 */
/**
 * A command is probed by its whole first line up to this length. Only a
 * command longer than this is cut, and then the dialog itself continues
 * after the probe, so no token boundary can be required for it.
 */
export const IDENTITY_PROBE_PREFIX_LENGTH = 160;
// A wrapped command spans at most this many consecutive rows for matching.
const MAX_WRAPPED_ROWS = 6;

const PROBE_WORD = /[\p{L}\p{N}_.\-]/u;
const BOX_DRAWING = /[\u2500-\u257f]/gu;

function normalizeProbeText(value: string): string {
  return value
    .replace(BOX_DRAWING, " ")
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim()
    .toLocaleLowerCase("en-US");
}

/** Whether `needle` occurs in `haystack` as a whole token. */
function containsToken(haystack: string, needle: string): boolean {
  let from = 0;
  for (;;) {
    const index = haystack.indexOf(needle, from);
    if (index < 0) {
      return false;
    }
    const before = index > 0 ? haystack[index - 1] : "";
    const after = haystack[index + needle.length] ?? "";
    // "npm test --foo" must not pass for "npm test --foobar".
    if (!PROBE_WORD.test(before) && !PROBE_WORD.test(after)) {
      return true;
    }
    from = index + 1;
  }
}

/**
 * Whether the probe appears as a whole token on one row, or across a few
 * consecutive rows (a wrapped command: the dialog breaks it at a space or
 * mid-token, so both joins are tried).
 */
function rowsContainToken(lines: readonly string[], probe: string): boolean {
  const needle = normalizeProbeText(probe);
  if (!needle) {
    return false;
  }
  const rows = lines.map(normalizeProbeText);
  for (let start = 0; start < rows.length; start += 1) {
    if (!rows[start]) {
      continue;
    }
    for (let span = 1; span <= MAX_WRAPPED_ROWS && start + span <= rows.length; span += 1) {
      const window = rows.slice(start, start + span);
      if (containsToken(window.join(" "), needle) || containsToken(window.join(""), needle)) {
        return true;
      }
    }
  }
  return false;
}

export function screenShowsRequest(
  pending: Pick<PendingRemoteReply, "identityProbes">,
  lines: readonly string[],
): boolean | null {
  const probes = (pending.identityProbes ?? []).filter(
    (probe) => compact(probe).length >= 3,
  );
  if (probes.length === 0) {
    return null;
  }
  return probes.some((probe) => {
    if (probe.length >= IDENTITY_PROBE_PREFIX_LENGTH) {
      // The start of a very long command: the text legitimately continues
      // after it, so only its presence (ignoring wrapping) can be checked.
      const screen = compact(lines.join("\n")).replace(BOX_DRAWING, "");
      return screen.includes(compact(probe));
    }
    return rowsContainToken(lines, probe);
  });
}

function permissionOptionCount(
  pending: Pick<
    PendingRemoteReply,
    "permissionOptionLabels" | "permissionSuggestionCount"
  >,
): number {
  const labels = pending.permissionOptionLabels;
  if (labels && labels.length >= 2) {
    return labels.length;
  }
  return Math.max(0, Math.floor(pending.permissionSuggestionCount ?? 0)) + 2;
}

/**
 * Bind a permission reply. `selection` is the 1-based row of the
 * notification's menu (allow once, optional persistent-allow rows, deny).
 */
export function bindPermissionSelection(
  pending: PendingRemoteReply,
  selection: number,
  menu: VisibleMenu,
): MenuBinding {
  const rows = numberedRows(menu);
  if (rows.length < 2) {
    return { status: "reject", reason: "终端当前没有可识别的权限菜单" };
  }
  const first = rows[0];
  const last = rows[rows.length - 1];
  if (!looksLikeAllowRow(first.label) || !looksLikeDenyRow(last.label)) {
    return {
      status: "reject",
      reason: "终端当前显示的菜单不是权限对话框（首项应为允许、末项应为拒绝）",
    };
  }
  const optionCount = permissionOptionCount(pending);
  if (selection < 1 || selection > optionCount) {
    return { status: "reject", reason: `权限选项编号应在 1-${optionCount} 之间` };
  }
  // The first and last rows keep their meaning in every Claude Code layout.
  if (selection === 1) {
    return { status: "bound", rows: [row(menu, 0)] };
  }
  if (selection === optionCount) {
    return { status: "bound", rows: [row(menu, rows.length - 1)] };
  }
  // A middle row (a persistent allow) is only safe when both sides agree on
  // the shape of the menu, and, when the notification was built from the
  // screen, on the text of that row.
  if (rows.length !== optionCount) {
    return {
      status: "confirm",
      reason: `通知中的权限菜单有 ${optionCount} 项，终端当前有 ${rows.length} 项，第 ${selection} 项的含义可能不同`,
    };
  }
  const expected = pending.permissionOptionLabels?.[selection - 1];
  if (
    pending.permissionMenuSource === "rendered" &&
    expected &&
    !menuLabelsEqual(expected, rows[selection - 1].label)
  ) {
    return {
      status: "confirm",
      reason: `终端当前第 ${selection} 项是“${rows[selection - 1].label}”，与通知中的“${expected}”不同`,
    };
  }
  return { status: "bound", rows: [row(menu, selection - 1)] };
}

function uniqueLabelRow(
  menu: VisibleMenu,
  label: string,
  preferredIndex: number,
): number | null {
  const matches = menu.options.flatMap((option, index) =>
    option.number !== null && menuLabelMatches(label, option.label) ? [index] : [],
  );
  if (matches.length === 0) {
    return null;
  }
  if (matches.length === 1) {
    return matches[0];
  }
  return matches.includes(preferredIndex) ? preferredIndex : matches[0];
}

/**
 * Bind the answer to a single AskUserQuestion. `selections` are 1-based rows
 * of the notification: 1..n are Claude's options, n+1 the free-text row and
 * n+2 (single-select only) "Chat about this".
 */
export function bindQuestionSelections(
  pending: PendingRemoteReply,
  selections: readonly number[],
  menu: VisibleMenu,
): MenuBinding {
  const labels = pending.questionOptionLabels?.[0] ?? [];
  const multiple = pending.questionSelectionModes?.[0] === "multiple";
  if (menu.options.length < 2) {
    return { status: "reject", reason: "终端当前没有可识别的问题菜单" };
  }
  // Identity: every option Claude asked about must be on screen.
  const missing = labels.filter(
    (label) => !menu.options.some((option) => menuLabelMatches(label, option.label)),
  );
  if (missing.length > 0) {
    return {
      status: "reject",
      reason: `终端当前菜单中没有通知里的选项“${missing[0]}”，这条通知可能已失效`,
    };
  }
  const bound: BoundMenuRow[] = [];
  for (const selection of selections) {
    if (selection >= 1 && selection <= labels.length) {
      const index = uniqueLabelRow(menu, labels[selection - 1], selection - 1);
      if (index === null) {
        return {
          status: "reject",
          reason: `终端当前菜单中没有选项“${labels[selection - 1]}”`,
        };
      }
      bound.push(row(menu, index));
      continue;
    }
    if (selection === labels.length + 1) {
      const index = menu.options.findIndex((option) => isFreeTextRow(option.label));
      if (index < 0) {
        return {
          status: "reject",
          reason: "终端当前的问题没有“输入其他回答”项，只能从列出的选项中选择",
        };
      }
      bound.push(row(menu, index));
      continue;
    }
    if (!multiple && selection === labels.length + 2) {
      const index = menu.options.findIndex((option) => isChatRow(option.label));
      if (index >= 0) {
        bound.push(row(menu, index));
        continue;
      }
      // Not visible as a row: Claude Code may draw it unnumbered and without
      // a pointer below the list. Let the caller probe for it.
      if (bound.length === 0 && selections.length === 1) {
        return {
          status: "probe",
          fromIndex: menu.options.length - 1,
          acceptLabels: CHAT_ROW_LABELS,
        };
      }
      return {
        status: "reject",
        reason: "终端当前的问题没有“与 Claude 讨论这个问题”项",
      };
    }
    return {
      status: "reject",
      reason: `问题选项编号 ${selection} 超出了通知中的范围`,
    };
  }
  if (bound.length === 0) {
    return { status: "reject", reason: "没有可执行的选项" };
  }
  return { status: "bound", rows: bound };
}

/**
 * Bind a reply to a menu the notification could not describe (plan approval
 * and other generic menus): by position, checked against the labels that
 * were on screen when the notification was built, if any.
 */
export function bindPositionalSelection(
  pending: Pick<PendingRemoteReply, "renderedMenuLabels">,
  selection: number,
  menu: VisibleMenu,
): MenuBinding {
  const rows = numberedRows(menu);
  if (selection < 1 || selection > rows.length) {
    return {
      status: "reject",
      reason: `终端当前菜单只有 ${rows.length} 项，没有第 ${selection} 项`,
    };
  }
  const expected = pending.renderedMenuLabels?.[selection - 1];
  if (expected && !menuLabelsEqual(expected, rows[selection - 1].label)) {
    return {
      status: "confirm",
      reason: `终端当前第 ${selection} 项是“${rows[selection - 1].label}”，与通知中的“${expected}”不同`,
    };
  }
  return { status: "bound", rows: [row(menu, selection - 1)] };
}

/**
 * Bind a number that lies outside the notification's menu. The screen may
 * legitimately have that row (Claude Code added one). A row that only opens
 * a text field is harmless and gets a hint; anything else needs an explicit
 * confirmation because the user never saw its text.
 */
export function bindOutOfRangeSelection(
  selection: number,
  menu: VisibleMenu | null,
): MenuBinding {
  const rows = menu ? numberedRows(menu) : [];
  const target = rows[selection - 1];
  if (!menu || !target) {
    return {
      status: "reject",
      reason: `通知和终端上都没有第 ${selection} 项`,
    };
  }
  if (isFreeTextRow(target.label)) {
    return {
      status: "text-hint",
      reason: `终端第 ${selection} 项是“${target.label}”（自由回答），请直接回复「其他：你的内容」`,
    };
  }
  if (isChatRow(target.label)) {
    return {
      status: "text-hint",
      reason: `终端第 ${selection} 项是“${target.label}”，请直接回复「讨论：你想说的内容」`,
    };
  }
  return {
    status: "confirm",
    reason: `第 ${selection} 项不在通知中；终端上第 ${selection} 项是“${target.label}”`,
  };
}

/** Bind an explicit "确认 N" to the N-th numbered row on screen. */
export function bindConfirmedRow(
  selection: number,
  menu: VisibleMenu,
): MenuBinding {
  const rows = numberedRows(menu);
  if (selection < 1 || selection > rows.length) {
    return {
      status: "reject",
      reason: `终端当前菜单只有 ${rows.length} 项，没有第 ${selection} 项`,
    };
  }
  return { status: "bound", rows: [row(menu, selection - 1)] };
}

/**
 * Bind a reply given as the text of an option (any kind of menu). The text
 * must match exactly one numbered row.
 */
export function bindRowByText(
  text: string,
  menu: VisibleMenu,
): MenuBinding {
  const wanted = compact(text);
  if (!wanted) {
    return { status: "reject", reason: "回复内容为空" };
  }
  const exact = menu.options.flatMap((option, index) =>
    compact(option.label) === wanted ? [index] : [],
  );
  const candidates =
    exact.length > 0
      ? exact
      : menu.options.flatMap((option, index) =>
          menuLabelMatches(text, option.label) ? [index] : [],
        );
  if (candidates.length === 1) {
    return { status: "bound", rows: [row(menu, candidates[0])] };
  }
  if (candidates.length > 1) {
    return { status: "reject", reason: "有多个选项与回复文字匹配，请改用「确认 N」" };
  }
  return { status: "reject", reason: "终端当前菜单中没有与回复文字匹配的选项" };
}

/**
 * The follow-up stage a bound row leads to: denying a permission asks for a
 * reason, the free-text and chat rows ask for text.
 */
export function stageForBoundRow(
  pending: Pick<PendingRemoteReply, "kind">,
  bound: BoundMenuRow,
  menu: VisibleMenu,
): RemoteReplyStage | null {
  if (pending.kind === "permission") {
    const rows = numberedRows(menu);
    const lastNumbered = menu.options.lastIndexOf(rows[rows.length - 1]);
    return bound.index === lastNumbered && looksLikeDenyRow(bound.label)
      ? "permission-denial-reason"
      : null;
  }
  if (isFreeTextRow(bound.label)) {
    return "question-custom-answer";
  }
  if (isChatRow(bound.label)) {
    return "question-chat-message";
  }
  return null;
}

export function followUpMessageForStage(stage: RemoteReplyStage): string {
  switch (stage) {
    case "permission-denial-reason":
      return "已选择拒绝。请继续回复拒绝原因，或告诉 Claude Code 应该如何调整。";
    case "question-custom-answer":
      return "已选择“输入其他回答（Type something.）”。请继续回复你的具体答案。";
    case "question-chat-message":
      return "已选择“与 Claude 讨论这个问题（Chat about this）”。请继续回复你想讨论或补充的内容。";
    case "plan-feedback":
      return "已选择退回计划。请继续回复需要修改的地方。";
  }
}
