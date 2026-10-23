import { randomBytes } from "node:crypto";
import { stripAnsi } from "./claude-session-files";
import {
  extractNumberedMenuOptions,
  menuLabelMatches,
  menuLabelsEqual,
} from "../shared/terminal-menu";

const DEFAULT_PENDING_TTL_MS = 24 * 60 * 60 * 1_000;
const ROUTE_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const ROUTE_CODE_LENGTH = 8;
const TERMINAL_DOWN = "\x1b[B";
const TERMINAL_TAB = "\t";
const TERMINAL_ENTER = "\r";
const TERMINAL_TOGGLE = " ";

export type RemoteAttentionKind =
  | "permission"
  | "question"
  | "plan"
  | "completion"
  | "idle"
  | "elicitation"
  | "agent";

export type RemoteInputMode = "menu" | "text" | "none";

export type RemoteReplyStage =
  | "permission-denial-reason"
  | "question-custom-answer"
  | "question-chat-message"
  /** A plan was turned down through its Hook; the feedback text follows. */
  | "plan-feedback";

export interface RemoteAttention {
  workspaceSessionId: string;
  launchId: string;
  claudeSessionId: string;
  kind: RemoteAttentionKind;
  title: string;
  body: string;
  inputMode: RemoteInputMode;
  supportsMultipleSelection?: boolean;
  questionSelectionModes?: Array<"single" | "multiple">;
  questionOptionLabels?: string[][];
  permissionOptionLabels?: string[];
  permissionMenuSource?: "hook" | "rendered";
  permissionMenuSequence?: number;
  permissionSuggestionCount?: number;
  /**
   * Short pieces of text Claude Code prints in the dialog for this request
   * (the start of a command, a URL host, a file name). Before keys are
   * written, the screen must show one of them: otherwise the dialog on
   * screen belongs to a different request than the notification.
   */
  identityProbes?: string[];
  /**
   * Labels of a menu that was read from the screen when the notification
   * was built, for prompts whose Hook payload does not describe the menu
   * (plan approval). Replies are checked against them.
   */
  renderedMenuLabels?: string[];
}

export interface PendingRemoteReply extends RemoteAttention {
  code: string;
  userId: string;
  createdAt: number;
  fingerprint: string;
  replyStage?: RemoteReplyStage;
}

export interface RemoteReplyAction {
  input: string;
  /**
   * Synthetic key presses that must be written separately. Ink-based Claude
   * Code prompts can consume only the first escape sequence when several
   * navigation keys are batched into one PTY write.
   */
  inputChunks?: string[];
  nextStage?: RemoteReplyStage;
  followUpMessage?: string;
  /** 1-based menu options the keystrokes will select, for screen checks. */
  menuSelections?: number[];
  /**
   * Text the user supplied together with a choice that opens a text field
   * ("其他：内容", "讨论：内容"). It is written after the field appears, so
   * the user does not have to send a second message.
   */
  inlineFollowUp?: string;
}

const QUESTION_FREE_TEXT_KEYWORD =
  /^(?:其他|其它|自由回答|其他回答|other|type\s*something)\s*[：:]\s*([\s\S]+)$/iu;
const QUESTION_CHAT_KEYWORD =
  /^(?:讨论|与\s*claude\s*讨论|chat|chat\s*about\s*this)\s*[：:]\s*([\s\S]+)$/iu;

/**
 * "其他：内容" / "讨论：内容" replies to a question: which extra row they
 * mean and the text that follows the keyword.
 */
export function questionKeywordReply(
  reply: string,
): { row: "free-text" | "chat"; content: string } | null {
  const trimmed = reply.trim();
  const freeText = QUESTION_FREE_TEXT_KEYWORD.exec(trimmed);
  if (freeText) {
    const content = freeText[1].trim();
    return content ? { row: "free-text", content } : null;
  }
  const chat = QUESTION_CHAT_KEYWORD.exec(trimmed);
  if (chat) {
    const content = chat[1].trim();
    return content ? { row: "chat", content } : null;
  }
  return null;
}

export type RegisterPendingResult =
  | { shouldSend: true; pending: PendingRemoteReply }
  | { shouldSend: false; pending: PendingRemoteReply };

export type ResolveRemoteReplyResult =
  | {
      status: "matched";
      pending: PendingRemoteReply;
      reply: string;
    }
  | {
      status: "rejected";
      message: string;
    };

