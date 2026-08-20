import { randomBytes } from "node:crypto";

const DEFAULT_PENDING_TTL_MS = 24 * 60 * 60 * 1_000;
const ROUTE_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const ROUTE_CODE_LENGTH = 8;

export type RemoteAttentionKind =
  | "permission"
  | "question"
  | "plan"
  | "completion"
  | "idle"
  | "elicitation"
  | "agent";

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
  permissionSuggestionCount?: number;
}

export interface PendingRemoteReply extends RemoteAttention {
  code: string;
  userId: string;
  createdAt: number;
  fingerprint: string;
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
      /回复码\s*[：:]\s*(?:#|\[|`)?([A-Z2-9]{5,8})(?=$|[\s\]`：:])/giu,
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
    const code = codeFromMessage ?? codeFromQuote;

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
        message: `回复码 ${code} 不存在、已过期，或不属于当前用户。${this.pendingSummary(userId)}`,
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

export function terminalInputForRemoteReply(
  pending: PendingRemoteReply,
  reply: string,
): string {
  const normalized = normalizedReplyText(reply);
  if (!normalized) {
    throw new Error("回复内容不能为空。");
  }

  const normalizedAlias = normalized.toLocaleLowerCase("en-US");
  let selection = normalized;
  if (pending.kind === "permission") {
    const suggestionCount = Math.max(
      0,
      Math.floor(pending.permissionSuggestionCount ?? 0),
    );
    const denySelection = String(suggestionCount + 2);
    if (["允许", "同意", "yes", "y"].includes(normalizedAlias)) {
      selection = "1";
    } else if (["拒绝", "不允许", "no", "n"].includes(normalizedAlias)) {
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
    return `${selection}\r`;
  }

  const questionModes = pending.questionSelectionModes ?? [];
  if (questionModes.length > 1) {
    const answers = selection.split(/\s*[;；]\s*/u);
    if (answers.length === questionModes.length) {
      const encoded = answers.map((answer, index) => {
        if (questionModes[index] === "single" && /^[1-9]$/u.test(answer)) {
          return `${answer}\r`;
        }
        if (
          questionModes[index] === "multiple" &&
          /^[1-9](?:\s*[,，]\s*[1-9])*$/u.test(answer)
        ) {
          return `${answer.replace(/[^1-9]/gu, "")}\r`;
        }
        return null;
      });
      if (encoded.every((answer): answer is string => answer !== null)) {
        return encoded.join("");
      }
    }
  }

  if (pending.expectsMenuSelection && /^[1-9]$/u.test(selection)) {
    return `${selection}\r`;
  }
  if (
    pending.expectsMenuSelection &&
    pending.supportsMultipleSelection &&
    /^[1-9](?:\s*[,，]\s*[1-9])+$/u.test(selection)
  ) {
    return `${selection.replace(/[^1-9]/gu, "")}\r`;
  }
  return `${normalized}\r`;
}
