import { randomBytes } from "node:crypto";

const DEFAULT_PENDING_TTL_MS = 24 * 60 * 60 * 1_000;
const ROUTE_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const ROUTE_CODE_LENGTH = 8;
const TERMINAL_DOWN = "\x1b[B";
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

export type RemoteReplyStage =
  | "permission-denial-reason"
  | "question-custom-answer"
  | "question-chat-message";

export interface RemoteAttention {
  workspaceSessionId: string;
  launchId: string;
  claudeSessionId: string;
  kind: RemoteAttentionKind;
  title: string;
  body: string;
  expectsMenuSelection: boolean;
  supportsMultipleSelection?: boolean;
  questionSelectionModes?: Array<"single" | "multiple">;
  questionOptionLabels?: string[][];
  permissionSuggestionCount?: number;
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
  nextStage?: RemoteReplyStage;
  followUpMessage?: string;
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
    JSON.stringify(attention.questionSelectionModes ?? []),
    JSON.stringify(attention.questionOptionLabels ?? []),
    attention.permissionSuggestionCount ?? 0,
  ].join("\u0000");
}

function normalizedReplyText(value: string): string {
  return value
    .replace(/[\r\n\t]+/gu, " ")
    .replace(/\p{Cc}/gu, "")
    .trim();
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
  return normalizedReplyText(
    value.replace(
      new RegExp(`^(?:#|\\[)?${code}(?:\\])?(?:\\s*[：:])?\\s*`, "iu"),
      "",
    ),
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
          "未找到回复码。为避免多个 Claude Code 会话串线，请按“回复码 回复内容”的格式发送。" +
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

    const reply = codeFromMessage ? replyWithoutCode(content, code) : content;
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
    const entries = this.listForUser(userId);
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

  if (pending.replyStage) {
    return { input: `${normalized}\r` };
  }

  const normalizedAlias = normalized.toLocaleLowerCase("en-US");
  let selection = normalized;
  if (pending.kind === "permission") {
    const suggestionCount = Math.max(
      0,
      Math.floor(pending.permissionSuggestionCount ?? 0),
    );
    const denySelection = String(suggestionCount + 2);
    if (
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
      numericSelection > suggestionCount + 2
    ) {
      throw new Error("权限回复无效，请回复通知中的选项编号或允许/拒绝。");
    }
    if (selection === denySelection) {
      return {
        input: singleMenuSelectionInput(numericSelection),
        nextStage: "permission-denial-reason",
        followUpMessage:
          "已选择拒绝。请继续回复拒绝原因，或告诉 Claude Code 应该如何调整。",
      };
    }
    return { input: singleMenuSelectionInput(numericSelection) };
  }

  const questionModes = pending.questionSelectionModes ?? [];
  const questionLabels = pending.questionOptionLabels ?? [];
  const firstOptionCount = questionLabels[0]?.length ?? 0;
  if (pending.kind === "question" && questionModes.length > 0) {
    const numericSelection = Number(selection);
    if (Number.isInteger(numericSelection)) {
      if (numericSelection === firstOptionCount + 1) {
        return {
          input: singleMenuSelectionInput(numericSelection),
          nextStage: "question-custom-answer",
          followUpMessage:
            "已选择“输入其他回答（Type something.）”。请继续回复你的具体答案。",
        };
      }
      if (numericSelection === firstOptionCount + 2) {
        return {
          input: singleMenuSelectionInput(numericSelection),
          nextStage: "question-chat-message",
          followUpMessage:
            "已选择“与 Claude 讨论这个问题（Chat about this）”。请继续回复你想讨论或补充的内容。",
        };
      }
    }
  }

  if (questionModes.length > 1) {
    const answers = selection.split(/\s*[;；]\s*/u);
    if (answers.length === questionModes.length) {
      const encoded = answers.map((answer, index) => {
        const labels = questionLabels[index] ?? [];
        const labelIndex = labels.findIndex(
          (label) =>
            label.toLocaleLowerCase("en-US") ===
            answer.toLocaleLowerCase("en-US"),
        );
        const answerSelection =
          labelIndex >= 0 ? String(labelIndex + 1) : answer;
        if (
          questionModes[index] === "single" &&
          /^[1-9]$/u.test(answerSelection) &&
          Number(answerSelection) <= labels.length
        ) {
          return singleMenuSelectionInput(Number(answerSelection));
        }
        if (
          questionModes[index] === "multiple" &&
          /^[1-9](?:\s*[,，]\s*[1-9])*$/u.test(answerSelection) &&
          answerSelection
            .split(/\s*[,，]\s*/u)
            .every((value) => Number(value) <= labels.length)
        ) {
          return multipleMenuSelectionInput(
            answerSelection
              .split(/\s*[,，]\s*/u)
              .map((value) => Number(value)),
          );
        }
        return null;
      });
      if (encoded.every((answer): answer is string => answer !== null)) {
        return { input: encoded.join("") };
      }
    }
    throw new Error(
      "问题回复无效。多个问题请按通知顺序使用分号分隔答案；单选用一个编号，多选用逗号分隔编号。",
    );
  }

  if (pending.kind === "question" && questionModes.length === 1) {
    const labels = questionLabels[0] ?? [];
    const labelIndex = labels.findIndex(
      (label) =>
        label.toLocaleLowerCase("en-US") === normalizedAlias,
    );
    if (labelIndex >= 0) {
      selection = String(labelIndex + 1);
    }
    if (questionModes[0] === "single") {
      const numericSelection = Number(selection);
      if (
        Number.isInteger(numericSelection) &&
        numericSelection >= 1 &&
        numericSelection <= labels.length
      ) {
        return { input: singleMenuSelectionInput(numericSelection) };
      }
      throw new Error(
        `问题回复无效。请回复 1-${labels.length + 2} 的选项编号，或直接回复选项文字。`,
      );
    }
    if (
      /^[1-9](?:\s*[,，]\s*[1-9])*$/u.test(selection) &&
      selection
        .split(/\s*[,，]\s*/u)
        .every((value) => Number(value) <= labels.length)
    ) {
      return {
        input: multipleMenuSelectionInput(
          selection.split(/\s*[,，]\s*/u).map((value) => Number(value)),
        ),
      };
    }
    throw new Error("多选问题回复无效，请使用逗号分隔通知中的选项编号。");
  }

  if (pending.expectsMenuSelection && /^[1-9]$/u.test(selection)) {
    return { input: singleMenuSelectionInput(Number(selection)) };
  }
  if (
    pending.expectsMenuSelection &&
    pending.supportsMultipleSelection &&
    /^[1-9](?:\s*[,，]\s*[1-9])+$/u.test(selection)
  ) {
    return {
      input: multipleMenuSelectionInput(
        selection.split(/\s*[,，]\s*/u).map((value) => Number(value)),
      ),
    };
  }
  return { input: `${normalized}\r` };
}

export function terminalInputForRemoteReply(
  pending: PendingRemoteReply,
  reply: string,
): string {
  return terminalActionForRemoteReply(pending, reply).input;
}