function defaultCodeGenerator(): string {
  const bytes = randomBytes(ROUTE_CODE_LENGTH);
  let result = "";
  for (const byte of bytes) {
    result += ROUTE_CODE_ALPHABET[byte % ROUTE_CODE_ALPHABET.length];
  }
  return result;
}

function attentionFingerprint(attention: RemoteAttention): string {
  return [
    attention.workspaceSessionId,
    attention.launchId,
    attention.claudeSessionId,
    attention.kind,
    attention.title,
    attention.body,
    attention.inputMode,
    attention.supportsMultipleSelection ? "multiple" : "single",
    JSON.stringify(attention.questionSelectionModes ?? []),
    JSON.stringify(attention.questionOptionLabels ?? []),
    JSON.stringify(attention.permissionOptionLabels ?? []),
    attention.permissionMenuSource ?? "",
    attention.permissionSuggestionCount ?? 0,
  ].join("\u0000");
}

function normalizedReplyText(value: string): string {
  return value
    .replace(/[\r\n\t]+/gu, " ")
    .replace(/\p{Cc}/gu, "")
    .trim();
}

function normalizedReplyForPending(
  value: string,
  pending: PendingRemoteReply,
): string {
  if (
    pending.kind === "question" &&
    (pending.questionSelectionModes?.length ?? 0) > 1
  ) {
    return value
      .replace(/(?:\r\n?|\n)+/gu, ";")
      .replace(/\t+/gu, " ")
      .replace(/\p{Cc}/gu, "")
      .trim();
  }
  return normalizedReplyText(value);
}

function routeCodeAtStart(value: string): string | null {
  const match = /^(?:#|\[|`)?([A-Z2-9]{5,8})(?=$|[\s\]`：:])/iu.exec(
    value,
  );
  return match?.[1].toUpperCase() ?? null;
}

function routeCodesFromQuotedNotification(value: string): string[] {
  return [
    ...value.matchAll(
      /回复码\s*[：:]?\s*(?:#|\[|`)?([A-Z2-9]{5,8})(?=$|[\s\]`：:])/giu,
    ),
  ].map((match) => match[1].toUpperCase());
}

function replyWithoutCode(value: string, code: string): string {
  return value.replace(
    new RegExp(
      `^\\s*(?:#|\\[|\\x60)?${code}(?:\\]|\\x60)?(?:\\s*[：:])?\\s*`,
      "iu",
    ),
    "",
  );
}

// Claude Code's terminal menus display numbered options, but their default
// controls are arrow keys plus Enter (and Space to toggle multi-select items).
function singleMenuSelectionInput(selection: number): string {
  return `${TERMINAL_DOWN.repeat(selection - 1)}${TERMINAL_ENTER}`;
}

function multipleMenuSelectionInput(selections: number[]): string {
  const ordered = [...new Set(selections)].sort((left, right) => left - right);
  let currentSelection = 1;
  let input = "";
  for (const selection of ordered) {
    input += TERMINAL_DOWN.repeat(selection - currentSelection);
    input += TERMINAL_TOGGLE;
    currentSelection = selection;
  }
  return `${input}${TERMINAL_ENTER}`;
}

function singleMenuSelectionChunks(selection: number): string[] {
  return [
    ...Array.from({ length: Math.max(0, selection - 1) }, () => TERMINAL_DOWN),
    TERMINAL_ENTER,
  ];
}

function multipleMenuSelectionChunks(selections: number[]): string[] {
  const ordered = [...new Set(selections)].sort((left, right) => left - right);
  let currentSelection = 1;
  const chunks: string[] = [];
  for (const selection of ordered) {
    chunks.push(
      ...Array.from(
        { length: Math.max(0, selection - currentSelection) },
        () => TERMINAL_DOWN,
      ),
    );
    chunks.push(TERMINAL_TOGGLE);
    currentSelection = selection;
  }
  chunks.push(TERMINAL_ENTER);
  return chunks;
}

type MenuActionExtras = Pick<
  RemoteReplyAction,
  "nextStage" | "followUpMessage" | "inlineFollowUp"
>;

function menuAction(
  input: string,
  inputChunks: string[],
  extras: MenuActionExtras = {},
): RemoteReplyAction {
  return {
    input,
    ...(inputChunks.length > 1 ? { inputChunks } : {}),
    ...extras,
  };
}

function permissionMenuShape(pending: PendingRemoteReply): {
  optionCount: number;
  suggestionCount: number;
} {
  // permissionOptionLabels is the menu shape represented in the notification.
  // Keep the legacy count only for older pending entries that predate the
  // labels field; raw permission_suggestions is not a menu shape.
  const labels = pending.permissionOptionLabels;
  if (labels && labels.length >= 2) {
    return {
      optionCount: labels.length,
      suggestionCount: labels.length - 2,
    };
  }
  const suggestionCount = Math.max(
    0,
    Math.floor(pending.permissionSuggestionCount ?? 0),
  );
  return { optionCount: suggestionCount + 2, suggestionCount };
}

function singleMenuAction(
  selection: number,
  extras: MenuActionExtras = {},
): RemoteReplyAction {
  return {
    ...menuAction(
      singleMenuSelectionInput(selection),
      singleMenuSelectionChunks(selection),
      extras,
    ),
    menuSelections: [selection],
  };
}

function multipleMenuAction(selections: number[]): RemoteReplyAction {
  return {
    ...menuAction(
      multipleMenuSelectionInput(selections),
      multipleMenuSelectionChunks(selections),
    ),
    menuSelections: [...selections],
  };
}

/**
 * Claude Code's multi-question AskUserQuestion wizard is a different menu
 * from the ordinary one-question picker. A digit selects the option and
 * advances to the next question, so using Down/Enter here can select a stale
 * pointer after the wizard rerenders.
 */
function wizardSingleSelectionInput(selection: number): string {
  return String(selection);
}

function wizardSingleSelectionChunks(selection: number): string[] {
  return [wizardSingleSelectionInput(selection)];
}

/**
 * In a wizard multi-select question, digits toggle options without advancing.
 * Tab moves to the next question (or the Submit review), and the final Enter
 * is emitted by the caller after all questions have been answered.
 */
function wizardMultipleSelectionInput(selections: number[]): string {
  return `${[...new Set(selections)]
    .sort((left, right) => left - right)
    .map(String)
    .join("")}${TERMINAL_TAB}`;
}

function wizardMultipleSelectionChunks(selections: number[]): string[] {
  return [
    ...[...new Set(selections)]
      .sort((left, right) => left - right)
      .map(String),
    TERMINAL_TAB,
  ];
}

type MenuTextMatch =
  | { status: "matched"; selection: number }
  | { status: "not-found" }
  | { status: "ambiguous" };

function normalizedChoiceText(value: string): string {
  return normalizedReplyText(value)
    .normalize("NFKC")
    .replace(/\s*\(\s*esc\s*\)\s*$/iu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .toLocaleLowerCase("en-US");
}

const QUESTION_CUSTOM_CHOICE_ALIASES = new Set(
  [
    "输入其他回答",
    "输入其他回答（Type something.）",
    "Type something",
    "Type something.",
  ].map(normalizedChoiceText),
);

const QUESTION_CHAT_CHOICE_ALIASES = new Set(
  [
    "与 Claude 讨论这个问题",
    "与 Claude 讨论这个问题（Chat about this）",
    "Chat about this",
  ].map(normalizedChoiceText),
);

function menuTextMatch(value: string, labels: string[]): MenuTextMatch {
  const candidate = normalizedChoiceText(value);
  if (!candidate) {
    return { status: "not-found" };
  }
  const selections = labels.flatMap((label, index) =>
    normalizedChoiceText(label) === candidate ? [index + 1] : [],
  );
  if (selections.length === 1) {
    return { status: "matched", selection: selections[0] };
  }
  return { status: selections.length > 1 ? "ambiguous" : "not-found" };
}

function validNumberedSelection(
  value: string,
  optionCount: number,
): number | null {
  if (!/^[1-9][0-9]*$/u.test(value)) {
    return null;
  }
  const selection = Number(value);
  return selection <= optionCount ? selection : null;
}

/**
 * The 1-based options an answer to one question names, by number or by
 * label (comma-separated for several), or null when it names none.
 */
export function questionSelectionsForLabels(
  answer: string,
  labels: string[],
): number[] | null {
  return questionSelections(answer, labels);
}

function questionSelections(
  answer: string,
  labels: string[],
): number[] | null {
  const normalizedAnswer = normalizedChoiceText(answer);
  const wholeNumericSelection = validNumberedSelection(
    normalizedAnswer,
    labels.length,
  );
  if (wholeNumericSelection !== null) {
    return [wholeNumericSelection];
  }
  if (/^[0-9]+$/u.test(normalizedAnswer)) {
    return null;
  }
  const wholeLabelMatch = menuTextMatch(answer, labels);
  if (wholeLabelMatch.status === "matched") {
    return [wholeLabelMatch.selection];
  }
  if (wholeLabelMatch.status === "ambiguous") {
    return null;
  }
  const values = answer.split(/\s*[,，]\s*/u);
  const selections = values.map((value) => {
    const normalizedValue = normalizedChoiceText(value);
    const numeric = validNumberedSelection(
      normalizedValue,
      labels.length,
    );
    if (numeric !== null) {
      return numeric;
    }
    if (/^[0-9]+$/u.test(normalizedValue)) {
      return null;
    }
    const match = menuTextMatch(value, labels);
    return match.status === "matched" ? match.selection : null;
  });
  return selections.every(
    (selection): selection is number =>
      selection !== null && selection >= 1 && selection <= labels.length,
  )
    ? selections
    : null;
}

export class RemoteReplyRouter {
  private readonly pendingByCode = new Map<string, PendingRemoteReply>();
  private readonly codeByWorkspaceSession = new Map<string, string>();

  constructor(
    private readonly codeGenerator: () => string = defaultCodeGenerator,
    private readonly now: () => number = Date.now,
    private readonly pendingTtlMs = DEFAULT_PENDING_TTL_MS,
  ) {}

  register(userId: string, attention: RemoteAttention): RegisterPendingResult {
    this.expireOldEntries();
    const existingCode = this.codeByWorkspaceSession.get(
      attention.workspaceSessionId,
    );
    const existing = existingCode
      ? this.pendingByCode.get(existingCode)
      : undefined;
    const fingerprint = attentionFingerprint(attention);

    if (existing) {
      // A generic permission notification has no menu metadata. It must not
      // invalidate a detailed permission/question/plan prompt for this launch.
      if (
        attention.inputMode === "none" &&
        existing.inputMode === "menu" &&
        existing.launchId === attention.launchId &&
        existing.claudeSessionId === attention.claudeSessionId
      ) {
        return { shouldSend: false, pending: { ...existing } };
      }
      if (
        (attention.kind === "idle" && existing.kind !== "idle") ||
        existing.fingerprint === fingerprint
      ) {
        return { shouldSend: false, pending: { ...existing } };
      }
      this.remove(existing.code);
    }

    const code = this.nextUniqueCode();
    const pending: PendingRemoteReply = {
      ...attention,
      code,
      userId,
      createdAt: this.now(),
      fingerprint,
    };
    this.pendingByCode.set(code, pending);
    this.codeByWorkspaceSession.set(attention.workspaceSessionId, code);
    return { shouldSend: true, pending: { ...pending } };
  }

  resolve(
    userId: string,
    messageText: string,
    quotedText = "",
  ): ResolveRemoteReplyResult {
    this.expireOldEntries();
    const content = normalizedReplyText(messageText);
    const codeFromMessage = routeCodeAtStart(content);
    const codeFromQuote = routeCodesFromQuotedNotification(quotedText).find(
      (candidate) => {
        const pending = this.pendingByCode.get(candidate);
        return pending?.userId === userId;
      },
    );
    const quotedTitleMatches = codeFromQuote
      ? []
      : [...this.pendingByCode.values()].filter(
          (pending) =>
            pending.userId === userId &&
            quotedText.trim().length > 0 &&
            quotedText.includes(pending.title),
        );
    const codeFromUniqueQuotedTitle =
      quotedTitleMatches.length === 1 ? quotedTitleMatches[0].code : null;
    const code = codeFromMessage ?? codeFromQuote ?? codeFromUniqueQuotedTitle;

    if (!code) {
      return {
        status: "rejected",
        message:
          "未找到回复码。该机器人只处理 Claude Code 终端通知；请引用通知回复，或按“回复码 回复内容”的格式发送。私人助理消息请发送到助理绑定的独立机器人。" +
          this.pendingSummary(userId),
      };
    }

    const pending = this.pendingByCode.get(code);
    if (!pending || pending.userId !== userId) {
      return {
        status: "rejected",
        message: `回复码 ${code} 不存在或已过期。${this.pendingSummary(userId)}`,
      };
    }

    const reply = normalizedReplyForPending(
      codeFromMessage ? replyWithoutCode(messageText, code) : messageText,
      pending,
    );
    if (!reply) {
      return {
        status: "rejected",
        message: `回复码 ${code} 后缺少回复内容。`,
      };
    }
    if ([...reply].length > 4_000) {
      return {
        status: "rejected",
        message: "回复内容不能超过 4,000 个字符。",
      };
    }

    return { status: "matched", pending: { ...pending }, reply };
  }

  complete(code: string): void {
    this.remove(code.toUpperCase());
  }

  setReplyStage(code: string, replyStage: RemoteReplyStage): boolean {
    const pending = this.pendingByCode.get(code.toUpperCase());
    if (!pending) {
      return false;
    }
    pending.replyStage = replyStage;
    return true;
  }

  clearWorkspaceSession(workspaceSessionId: string): string | null {
    const code = this.codeByWorkspaceSession.get(workspaceSessionId);
    if (code) {
      this.remove(code);
      return code;
    }
    return null;
  }

  clearAll(): void {
    this.pendingByCode.clear();
    this.codeByWorkspaceSession.clear();
  }

  listForUser(userId: string): PendingRemoteReply[] {
    this.expireOldEntries();
    return [...this.pendingByCode.values()]
      .filter((pending) => pending.userId === userId)
      .sort((left, right) => left.createdAt - right.createdAt)
      .map((pending) => ({ ...pending }));
  }

  private pendingSummary(userId: string): string {
    const entries = this.listForUser(userId).filter((entry) => entry.inputMode !== "none");
    if (entries.length === 0) {
      return " 当前没有待回复消息。";
    }
    return ` 当前待回复码：${entries.map((entry) => entry.code).join("、")}。`;
  }

  private nextUniqueCode(): string {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const candidate = this.codeGenerator().trim().toUpperCase();
      if (
        /^[A-Z2-9]{5,8}$/u.test(candidate) &&
        !this.pendingByCode.has(candidate)
      ) {
        return candidate;
      }
    }
    throw new Error("无法生成唯一的企业微信回复码。");
  }

  private expireOldEntries(): void {
    const cutoff = this.now() - this.pendingTtlMs;
    for (const [code, pending] of this.pendingByCode) {
      if (pending.createdAt < cutoff) {
        this.remove(code);
      }
    }
  }

  private remove(code: string): void {
    const pending = this.pendingByCode.get(code);
    if (!pending) {
      return;
    }
    this.pendingByCode.delete(code);
    if (
      this.codeByWorkspaceSession.get(pending.workspaceSessionId) === code
    ) {
      this.codeByWorkspaceSession.delete(pending.workspaceSessionId);
    }
  }
}

export function terminalActionForRemoteReply(
  pending: PendingRemoteReply,
  reply: string,
): RemoteReplyAction {
  const normalized = normalizedReplyText(reply);
  if (!normalized) {
    throw new Error("回复内容不能为空。");
  }

  if (pending.inputMode === "none") {
    throw new Error("这条通知未提供完整权限选项，请回到开发工作台查看并确认，或回复后续带选项的权限通知。");
  }

  if (pending.replyStage) {
    return { input: `${normalized}\r` };
  }

  const normalizedAlias = normalizedChoiceText(normalized);
  let selection = normalized;
  if (pending.kind === "permission") {
    const { optionCount, suggestionCount } = permissionMenuShape(pending);
    const denySelection = String(suggestionCount + 2);
    const directSelection = validNumberedSelection(
      normalizedAlias,
      optionCount,
    );
    const looksNumeric = /^[0-9]+$/u.test(normalizedAlias);
    const labelMatch = looksNumeric
      ? ({ status: "not-found" } as const)
      : menuTextMatch(normalized, pending.permissionOptionLabels ?? []);
    if (directSelection !== null) {
      selection = String(directSelection);
    } else if (looksNumeric) {
      throw new Error(
        `权限回复无效，请回复 1-${optionCount} 的选项编号。`,
      );
    } else if (labelMatch.status === "ambiguous") {
      throw new Error("权限选项文字存在歧义，请改用通知中的选项编号。");
    } else if (labelMatch.status === "matched") {
      selection = String(labelMatch.selection);
    } else if (
      [
        "允许",
        "允许本次",
        "仅允许本次",
        "同意",
        "是",
        "yes",
        "y",
      ].includes(normalizedAlias)
    ) {
      selection = "1";
    } else if (
      ["拒绝", "不允许", "否", "no", "n"].includes(normalizedAlias)
    ) {
      selection = denySelection;
    } else if (normalizedAlias === "始终允许") {
      if (suggestionCount !== 1) {
        throw new Error(
          suggestionCount === 0
            ? "当前权限请求没有“始终允许”选项。"
            : "当前权限请求有多个长期允许选项，请按通知中的编号回复。",
        );
      }
      selection = "2";
    }

    const numericSelection = Number(selection);
    if (
      !Number.isInteger(numericSelection) ||
      numericSelection < 1 ||
      numericSelection > optionCount
    ) {
      throw new Error(
        "权限回复无效，请回复通知中的选项编号、允许/拒绝或完整选项文字。",
      );
    }
    if (selection === denySelection) {
      return singleMenuAction(numericSelection, {
        nextStage: "permission-denial-reason",
        followUpMessage:
          "已选择拒绝。请继续回复拒绝原因，或告诉 Claude Code 应该如何调整。",
      });
    }
    return singleMenuAction(numericSelection);
  }

  const questionModes = pending.questionSelectionModes ?? [];
  const questionLabels = pending.questionOptionLabels ?? [];
  const firstOptionCount = questionLabels[0]?.length ?? 0;
  if (pending.kind === "question" && questionModes.length === 1) {
    // "其他：内容" / "讨论：内容" choose the extra row and carry the text in
    // the same message. A multi-select question has no chat row; its
    // discussion text is sent as the free-text answer instead.
    const keyword = questionKeywordReply(reply);
    if (keyword) {
      const chat = keyword.row === "chat" && questionModes[0] === "single";
      return singleMenuAction(firstOptionCount + (chat ? 2 : 1), {
        nextStage: chat ? "question-chat-message" : "question-custom-answer",
        inlineFollowUp: keyword.content,
      });
    }
  }
  if (pending.kind === "question" && questionModes.length > 0) {
    const normalizedQuestionChoice = normalizedChoiceText(normalized);
    const regularOptionMatch = /^[1-9][0-9]*$/u.test(
      normalizedQuestionChoice,
    )
      ? ({ status: "not-found" } as const)
      : menuTextMatch(normalized, questionLabels[0] ?? []);
    if (regularOptionMatch.status === "ambiguous") {
      throw new Error("问题选项文字存在歧义，请改用通知中的选项编号。");
    }
    const matchesRegularOption = regularOptionMatch.status === "matched";
    // The extra rows ("Type something", "Chat about this") are not numbered
    // in the notification because Claude Code only draws them in some
    // layouts. They are chosen by their text (or the "其他："/"讨论："
    // keywords); a bare number beyond Claude's options is left to the caller,
    // which looks at the row the terminal actually shows under that number.
    if (
      !matchesRegularOption &&
      QUESTION_CUSTOM_CHOICE_ALIASES.has(normalizedQuestionChoice)
    ) {
      return singleMenuAction(firstOptionCount + 1, {
        nextStage: "question-custom-answer",
        followUpMessage:
          "已选择“输入其他回答（Type something.）”。请继续回复你的具体答案。",
      });
    }
    if (
      !matchesRegularOption &&
      questionModes[0] === "single" &&
      QUESTION_CHAT_CHOICE_ALIASES.has(normalizedQuestionChoice)
    ) {
      return singleMenuAction(firstOptionCount + 2, {
        nextStage: "question-chat-message",
        followUpMessage:
          "已选择“与 Claude 讨论这个问题（Chat about this）”。请继续回复你想讨论或补充的内容。",
      });
    }
    if (
      questionModes.length === 1 &&
      /^[1-9][0-9]*$/u.test(normalizedQuestionChoice) &&
      Number(normalizedQuestionChoice) > firstOptionCount
    ) {
      throw new Error(
        `问题回复无效。请回复 1-${firstOptionCount} 的选项编号或选项文字；自由回答请发送「其他：你的内容」。`,
      );
    }
  }

  if (questionModes.length > 1) {
    const answers = selection.split(/\s*[;；]\s*/u);
    if (answers.length === questionModes.length) {
      const encoded = answers.map((answer, index) => {
        const labels = questionLabels[index] ?? [];
        const answerSelections = questionSelections(answer, labels);
        if (
          questionModes[index] === "single" &&
          answerSelections?.length === 1
        ) {
          return wizardSingleSelectionInput(answerSelections[0]);
        }
        if (
          questionModes[index] === "multiple" &&
          answerSelections &&
          answerSelections.length > 0
        ) {
          return wizardMultipleSelectionInput(answerSelections);
        }
        return null;
      });
      if (encoded.every((answer): answer is string => answer !== null)) {
        const inputChunks = [
          ...answers.flatMap((answer, index) => {
            const labels = questionLabels[index] ?? [];
            const answerSelections = questionSelections(answer, labels);
            if (
              questionModes[index] === "single" &&
              answerSelections?.length === 1
            ) {
              return wizardSingleSelectionChunks(answerSelections[0]);
            }
            if (
              questionModes[index] === "multiple" &&
              answerSelections &&
              answerSelections.length > 0
            ) {
              return wizardMultipleSelectionChunks(answerSelections);
            }
            return [];
          }),
          // Answering the last question moves to the Submit review; Enter
          // activates “Submit answers”.
          TERMINAL_ENTER,
        ];
        return { input: inputChunks.join(""), inputChunks };
      }
    }
    throw new Error(
      "问题回复无效。多个问题请按通知顺序使用分号或换行分隔答案；每项可用编号或完整选项文字，多选项使用逗号分隔。",
    );
  }

  if (pending.kind === "question" && questionModes.length === 1) {
    const labels = questionLabels[0] ?? [];
    const answerSelections = questionSelections(selection, labels);
    if (questionModes[0] === "single") {
      if (answerSelections?.length === 1) {
        return singleMenuAction(answerSelections[0]);
      }
      throw new Error(
        `问题回复无效。请回复 1-${labels.length} 的选项编号或选项文字；自由回答请发送「其他：你的内容」。`,
      );
    }
    if (answerSelections && answerSelections.length > 0) {
      return multipleMenuAction(answerSelections);
    }
    throw new Error(
      "多选问题回复无效，请使用逗号分隔通知中的选项编号或完整选项文字。",
    );
  }

  // A numeric reply is not proof that Claude is showing a menu. Only Hook
  // events explicitly classified as terminal menus may become navigation keys;
  // text-input prompts must receive the original characters (including "1").
  const canonicalSelection = normalizedChoiceText(selection);
  if (pending.inputMode === "menu" && /^[1-9]$/u.test(canonicalSelection)) {
    return singleMenuAction(Number(canonicalSelection));
  }
  if (
    pending.inputMode === "menu" &&
    pending.supportsMultipleSelection &&
    /^[1-9](?:\s*[,，]\s*[1-9])+$/u.test(canonicalSelection)
  ) {
    return multipleMenuAction(
      canonicalSelection
        .split(/\s*[,，]\s*/u)
        .map((value) => Number(value)),
    );
  }
  if (pending.inputMode === "menu") {
    throw new Error(
      "菜单回复无效，请回复通知中的选项编号或支持的完整选项文字。",
    );
  }
  return { input: `${normalized}\r` };
}

export function terminalInputForRemoteReply(
  pending: PendingRemoteReply,
  reply: string,
): string {
  return terminalActionForRemoteReply(pending, reply).input;
}

// Only the most recent output can show the menu that is currently waiting.
const SCREEN_CHECK_TAIL_LENGTH = 12_000;
// A numbered option such as "❯ 1. Yes" or "2.允许". The option text must start
// with a letter so numbers like "1.5" inside a command are not counted.
const MENU_OPTION_PATTERN = /(?:^|[\s❯›>│|])(\d{1,2})\.[ \t\u00a0]*\p{L}/gu;

/**
 * Extract numbered options from PTY text for legacy callers and diagnostics.
 * Live WeCom routing passes renderer xterm rows separately, because PTY text
 * alone cannot reproduce the active viewport after ANSI cursor movement.
 */
export function latestMenuOptions(screen: string): string[] | null {
  return extractNumberedMenuOptions(
    stripAnsi(screen).replaceAll("\r", "").split("\n"),
  );
}

/**
 * Count the options of the most recently rendered numbered menu, or return
 * null when no menu can be recognised. Ink redraws the whole menu on every
 * change, so the last "1." starts the menu that is currently on screen.
 */
export function latestMenuOptionCount(screen: string): number | null {
  const options = latestMenuOptions(screen);
  if (options) {
    return options.length;
  }
  const matches = [...screen.matchAll(MENU_OPTION_PATTERN)].map((match) =>
    Number(match[1]),
  );
  const start = matches.lastIndexOf(1);
  if (start < 0) {
    return null;
  }
  let count = 0;
  for (const value of matches.slice(start)) {
    if (value === count + 1) {
      count += 1;
    } else if (value <= count) {
      break;
    }
  }
  return count > 0 ? count : null;
}

/**
 * Check that the terminal still shows the menu a remote reply was computed
 * for, before any navigation keys are written. Remote replies select options
 * by position, so a menu with a different number of options (Claude Code
 * changed its layout, or the prompt was already handled locally) would make
 * the same keys pick a different answer. Returns a reason to refuse the
 * reply, or null when the screen matches or cannot be recognised.
 */
export function remoteMenuMismatch(
  pending: PendingRemoteReply,
  action: RemoteReplyAction,
  screen: string,
  visibleMenu?: readonly string[] | null,
): string | null {
  if (pending.replyStage || !action.menuSelections?.length) {
    return null;
  }
  const text = stripAnsi(screen).slice(-SCREEN_CHECK_TAIL_LENGTH);
  if (pending.kind === "permission") {
    // The notice lists allow-once, an optional merged suggestion row, and
    // deny; the keystrokes assume exactly that many options on screen.
    const expected = permissionMenuShape(pending).optionCount;
    const visibleLabels =
      visibleMenu === undefined ? latestMenuOptions(text) : visibleMenu;
    const visible =
      visibleLabels === null
        ? null
        : visibleLabels === undefined
          ? latestMenuOptionCount(text)
          : visibleLabels.length;
    if (visible !== null && visible !== expected) {
      return `终端当前的权限菜单有 ${visible} 个选项，与通知中的 ${expected} 个选项不一致`;
    }
    const expectedLabels =
      pending.permissionMenuSource === "rendered"
        ? pending.permissionOptionLabels
        : undefined;
    if (
      visibleLabels &&
      expectedLabels &&
      visibleLabels.length === expectedLabels.length
    ) {
      for (let index = 0; index < expectedLabels.length; index += 1) {
        const expectedLabel = expectedLabels[index];
        const visibleLabel = visibleLabels[index];
        if (
          expectedLabel &&
          visibleLabel &&
          !menuLabelsEqual(expectedLabel, visibleLabel)
        ) {
          return `终端当前的权限菜单第 ${index + 1} 项与通知中的文字不一致`;
        }
      }
    }
    return null;
  }
  if (
    pending.kind === "question" &&
    (pending.questionSelectionModes?.length ?? 0) === 1
  ) {
    const labels = pending.questionOptionLabels?.[0] ?? [];
    const visibleLabels =
      visibleMenu === undefined ? latestMenuOptions(text) : visibleMenu;
    // A single-select question adds "Type something" and "Chat about this";
    // a multi-select question adds only "Type something" (Claude Code may
    // also number its submit row).
    const multiple = pending.questionSelectionModes?.[0] === "multiple";
    const minimumOptionCount = labels.length + (multiple ? 1 : 2);
    const maximumOptionCount = labels.length + 2;
    const compactScreen = text.replace(/\s+/gu, "");
    for (const selection of action.menuSelections) {
      const label = labels[selection - 1];
      if (!label) {
        // "Type something" / "Chat about this" are not in the label list.
        continue;
      }
      const probe = [...label.replace(/\s+/gu, "")].slice(0, 12).join("");
      const visibleLabel = visibleLabels?.[selection - 1];
      if (
        visibleLabels !== null &&
        visibleLabels !== undefined &&
        (!visibleLabel ||
          !menuLabelMatches(label, visibleLabel))
      ) {
        return `终端当前的问题菜单第 ${selection} 项与通知中的文字“${label}”不一致`;
      }
      if (
        visibleLabels === undefined &&
        probe &&
        latestMenuOptionCount(text) !== null &&
        !compactScreen.includes(probe)
      ) {
        return `终端当前的菜单中没有选项“${label}”`;
      }
    }
    if (
      visibleLabels !== null &&
      visibleLabels !== undefined &&
      (visibleLabels.length < minimumOptionCount ||
        visibleLabels.length > maximumOptionCount)
    ) {
      return `终端当前的问题菜单有 ${visibleLabels.length} 个选项，与通知中的 ${minimumOptionCount} 个选项不一致`;
    }
  }
  return null;
}
