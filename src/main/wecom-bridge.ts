import { EventEmitter } from "node:events";
import {
  generateReqId,
  WSClient,
  type BaseMessage,
  type EventMessage,
  type SendMsgBody,
  type WsFrame,
  type WsFrameHeaders,
} from "@wecom/aibot-node-sdk";
import type {
  ProjectRecord,
  SessionRecord,
  TerminalVisibleLinesRequest,
  WeComHeldPrompt,
  WeComInboundStatus,
  WeComState,
} from "../shared/contracts";
import {
  attentionFromClaudeHook,
  withRenderedMenuLabels,
  withRenderedPermissionMenu,
} from "./claude-attention";
import type {
  ClaudeHookDecision,
  ClaudeHookEvent,
} from "./claude-hook-server";
import {
  RemoteReplyRouter,
  terminalActionForRemoteReply,
  type PendingRemoteReply,
  type RemoteReplyStage,
} from "./remote-reply-router";
import {
  hookOutputFor,
  resolveHeldReply,
  withHeldPlanOptions,
} from "./remote-hook-decision";
import {
  bindConfirmedRow,
  bindOutOfRangeSelection,
  bindPermissionSelection,
  bindPositionalSelection,
  bindQuestionSelections,
  bindRowByText,
  describeVisibleMenu,
  followUpMessageForStage,
  isFreeTextRow,
  looksLikeAllowRow,
  looksLikeDenyRow,
  MENU_RECOVERY_HINT,
  screenShowsRequest,
  stageForBoundRow,
  type BoundMenuRow,
  type MenuBinding,
} from "./remote-menu-binding";
import {
  extractNumberedMenuOptions,
  menuLabelMatches,
  menuLabelsEqual,
  parseVisibleMenu,
  type VisibleMenu,
} from "../shared/terminal-menu";
import type { SessionManager, SessionInputEvent } from "./session-manager";
import { describeWeComError as readableError } from "./wecom-error";

export interface WeComRuntimeConfiguration {
  enabled: boolean;
  botId: string;
  targetUserId: string;
  secret?: string;
  hasSecret: boolean;
  configurationError?: string;
  /**
   * Hold permission/question/plan Hooks open while the owner is away so the
   * WeCom reply answers them directly (default true).
   */
  holdPromptsWhileAway?: boolean;
}

interface WeComBridgeEvents {
  stateChanged: [state: WeComState];
}

export interface WeComClient {
  connect(): unknown;
  disconnect(): void;
  on(event: "authenticated", listener: () => void): unknown;
  on(event: "connected", listener: () => void): unknown;
  on(event: "disconnected", listener: (reason: string) => void): unknown;
  on(event: "reconnecting", listener: (attempt: number) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(
    event: "message",
    listener: (frame: WsFrame<BaseMessage>) => void,
  ): unknown;
  on(
    event: "event.disconnected_event",
    listener: (frame: WsFrame<EventMessage>) => void,
  ): unknown;
  sendMessage(chatId: string, body: SendMsgBody): Promise<unknown>;
  replyStream(
    frame: WsFrameHeaders,
    streamId: string,
    content: string,
    finish?: boolean,
  ): Promise<unknown>;
}

type WeComInboundMessageEvent =
  | "message.text"
  | "message.voice"
  | "message.mixed"
  | "message.image"
  | "message.file"
  | "message.video";

interface TypedWeComClient {
  on(
    event: WeComInboundMessageEvent,
    listener: (frame: WsFrame<BaseMessage>) => void,
  ): unknown;
}

export type WeComClientFactory = (options: {
  botId: string;
  secret: string;
}) => WeComClient;

function defaultClientFactory(options: {
  botId: string;
  secret: string;
}): WeComClient {
  return new WSClient({
    ...options,
    maxReconnectAttempts: -1,
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: (message) => console.warn(`[WeCom] ${message}`),
      error: (message) => console.error(`[WeCom] ${message}`),
    },
  });
}

// A PermissionRequest Hook arrives before Claude Code draws the dialog. Give
// the renderer time to lay out the dialog (xterm parses asynchronously, and a
// hidden window runs timers less often) before falling back to Hook data.
const REMOTE_MENU_SYNC_TIMEOUT_MS = 2_000;
// Before writing reply keys, let the renderer catch up with recent output.
const REMOTE_REPLY_SYNC_TIMEOUT_MS = 1_000;
// After moving the focus pointer, how long to wait for the redrawn menu that
// proves the pointer landed on the intended row before Enter is pressed.
const REMOTE_MENU_VERIFY_TIMEOUT_MS = 1_500;
// After choosing a row that opens a text field, how long to wait for the
// field before typing text sent along with the choice.
const REMOTE_FOLLOW_UP_DELAY_MS = 800;
const TERMINAL_DOWN = "\x1b[B";
const TERMINAL_UP = "\x1b[A";
const TERMINAL_ENTER = "\r";
const TERMINAL_TOGGLE = " ";
// "菜单" re-sends the menu on screen; "确认 N" selects the N-th row on screen
// after the user has seen it.
const MENU_COMMAND = /^(?:菜单|刷新菜单|刷新|menu)$/iu;
const CONFIRM_COMMAND = /^(?:确认|confirm)\s*([1-9][0-9]?)$/iu;
// Claude Code's plan approval rows ("Yes, and auto-accept edits", "No, keep
// planning", …) always mention the plan or edits.
const PLAN_MENU_LABEL = /plan|edits|计划/iu;

interface RemoteReplyContext {
  client: WeComClient;
  frame: WsFrame<BaseMessage>;
  pending: PendingRemoteReply;
}

/** A prompt whose Hook response is being withheld until WeCom answers. */
interface HeldPrompt {
  code: string;
  sessionId: string;
  launchId: string;
  kind: "permission" | "question" | "plan";
  title: string;
  since: number;
  event: ClaudeHookEvent;
  decisions: Array<{ decision: ClaudeHookDecision; hookEventName: string }>;
}

type WeComStateInput = Omit<WeComState, "holdPromptsWhileAway" | "heldPrompts">;

// How often, while prompts are held, to check whether the owner is back at
// the computer (then the terminal dialog is the better place to answer).
const PRESENCE_POLL_MS = 3_000;

interface VisibleScreen {
  lines: TerminalVisibleLinesRequest | undefined;
  menu: VisibleMenu | null;
}

interface RemoteFollowUp {
  nextStage?: RemoteReplyStage;
  followUpMessage?: string;
  inlineFollowUp?: string;
}

function copyState(state: WeComState): WeComState {
  return { ...state };
}

function trimmedInboundIdentifier(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) {
    return value;
  }
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maxBytes - Buffer.byteLength("…", "utf8")) {
      break;
    }
    result += character;
    bytes += characterBytes;
  }
  return `${result}…`;
}

function quoteText(message: BaseMessage): string {
  const quote = (message as BaseMessage & { quote?: unknown }).quote;
  if (!quote) {
    return "";
  }
  if (typeof quote === "string") {
    return quote;
  }
  if (typeof quote !== "object" || Array.isArray(quote)) {
    return "";
  }
  const value = quote as {
    content?: unknown;
    quote_text?: unknown;
    text?: { content?: unknown };
    markdown?: { content?: unknown };
    voice?: { content?: unknown };
    mixed?: { msg_item?: unknown };
  };
  const mixedItems = Array.isArray(value.mixed?.msg_item)
    ? value.mixed.msg_item
    : [];
  const candidates = [
    value.content,
    value.quote_text,
    value.text?.content,
    value.markdown?.content,
    value.voice?.content,
    ...mixedItems.flatMap((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return [];
      }
      const text = (item as { text?: unknown }).text;
      if (!text || typeof text !== "object" || Array.isArray(text)) {
        return [];
      }
      const content = (text as { content?: unknown }).content;
      return typeof content === "string" ? [content] : [];
    }),
  ].filter(
    (candidate): candidate is string =>
      typeof candidate === "string" && candidate.trim().length > 0,
  );
  return [...new Set(candidates)].join("\n");
}

function incomingMessageText(message: BaseMessage): string {
  const text = (message as BaseMessage & { text?: { content?: unknown } }).text
    ?.content;
  if (typeof text === "string") {
    return text;
  }
  const voice = (
    message as BaseMessage & { voice?: { content?: unknown } }
  ).voice?.content;
  if (typeof voice === "string") {
    return voice;
  }
  const items = (
    message as BaseMessage & {
      mixed?: { msg_item?: unknown };
    }
  ).mixed?.msg_item;
  return (
    (Array.isArray(items)
      ? items.flatMap((item) => {
          if (!item || typeof item !== "object" || Array.isArray(item)) {
            return [];
          }
          const text = (item as { text?: unknown }).text;
          if (!text || typeof text !== "object" || Array.isArray(text)) {
            return [];
          }
          const content = (text as { content?: unknown }).content;
          return typeof content === "string" ? [content] : [];
        })
      : []
    ).join("\n")
  );
}

function isSupersededConnection(reason: string): boolean {
  return /new connection (?:has been )?established/iu.test(reason);
}

function projectDisplayName(project: ProjectRecord | undefined): string {
  return project?.alias?.trim() || project?.name || "未知工程";
}

function notificationMarkdown(
  pending: PendingRemoteReply,
  session: SessionRecord,
  project: ProjectRecord | undefined,
): string {
  const workspace =
    session.projectId === null ? "临时会话" : projectDisplayName(project);
  const replyGuidance =
    (pending.questionSelectionModes?.length ?? 0) > 1
      ? {
          quoted:
            "发送 `1;2,3`（每题可用编号或完整选项文字；问题间用分号或换行，多选项用逗号，全部回答后自动提交）",
          directExample: "1;2,3",
        }
      : pending.kind === "permission"
        ? {
            quoted: "发送上方选项编号、`允许`/`拒绝`或完整选项文字；发送「菜单」可查看终端当前的选项",
            directExample: "允许",
          }
        : pending.kind === "question" && pending.inputMode === "menu"
          ? pending.supportsMultipleSelection
            ? {
                quoted: "发送 `1,3`，也可用逗号分隔完整选项文字；自由回答发送「其他：内容」",
                directExample: "1,3",
              }
            : {
                quoted: "发送上方选项编号或完整选项文字，例如 `1`；自由回答发送「其他：内容」，想和 Claude 讨论发送「讨论：内容」",
                directExample: "1",
              }
          : pending.inputMode === "menu"
            ? pending.supportsMultipleSelection
              ? {
                  quoted: "发送上方选项编号，例如 `1,3`",
                  directExample: "1,3",
                }
              : {
                  quoted: "发送上方选项编号，例如 `1`",
                  directExample: "1",
                }
            : {
                quoted: "直接发送回复内容",
                directExample: "继续处理并运行测试",
              };
  const prefix = [
    `# ${pending.title}`,
    ...(pending.inputMode === "none" ? [] : [`> 回复码：\`${pending.code}\``]),
    `> 工程：${workspace}`,
    `> 会话：${session.title}`,
    `> 工作目录：${session.cwd}`,
    "",
  ].join("\n");
  const suffix =
    pending.inputMode === "none"
      ? "\n\n这条通知未提供完整权限选项，请回到开发工作台查看并确认，或回复后续带选项的权限通知。"
      : [
          "",
          "## 如何回复",
          `- 引用本消息回复：${replyGuidance.quoted}，无需重复输入回复码。`,
          `- 不引用消息：发送 \`${pending.code} ${replyGuidance.directExample}\`。`,
          `回复码 \`${pending.code}\` 只对应当前 Claude Code 进程，不能用于其他会话。`,
        ].join("\n");
  const maxMarkdownBytes = 18_000;
  const bodyBudget = Math.max(
    256,
    maxMarkdownBytes -
      Buffer.byteLength(prefix, "utf8") -
      Buffer.byteLength(suffix, "utf8"),
  );
  return `${prefix}${truncateUtf8(pending.body, bodyBudget)}${suffix}`;
}

const PASSIVE_TERMINAL_REPORT_PATTERNS = [
  /^\x1b\[[IO]/u,
  /^\x1b\[<[0-9;]+[Mm]/u,
  /^\x1b\[M[\s\S]{3}/u,
  /^\x1b\[(?:\?[0-9;]+c|>[0-9;]+c|0n|\??[0-9]+;[0-9]+R|[468];[0-9]+;[0-9]+t|\??[0-9]+;[0-4]\$y)/u,
  /^\x1bP[01]\$r[^\x1b]*\x1b\\/u,
  /^\x1b\](?:4;[0-9]+|10|11|12);rgb:[0-9a-f]+\/[0-9a-f]+\/[0-9a-f]+(?:\x07|\x1b\\)/iu,
];

function isPassiveTerminalProtocolData(data: string): boolean {
  if (!data) {
    return false;
  }
  let remaining = data;
  while (remaining) {
    const match = PASSIVE_TERMINAL_REPORT_PATTERNS.map((pattern) =>
      pattern.exec(remaining),
    ).find((candidate): candidate is RegExpExecArray => candidate !== null);
    if (!match) {
      return false;
    }
    remaining = remaining.slice(match[0].length);
  }
  return true;
}

function localInputInvalidatesPendingReply(data: string): boolean {
  // xterm emits both genuine user input and automatic terminal-protocol
  // responses through onData. Only the former changes the user's menu state.
  return Boolean(data) && !isPassiveTerminalProtocolData(data);
}

export class WeComBridge extends EventEmitter<WeComBridgeEvents> {
  private client: WeComClient | null = null;
  private configuration: WeComRuntimeConfiguration = {
    enabled: false,
    botId: "",
    targetUserId: "",
    hasSecret: false,
  };
  private state: WeComState = {
    enabled: false,
    configured: false,
    hasSecret: false,
    botId: "",
    targetUserId: "",
    holdPromptsWhileAway: true,
    heldPrompts: [],
    status: "disabled",
  };
  /** Prompts whose Hook is held open for a remote decision, by reply code. */
  private readonly heldPrompts = new Map<string, HeldPrompt>();
  private presenceTimer: NodeJS.Timeout | null = null;
  private readonly unsentCodes = new Set<string>();
  private readonly sendingCodes = new Set<string>();
  private readonly processedMessageIds = new Set<string>();
  private authenticatedClient: WeComClient | null = null;
  private supersededClient: WeComClient | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private outboundSendChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly sessionManager: SessionManager,
    private readonly listProjects: () => ProjectRecord[],
    private readonly router = new RemoteReplyRouter(),
    private readonly clientFactory: WeComClientFactory = defaultClientFactory,
    private readonly availabilityError?: string,
    /**
     * Whether the owner is away from this computer. Completion and idle
     * notices are only pushed while away; prompts that block Claude Code
     * (permissions, questions, plans) are always pushed. The default keeps
     * pushing everything.
     */
    private readonly isOwnerAway: () => boolean = () => true,
  ) {
    super();
    this.sessionManager.on("input", this.handleSessionInput);
    this.sessionManager.on("changed", this.handleSessionChanged);
  }

  getState(): WeComState {
    return copyState(this.state);
  }

  private ownerAway(): boolean {
    try {
      return this.isOwnerAway();
    } catch {
      // If presence cannot be determined, fall back to pushing.
      return true;
    }
  }

  isClaudePushEnabled(): boolean {
    return Boolean(
      !this.availabilityError &&
        this.configuration.enabled &&
        this.configuration.botId &&
        this.configuration.targetUserId &&
        this.configuration.hasSecret &&
        !this.configuration.configurationError,
    );
  }

  /** @deprecated Use isClaudePushEnabled; hook installation is independent. */
  shouldInjectClaudeHooks(): boolean {
    return this.isClaudePushEnabled();
  }

  configure(configuration: WeComRuntimeConfiguration): WeComState {
    this.client?.disconnect();
    this.client = null;
    this.authenticatedClient = null;
    this.supersededClient = null;
    this.clearRetry();
    this.configuration = { ...configuration, secret: undefined };
    this.releaseAllHeldPrompts();
    this.router.clearAll();
    this.unsentCodes.clear();
    this.sendingCodes.clear();
    this.processedMessageIds.clear();
    this.outboundSendChain = Promise.resolve();

    const configured = Boolean(
      configuration.botId &&
        configuration.targetUserId &&
        configuration.hasSecret,
    );
    if (!configuration.enabled) {
      this.updateState({
        enabled: false,
        configured,
        hasSecret: configuration.hasSecret,
        botId: configuration.botId,
        targetUserId: configuration.targetUserId,
        status: "disabled",
      });
      return this.getState();
    }

    if (
      !configured ||
      !configuration.secret ||
      configuration.configurationError ||
      this.availabilityError
    ) {
      this.updateState({
        enabled: true,
        configured,
        hasSecret: configuration.hasSecret,
        botId: configuration.botId,
        targetUserId: configuration.targetUserId,
        status: "error",
        error:
          this.availabilityError ??
          configuration.configurationError ??
          "企业微信 Bot ID、Secret 和接收用户 userid 均不能为空。",
      });
      return this.getState();
    }

    this.updateState({
      enabled: true,
      configured: true,
      hasSecret: true,
      botId: configuration.botId,
      targetUserId: configuration.targetUserId,
      status: "connecting",
    });

    try {
      const client = this.clientFactory({
        botId: configuration.botId,
        secret: configuration.secret,
      });
      this.client = client;
      this.attachClient(client);
      // Keep the bridge compatible with clients whose connect method is
      // asynchronous. The bundled SDK returns synchronously, but an ignored
      // rejected Promise would otherwise leave the status stuck at “连接中”.
      void Promise.resolve(client.connect()).catch((error: unknown) => {
        if (this.client === client) {
          this.fail(`无法连接 Claude Code 终端控制机器人：${readableError(error)}`);
        }
      });
    } catch (error) {
      this.fail(`无法连接 Claude Code 终端控制机器人：${readableError(error)}`);
    }
    return this.getState();
  }

  handleClaudeHook(event: ClaudeHookEvent): void {
    if (
      !this.isClaudePushEnabled() ||
      !this.sessionManager.isCurrentLaunch(
        event.workspaceSessionId,
        event.launchId,
      )
    ) {
      return;
    }
    const hookAttention = attentionFromClaudeHook(event);
    if (!hookAttention) {
      this.recordClaudeHook(
        `已收到 Claude Code ${event.payload.hook_event_name} 事件，但没有可推送的消息内容。`,
      );
      return;
    }
    if (this.shouldHoldPrompt(event, hookAttention)) {
      // Decide synchronously: the Hook server answers "{}" as soon as this
      // listener returns unless the request is held now.
      event.decision!.hold();
      this.publishHeldPrompt(event, hookAttention);
      return;
    }
    if (
      (hookAttention.kind === "permission" || hookAttention.kind === "plan") &&
      hookAttention.inputMode === "menu"
    ) {
      void this.publishMenuHook(event, hookAttention);
      return;
    }
    this.publishClaudeAttention(event, hookAttention);
  }

  /**
   * Whether this prompt should be answered through the Hook response rather
   * than the terminal menu: only while the owner is away (at the computer
   * the dialog is the better place), only when the Hook can carry a decision,
   * and only for prompt kinds whose answer the Hook protocol can express.
   */
  private shouldHoldPrompt(
    event: ClaudeHookEvent,
    attention: NonNullable<ReturnType<typeof attentionFromClaudeHook>>,
  ): boolean {
    if (
      !event.decision ||
      event.decision.settled ||
      this.configuration.holdPromptsWhileAway === false ||
      attention.inputMode !== "menu" ||
      // Without a live WeCom connection nobody could answer; let Claude Code
      // draw its dialog instead of waiting on a notification that cannot
      // be delivered.
      !this.authenticatedClient
    ) {
      return false;
    }
    if (
      attention.kind !== "permission" &&
      attention.kind !== "question" &&
      attention.kind !== "plan"
    ) {
      return false;
    }
    return this.ownerAway();
  }

  /**
   * Push a notification for a prompt whose Hook is held. The notification is
   * built from the Hook payload alone: Claude Code draws no dialog while the
   * Hook is pending, so there is no screen to read, and none is needed since
   * the reply becomes the Hook's response.
   */
  private publishHeldPrompt(
    event: ClaudeHookEvent,
    hookAttention: NonNullable<ReturnType<typeof attentionFromClaudeHook>>,
  ): void {
    const decision = event.decision!;
    const attention =
      hookAttention.kind === "plan"
        ? withHeldPlanOptions(hookAttention)
        : hookAttention;
    const pending = this.publishClaudeAttention(event, attention);
    if (!pending) {
      decision.release();
      return;
    }
    const entry = { decision, hookEventName: event.payload.hook_event_name };
    const existing = this.heldPrompts.get(pending.code);
    if (existing) {
      // The same prompt reported through a second Hook (PreToolUse and
      // PermissionRequest both fire for AskUserQuestion): answer both later.
      existing.decisions.push(entry);
    } else {
      this.heldPrompts.set(pending.code, {
        code: pending.code,
        sessionId: pending.workspaceSessionId,
        launchId: pending.launchId,
        kind: attention.kind as HeldPrompt["kind"],
        title: attention.title,
        since: Date.now(),
        event,
        decisions: [entry],
      });
    }
    decision.onSettled((reason) => {
      const held = this.heldPrompts.get(pending.code);
      if (!held) {
        return;
      }
      held.decisions = held.decisions.filter((candidate) => candidate.decision !== decision);
      if (held.decisions.length === 0) {
        // Responded, released, or Claude Code gave up and will now draw its
        // dialog; in the last case the reply code stays valid for the
        // terminal-menu path.
        this.forgetHeldPrompt(held);
        if (reason === "closed") {
          this.recordClaudeHook(
            `Claude Code 不再等待回复码 ${pending.code} 的 Hook 决定，后续回复将通过终端菜单执行。`,
          );
        }
      }
    });
    this.recordClaudeHook(
      `回复码 ${pending.code} 的提示已挂起，等待企业微信直接决定（你回到电脑旁或在终端输入时自动交还）。`,
    );
    this.syncPresencePolling();
  }

  /**
   * Permission and plan prompts: attach the menu Claude Code actually draws
   * when it can be read in time, so the notification numbers the same rows
   * as the terminal. The Hook data stays the fallback.
   */
  private async publishMenuHook(
    event: ClaudeHookEvent,
    hookAttention: NonNullable<ReturnType<typeof attentionFromClaudeHook>>,
  ): Promise<void> {
    let attention = hookAttention;
    const rendered = await this.renderedMenu(
      event.workspaceSessionId,
      hookAttention,
    );
    if (rendered) {
      attention =
        hookAttention.kind === "permission"
          ? withRenderedPermissionMenu(
              hookAttention,
              rendered.options,
              rendered.sequence,
            )
          : withRenderedMenuLabels(hookAttention, rendered.options);
    }
    this.publishClaudeAttention(event, attention);
  }

  /**
   * Read the menu Claude Code is showing for a Hook. The Hook usually arrives
   * before Claude Code draws the dialog, so rows already reported for older
   * output (which may still show Claude's answer or an earlier dialog) are
   * only used when nothing has been written since and the menu looks like
   * the dialog for this request: first row allow, last row deny, and the
   * request's own text on screen. Otherwise wait for the renderer to lay out
   * newer output that contains such a menu, and fall back to the Hook data
   * when it does not appear.
   */
  private async renderedMenu(
    sessionId: string,
    attention: NonNullable<ReturnType<typeof attentionFromClaudeHook>>,
  ): Promise<{ options: string[]; sequence: number } | null> {
    const menuOf = (request: TerminalVisibleLinesRequest | null | undefined) => {
      const options = request ? extractNumberedMenuOptions(request.lines) : null;
      if (!request || !options || options.length < 2) {
        return null;
      }
      if (
        !looksLikeAllowRow(options[0]) ||
        !looksLikeDenyRow(options[options.length - 1])
      ) {
        return null;
      }
      if (
        attention.kind === "permission" &&
        screenShowsRequest(attention, request.lines) === false
      ) {
        return null;
      }
      if (
        attention.kind === "plan" &&
        !options.some((label) => PLAN_MENU_LABEL.test(label))
      ) {
        // An earlier permission dialog has the same allow/deny shape; only
        // Claude Code's plan approval menu mentions the plan.
        return null;
      }
      return { options, sequence: request.sequence };
    };
    try {
      const current = this.sessionManager.getTerminalVisibleLines(sessionId);
      if (!current) {
        // No renderer terminal reports for this session.
        return null;
      }
      const hookSequence = this.sessionManager.getTerminalSequence(sessionId);
      // Rows already on screen are only trusted for a permission request,
      // whose own text (command, path, host) proves they belong to it. A
      // plan menu carries nothing to tell a new one from the previous one,
      // so it must be drawn after the Hook arrived.
      if (attention.kind !== "plan" && current.sequence >= hookSequence) {
        const menu = menuOf(current);
        if (menu) {
          return menu;
        }
      }
      return menuOf(
        await this.sessionManager.waitForTerminalVisibleLines(
          sessionId,
          hookSequence + 1,
          REMOTE_MENU_SYNC_TIMEOUT_MS,
          (request) => menuOf(request) !== null,
        ),
      );
    } catch {
      // The launch guard in publishClaudeAttention handles a session that
      // exits while waiting.
      return null;
    }
  }

  /**
   * Visible rows that include all PTY output written so far, if available.
   * Waits briefly for the renderer to catch up with the newest output; when
   * no renderer has ever reported rows for this session there is nothing to
   * wait for and the caller must treat the screen as unreadable.
   */
  private async currentVisibleLines(
    sessionId: string,
  ): Promise<TerminalVisibleLinesRequest | undefined> {
    const existing = this.sessionManager.getTerminalVisibleLines(sessionId);
    if (!existing) {
      return undefined;
    }
    const sequence = this.sessionManager.getTerminalSequence(sessionId);
    if (existing.sequence >= sequence) {
      return existing;
    }
    const latest = await this.sessionManager
      .waitForTerminalVisibleLines(sessionId, sequence, REMOTE_REPLY_SYNC_TIMEOUT_MS)
      .catch(() => null);
    // Newer output exists that the screen has not caught up with: the old
    // rows may show a menu that is already gone. Treat it as unreadable
    // rather than acting on it.
    return latest ?? undefined;
  }

  /**
   * Register the prompt with the router and push it. Returns the pending
   * reply the prompt is (now or already) registered under, or null when
   * nothing was registered.
   */
  private publishClaudeAttention(
    event: ClaudeHookEvent,
    attention: NonNullable<ReturnType<typeof attentionFromClaudeHook>>,
  ): PendingRemoteReply | null {
    if (
      !this.isClaudePushEnabled() ||
      !this.sessionManager.isCurrentLaunch(
        event.workspaceSessionId,
        event.launchId,
      )
    ) {
      return null;
    }
    this.recordClaudeHook(
      `已收到 Claude Code ${event.payload.hook_event_name} 事件，正在推送。`,
    );
    if (
      (attention.kind === "completion" || attention.kind === "idle") &&
      !this.ownerAway()
    ) {
      // The owner is at the computer and sees the terminal; a WeCom message
      // for every finished turn is noise. Blocking prompts are still pushed.
      this.recordClaudeHook(
        "你正在使用电脑，本次完成提醒未推送到企业微信；需要你确认的权限、问题和计划仍会推送。",
      );
      return null;
    }
    const result = this.router.register(
      this.configuration.targetUserId,
      attention,
    );
    this.pruneDeliveryState();
    if (!result.shouldSend) {
      this.recordClaudeHook("已收到 Claude Code 事件，该会话已有对应通知，本次未重复推送。");
      return result.pending;
    }
    this.unsentCodes.add(result.pending.code);
    void this.sendPending(result.pending);
    return result.pending;
  }

  dispose(): void {
    this.sessionManager.off("input", this.handleSessionInput);
    this.sessionManager.off("changed", this.handleSessionChanged);
    this.client?.disconnect();
    this.client = null;
    this.authenticatedClient = null;
    this.supersededClient = null;
    this.clearRetry();
    this.releaseAllHeldPrompts();
    this.router.clearAll();
    this.unsentCodes.clear();
    this.sendingCodes.clear();
    this.outboundSendChain = Promise.resolve();
  }

  private readonly handleSessionInput = (event: SessionInputEvent) => {
    if (
      event.source === "local" &&
      localInputInvalidatesPendingReply(event.data)
    ) {
      // The owner is typing into this terminal: hand the prompt back to the
      // local dialog and forget the remote route.
      this.releaseHeldPromptsForSession(event.sessionId);
      const code = this.router.clearWorkspaceSession(event.sessionId);
      if (code) {
        this.unsentCodes.delete(code);
      }
    }
  };

  private readonly handleSessionChanged = (session: SessionRecord) => {
    if (session.status !== "running") {
      this.releaseHeldPromptsForSession(session.id);
      const code = this.router.clearWorkspaceSession(session.id);
      if (code) {
        this.unsentCodes.delete(code);
      }
    }
  };

  /**
   * Let Claude Code show its own dialog for the held prompts of a session
   * (the owner wants to answer locally). Returns the new state.
   */
  releaseHeldPrompts(sessionId: string): WeComState {
    this.releaseHeldPromptsForSession(sessionId);
    return this.getState();
  }

  private releaseHeldPromptsForSession(sessionId: string): void {
    for (const held of [...this.heldPrompts.values()]) {
      if (held.sessionId === sessionId) {
        this.releaseHeldPrompt(held, "本机接管");
      }
    }
  }

  /**
   * Nobody can answer a held prompt without a live WeCom connection, so any
   * loss of the connection hands every held prompt back to the terminal
   * dialog at once instead of letting Claude Code wait for the Hook timeout.
   */
  private releaseAllHeldPrompts(reason = "连接重置"): void {
    for (const held of [...this.heldPrompts.values()]) {
      this.releaseHeldPrompt(held, reason);
    }
  }

  private releaseHeldPrompt(held: HeldPrompt, reason: string): void {
    this.heldPrompts.delete(held.code);
    for (const { decision } of held.decisions) {
      decision.release();
    }
    this.recordClaudeHook(
      `已将回复码 ${held.code} 对应的提示交还给终端对话框（${reason}）。`,
    );
    this.syncPresencePolling();
  }

  private forgetHeldPrompt(held: HeldPrompt): void {
    this.heldPrompts.delete(held.code);
    this.syncPresencePolling();
    this.updateState({ ...this.state });
  }

  /** Poll presence only while something is held. */
  private syncPresencePolling(): void {
    if (this.heldPrompts.size === 0) {
      if (this.presenceTimer) {
        clearInterval(this.presenceTimer);
        this.presenceTimer = null;
      }
      this.updateState({ ...this.state });
      return;
    }
    if (!this.presenceTimer) {
      this.presenceTimer = setInterval(() => {
        if (!this.ownerAway()) {
          // The owner is back: the terminal dialog is where they will look.
          for (const held of [...this.heldPrompts.values()]) {
            this.releaseHeldPrompt(held, "你已回到电脑旁");
          }
        }
      }, PRESENCE_POLL_MS);
      this.presenceTimer.unref?.();
    }
    this.updateState({ ...this.state });
  }

  private attachClient(client: WeComClient): void {
    client.on("connected", () => {
      if (this.client === client && this.state.status !== "connected") {
        this.updateState({ ...this.state, status: "connecting" });
      }
    });
    client.on("authenticated", () => {
      if (this.client !== client) {
        return;
      }
      this.authenticatedClient = client;
      this.supersededClient = null;
      this.clearRetry();
      this.updateState({ ...this.state, status: "connected", error: undefined });
      void this.flushUnsent();
    });
    client.on("reconnecting", () => {
      if (this.client === client) {
        this.authenticatedClient = null;
        this.releaseAllHeldPrompts("企业微信连接断开");
        this.clearRetry();
        this.updateState({ ...this.state, status: "connecting" });
      }
    });
    client.on("disconnected", (reason) => {
      if (this.client === client) {
        this.authenticatedClient = null;
        this.releaseAllHeldPrompts("企业微信连接断开");
        this.clearRetry();
        if (
          this.supersededClient === client ||
          isSupersededConnection(reason)
        ) {
          this.supersededClient = client;
          this.updateState({
            ...this.state,
            status: "error",
            error:
              "连接被其他客户端占用，请关闭使用相同 Bot ID/Secret 的客户端或改用独立机器人。",
          });
          return;
        }
        this.updateState({
          ...this.state,
          status: "connecting",
          error: reason || "企业微信连接已断开，正在重连。",
        });
      }
    });
    client.on("error", (error) => {
      if (this.client === client) {
        this.authenticatedClient = null;
        this.releaseAllHeldPrompts("企业微信连接出错");
        this.clearRetry();
        this.fail(`企业微信连接错误：${readableError(error)}`);
      }
    });
    client.on("event.disconnected_event", () => {
      if (this.client === client) {
        this.authenticatedClient = null;
        this.releaseAllHeldPrompts("企业微信连接被其他客户端占用");
        this.supersededClient = client;
        this.clearRetry();
        this.updateState({
          ...this.state,
          status: "error",
          error:
            "连接被其他客户端占用，请关闭使用相同 Bot ID/Secret 的客户端或改用独立机器人。",
        });
      }
    });
    client.on("message", (frame) => {
      if (this.client === client) {
        void this.handleIncomingMessage(client, frame).catch((error: unknown) => {
          if (this.client !== client) {
            return;
          }
          const detail = `处理企业微信回复失败：${readableError(error)}`;
          this.recordInbound("failed", detail);
          void this.replyToMessage(client, frame, detail);
        });
      }
    });
    // The SDK emits both a generic message event and a type-specific event.
    // Subscribe to the latter as a compatibility path for clients that only
    // expose typed callbacks; processedMessageIds keeps duplicate frames
    // idempotent when both are emitted.
    const typedClient = client as unknown as TypedWeComClient;
    const typedEvents: WeComInboundMessageEvent[] = [
      "message.text",
      "message.voice",
      "message.mixed",
      "message.image",
      "message.file",
      "message.video",
    ];
    for (const event of typedEvents) {
      typedClient.on(event, (frame) => {
        if (this.client === client) {
          void this.handleIncomingMessage(client, frame).catch((error: unknown) => {
            if (this.client !== client) {
              return;
            }
            const detail = `处理企业微信回复失败：${readableError(error)}`;
            this.recordInbound("failed", detail);
            void this.replyToMessage(client, frame, detail);
          });
        }
      });
    }
  }

  private async handleIncomingMessage(
    client: WeComClient,
    frame: WsFrame<BaseMessage>,
  ): Promise<void> {
    const message = frame.body;
    if (!message) {
      return;
    }
    const messageId = trimmedInboundIdentifier(message.msgid);
    if (!messageId || this.processedMessageIds.has(messageId)) {
      return;
    }
    this.processedMessageIds.add(messageId);
    if (this.processedMessageIds.size > 2_000) {
      const oldest = this.processedMessageIds.values().next().value;
      if (typeof oldest === "string") {
        this.processedMessageIds.delete(oldest);
      }
    }

    const messageText = incomingMessageText(message);
    if (!messageText.trim()) {
      const detail = "收到消息，但其中没有可用于路由的文本。";
      this.recordInbound("rejected", detail);
      await this.replyToMessage(client, frame, detail);
      return;
    }
    if (message.chattype === "group") {
      this.recordInbound(
        "ignored",
        "Claude Code 终端控制机器人只处理终端远程回复；私人助理请使用独立的企业微信智能机器人。",
      );
      return;
    }
    if (message.chattype !== "single") {
      this.recordInbound("ignored", "收到不支持的企业微信会话类型。");
      return;
    }
    // Only the configured recipient may drive the terminal. The configured
    // value must be the userid WeCom puts in `from.userid` (which can be an
    // encrypted form; see README), so the two are compared verbatim. No
    // reply goes back: a stranger gets no confirmation that a code exists.
    const sender = trimmedInboundIdentifier(message.from?.userid);
    if (!sender || sender !== this.configuration.targetUserId) {
      this.recordInbound(
        "ignored",
        `已忽略来自非接收人（${sender || "未知 userid"}）的消息：只有配置的接收用户 userid 可以回复终端。`,
      );
      return;
    }
    const quotedText = quoteText(message);
    const resolved = this.router.resolve(
      this.configuration.targetUserId,
      messageText,
      quotedText,
    );
    this.recordInbound(
      "received",
      "已收到企业微信回复，正在按回复码匹配 Claude Code 会话。",
    );
    if (resolved.status === "rejected") {
      this.recordInbound("rejected", resolved.message);
      await this.replyToMessage(client, frame, resolved.message);
      return;
    }

    const { pending } = resolved;
    if (
      !this.sessionManager.isCurrentLaunch(
        pending.workspaceSessionId,
        pending.launchId,
      )
    ) {
      this.router.complete(pending.code);
      const detail = `回复码 ${pending.code} 对应的 Claude Code 进程已经退出或重启，未发送任何输入。`;
      this.recordInbound("rejected", detail);
      await this.replyToMessage(
        client,
        frame,
        detail,
      );
      return;
    }

    const reply = resolved.reply;
    const context: RemoteReplyContext = { client, frame, pending };

    // A prompt whose Hook is held is answered through the Hook response; no
    // dialog exists in the terminal for it.
    const held = this.heldPrompts.get(pending.code);
    if (held && held.decisions.length > 0) {
      const answered = await this.answerHeldPrompt(context, held, reply);
      if (answered) {
        return;
      }
      // Claude Code stopped waiting in the meantime; its dialog is (or will
      // be) on screen, so fall through to the terminal-menu path.
    }

    // Commands that never write to the terminal.
    if (MENU_COMMAND.test(reply)) {
      const screen = await this.readVisibleMenu(pending.workspaceSessionId);
      const detail = `${describeVisibleMenu(screen.menu)}\n${MENU_RECOVERY_HINT}`;
      this.recordInbound("received", "已按要求重新发送终端当前菜单。");
      await this.replyToMessage(client, frame, detail);
      return;
    }

    // Text replies (free-text prompts and the second stage of a staged menu
    // reply) are written as they are.
    if (pending.replyStage || pending.inputMode !== "menu") {
      let action: ReturnType<typeof terminalActionForRemoteReply>;
      try {
        action = terminalActionForRemoteReply(pending, reply);
      } catch (error) {
        await this.rejectReply(
          context,
          error instanceof Error ? error.message : "远程回复格式无效。",
        );
        return;
      }
      const written = this.sessionManager.writeRemoteReply(
        pending.workspaceSessionId,
        action.input,
      );
      if (!written) {
        await this.failReplyProcessGone(context);
        return;
      }
      await this.completeReply(context, "回复文字");
      return;
    }

    // Menu replies are bound to the menu on screen when the reply arrives.
    const confirmed = CONFIRM_COMMAND.exec(reply);
    if (confirmed) {
      const screen = await this.readVisibleMenu(pending.workspaceSessionId);
      if (!screen.menu) {
        await this.rejectReply(
          context,
          `${describeVisibleMenu(null)}可能已在本机处理。`,
        );
        return;
      }
      await this.executeBinding(
        context,
        bindConfirmedRow(Number(confirmed[1]), screen.menu),
        screen,
        {},
      );
      return;
    }

    let action: ReturnType<typeof terminalActionForRemoteReply> | null = null;
    let actionError: string | null = null;
    try {
      action = terminalActionForRemoteReply(pending, reply);
    } catch (error) {
      actionError = error instanceof Error ? error.message : "远程回复格式无效。";
    }
    const screen = await this.readVisibleMenu(pending.workspaceSessionId);
    if (
      !this.sessionManager.isCurrentLaunch(
        pending.workspaceSessionId,
        pending.launchId,
      )
    ) {
      this.router.complete(pending.code);
      await this.rejectReply(
        context,
        `回复码 ${pending.code} 对应的 Claude Code 进程已经退出或重启，未发送任何输入。`,
      );
      return;
    }

    // A permission dialog with the same shape may belong to another queued
    // request; the request's own text must be on screen before any row of
    // it is taken, whichever way the row was chosen.
    const wrongDialog: MenuBinding | null =
      pending.kind === "permission" &&
      screen.lines &&
      screen.menu &&
      screenShowsRequest(pending, screen.lines.lines) === false
        ? {
            status: "confirm",
            reason: `终端当前的对话框中没有找到这条请求的内容（${(pending.identityProbes ?? [])
              .slice(0, 2)
              .map((probe) => `“${probe}”`)
              .join("、")}），它可能属于另一条权限请求`,
          }
        : null;

    if (!action) {
      // The notification did not offer this answer. A bare number may still
      // name a row Claude Code added on its own; the text of a visible row
      // is accepted as well. Anything else is a formatting error.
      const bareNumber = /^([1-9][0-9]?)$/u.exec(reply.trim());
      if (bareNumber) {
        await this.executeBinding(
          context,
          wrongDialog ?? bindOutOfRangeSelection(Number(bareNumber[1]), screen.menu),
          screen,
          {},
        );
        return;
      }
      if (screen.menu) {
        const byText = bindRowByText(reply, screen.menu);
        if (byText.status === "bound") {
          await this.executeBinding(context, wrongDialog ?? byText, screen, {});
          return;
        }
      }
      await this.rejectReply(context, actionError ?? "远程回复格式无效。");
      return;
    }

    if (!screen.lines) {
      await this.rejectReply(
        context,
        "无法读取终端当前画面，为避免选错，未发送任何按键。请回到开发工作台处理。",
      );
      return;
    }
    if (!screen.menu) {
      await this.rejectReply(
        context,
        "终端当前没有可识别的菜单，可能已在本机处理或 Claude Code 的界面已变化；未发送任何按键。",
      );
      return;
    }

    const questionModes = pending.questionSelectionModes ?? [];
    if (pending.kind === "question" && questionModes.length > 1) {
      // The multi-question wizard is answered with digits, which select by
      // displayed number rather than by position. Only check that the first
      // question is the one on screen.
      const firstLabels = pending.questionOptionLabels?.[0] ?? [];
      const missing = firstLabels.find(
        (label) =>
          !screen.menu!.options.some((option) =>
            menuLabelMatches(label, option.label),
          ),
      );
      if (missing !== undefined) {
        await this.rejectReply(
          context,
          `终端当前菜单中没有通知里的选项“${missing}”，这条通知可能已失效。${describeVisibleMenu(screen.menu)}`,
        );
        return;
      }
      const written = action.inputChunks
        ? await this.sessionManager.writeRemoteReplySequence(
            pending.workspaceSessionId,
            action.inputChunks,
          )
        : this.sessionManager.writeRemoteReply(
            pending.workspaceSessionId,
            action.input,
          );
      if (!written) {
        await this.failReplyProcessGone(context);
        return;
      }
      await this.completeReply(context, "菜单操作");
      return;
    }

    const selections = action.menuSelections ?? [];
    if (selections.length === 0) {
      await this.rejectReply(context, "菜单回复无效，请回复通知中的选项编号或支持的完整选项文字。");
      return;
    }
    const followUp = {
      ...(action.nextStage ? { nextStage: action.nextStage } : {}),
      ...(action.followUpMessage ? { followUpMessage: action.followUpMessage } : {}),
      ...(action.inlineFollowUp ? { inlineFollowUp: action.inlineFollowUp } : {}),
    };
    if (pending.kind === "permission") {
      await this.executeBinding(
        context,
        wrongDialog ?? bindPermissionSelection(pending, selections[0], screen.menu),
        screen,
        followUp,
      );
      return;
    }
    if (pending.kind === "question") {
      await this.executeBinding(
        context,
        bindQuestionSelections(pending, selections, screen.menu),
        screen,
        followUp,
      );
      return;
    }
    await this.executeBinding(
      context,
      bindPositionalSelection(pending, selections[0], screen.menu),
      screen,
      followUp,
    );
  }

  /**
   * Answer a held prompt through its Hook response. Returns false when no
   * Hook could be answered any more (Claude Code gave up waiting), in which
   * case the caller continues with the terminal menu.
   */
  private async answerHeldPrompt(
    context: RemoteReplyContext,
    held: HeldPrompt,
    reply: string,
  ): Promise<boolean> {
    const { pending } = context;
    if (MENU_COMMAND.test(reply)) {
      await this.replyToMessage(
        context.client,
        context.frame,
        "这条提示正由企业微信直接代答，终端上没有菜单；可用的回复见通知内容。",
      );
      return true;
    }
    const resolution = resolveHeldReply(pending, held.event.payload, reply);
    if (resolution.status === "reject") {
      await this.rejectReply(context, resolution.message);
      return true;
    }
    if (resolution.status === "stage") {
      if (!this.router.setReplyStage(pending.code, resolution.stage)) {
        await this.rejectReply(context, `回复码 ${pending.code} 已失效。`);
        return true;
      }
      const detail =
        `${resolution.message}\n回复码：\`${pending.code}\`。该回复码仍对应当前 Claude Code 会话。`;
      this.recordInbound("routed", detail);
      await this.replyToMessage(context.client, context.frame, detail);
      return true;
    }
    let delivered = 0;
    for (const { decision, hookEventName } of held.decisions) {
      if (decision.respond(hookOutputFor(hookEventName, resolution.verdict))) {
        delivered += 1;
      }
    }
    if (delivered === 0) {
      this.forgetHeldPrompt(held);
      return false;
    }
    this.heldPrompts.delete(held.code);
    this.syncPresencePolling();
    this.router.complete(pending.code);
    this.unsentCodes.delete(pending.code);
    const detail =
      `已通过 Hook 直接回复 Claude Code（${resolution.summary}），未经过终端菜单；回复码 ${pending.code} 已完成。`;
    this.recordInbound("routed", detail);
    await this.replyToMessage(context.client, context.frame, detail);
    return true;
  }

  /** The visible rows and the menu parsed from them, if the renderer reported any. */
  private async readVisibleMenu(sessionId: string): Promise<VisibleScreen> {
    const lines = await this.currentVisibleLines(sessionId);
    return {
      lines,
      menu: lines ? parseVisibleMenu(lines.lines) : null,
    };
  }

  /**
   * Carry out a menu binding: move the focus pointer to each bound row,
   * confirm on screen that it arrived there, and only then press Enter (or
   * Space for the rows of a multi-select answer). Any doubt leaves the
   * terminal untouched apart from the pointer position and tells the user
   * what the terminal shows instead.
   */
  private async executeBinding(
    context: RemoteReplyContext,
    binding: MenuBinding,
    screen: VisibleScreen,
    followUp: RemoteFollowUp,
  ): Promise<void> {
    const { pending } = context;
    if (binding.status === "reject") {
      await this.rejectReply(
        context,
        `${binding.reason}。未发送任何按键。\n${describeVisibleMenu(screen.menu)}\n${MENU_RECOVERY_HINT}`,
      );
      return;
    }
    if (binding.status === "confirm") {
      await this.rejectReply(
        context,
        `${binding.reason}。为避免选错，未发送任何按键。\n${describeVisibleMenu(screen.menu)}\n${MENU_RECOVERY_HINT}`,
      );
      return;
    }
    if (binding.status === "text-hint") {
      await this.rejectReply(context, `${binding.reason}。未发送任何按键。`);
      return;
    }
    const menu = screen.menu;
    if (!menu) {
      await this.rejectReply(context, "终端当前没有可识别的菜单，未发送任何按键。");
      return;
    }
    const sessionId = pending.workspaceSessionId;
    const multiple =
      pending.kind === "question" &&
      pending.questionSelectionModes?.[0] === "multiple" &&
      binding.status === "bound" &&
      binding.rows.length >= 1 &&
      !binding.rows.some((row) => isFreeTextRow(row.label));

    let pointer = menu.pointerIndex;
    let current = menu;
    const moveTo = async (
      targetIndex: number,
      accept: (candidate: VisibleMenu) => boolean,
    ): Promise<VisibleMenu | null> => {
      const delta = targetIndex - pointer;
      if (delta === 0) {
        return accept(current) ? current : null;
      }
      const keys = Array.from({ length: Math.abs(delta) }, () =>
        delta > 0 ? TERMINAL_DOWN : TERMINAL_UP,
      );
      const sequenceBefore = this.sessionManager.getTerminalSequence(sessionId);
      const written = await this.sessionManager.writeRemoteReplySequence(
        sessionId,
        keys,
      );
      if (!written) {
        return null;
      }
      const updated = await this.sessionManager.waitForTerminalVisibleLines(
        sessionId,
        sequenceBefore + 1,
        REMOTE_MENU_VERIFY_TIMEOUT_MS,
        (request) => {
          const candidate = parseVisibleMenu(request.lines);
          return candidate !== null && accept(candidate);
        },
      );
      if (!updated) {
        return null;
      }
      const parsed = parseVisibleMenu(updated.lines);
      if (!parsed) {
        return null;
      }
      pointer = parsed.pointerIndex;
      current = parsed;
      return parsed;
    };

    const abortAfterMove = async (wanted: string) => {
      const latest = this.sessionManager.getTerminalVisibleLines(sessionId);
      await this.rejectReply(
        context,
        `已移动光标，但未能确认它落在“${wanted}”上，未发送 Enter。\n${describeVisibleMenu(
          latest ? parseVisibleMenu(latest.lines) : null,
        )}\n${MENU_RECOVERY_HINT}`,
      );
    };

    const rowsToSelect: BoundMenuRow[] = [];
    if (binding.status === "probe") {
      // Try the row Claude Code may draw without a number below the list.
      const landed = await moveTo(
        binding.fromIndex + 1,
        (candidate) =>
          candidate.pointerIndex === candidate.options.length - 1 &&
          candidate.options[candidate.pointerIndex].number === null &&
          binding.acceptLabels.some((label) =>
            menuLabelMatches(label, candidate.options[candidate.pointerIndex].label),
          ),
      );
      if (!landed) {
        await this.rejectReply(
          context,
          "终端当前的问题没有“与 Claude 讨论这个问题”项，未发送 Enter。可改用「其他：你的内容」作为自由回答。",
        );
        return;
      }
      rowsToSelect.push({
        index: landed.pointerIndex,
        label: landed.options[landed.pointerIndex].label,
      });
    } else {
      rowsToSelect.push(
        ...[...binding.rows].sort((left, right) => left.index - right.index),
      );
    }

    for (const target of rowsToSelect) {
      const landed = await moveTo(
        target.index,
        (candidate) =>
          candidate.pointerIndex === target.index &&
          candidate.options[target.index] !== undefined &&
          menuLabelsEqual(candidate.options[target.index].label, target.label),
      );
      if (!landed) {
        await abortAfterMove(target.label);
        return;
      }
      if (multiple) {
        if (!this.sessionManager.writeRemoteReply(sessionId, TERMINAL_TOGGLE)) {
          await this.failReplyProcessGone(context);
          return;
        }
      }
    }

    const chosen = rowsToSelect[rowsToSelect.length - 1];
    const stage =
      followUp.nextStage ??
      (binding.status === "bound" && binding.rows.length === 1
        ? stageForBoundRow(pending, chosen, current)
        : binding.status === "probe"
          ? "question-chat-message"
          : null);
    if (stage && !this.router.setReplyStage(pending.code, stage)) {
      await this.rejectReply(context, `回复码 ${pending.code} 已失效，未发送任何输入。`);
      return;
    }
    const sequenceBeforeEnter = this.sessionManager.getTerminalSequence(sessionId);
    if (!this.sessionManager.writeRemoteReply(sessionId, TERMINAL_ENTER)) {
      await this.failReplyProcessGone(context);
      return;
    }

    if (stage && followUp.inlineFollowUp) {
      // Give Claude Code a moment to open the text field, then type the text
      // the user already sent with the choice.
      await this.sessionManager.waitForTerminalVisibleLines(
        sessionId,
        sequenceBeforeEnter + 1,
        REMOTE_FOLLOW_UP_DELAY_MS,
      );
      if (
        !this.sessionManager.writeRemoteReply(
          sessionId,
          `${followUp.inlineFollowUp}${TERMINAL_ENTER}`,
        )
      ) {
        await this.failReplyProcessGone(context);
        return;
      }
      await this.completeReply(context, "菜单操作和回复文字");
      return;
    }

    if (stage) {
      const detail =
        `${followUp.followUpMessage ?? followUpMessageForStage(stage)}\n` +
        `回复码：\`${pending.code}\`。该回复码仍对应当前 Claude Code 会话。`;
      this.recordInbound("routed", detail);
      await this.replyToMessage(context.client, context.frame, detail);
      return;
    }
    await this.completeReply(context, "菜单操作");
  }

  private async rejectReply(
    context: RemoteReplyContext,
    detail: string,
  ): Promise<void> {
    this.recordInbound("rejected", detail);
    await this.replyToMessage(context.client, context.frame, detail);
  }

  private async failReplyProcessGone(context: RemoteReplyContext): Promise<void> {
    this.router.complete(context.pending.code);
    const detail = `回复码 ${context.pending.code} 对应的 Claude Code 进程已不可用，未发送任何输入。`;
    this.recordInbound("failed", detail);
    await this.replyToMessage(context.client, context.frame, detail);
  }

  private async completeReply(
    context: RemoteReplyContext,
    inputDescription: string,
  ): Promise<void> {
    const { pending } = context;
    this.router.complete(pending.code);
    this.unsentCodes.delete(pending.code);
    const detail =
      `已将回复码 ${pending.code} 对应的${inputDescription}写入 Claude Code 终端，` +
      "正在等待 Claude Code 处理。";
    this.recordInbound("routed", detail);
    const confirmed = await this.replyToMessage(context.client, context.frame, detail);
    if (!confirmed) {
      this.recordInbound(
        "routed",
        `${detail} 企业微信确认消息发送失败，请在客户端终端确认执行状态。`,
      );
    }
  }

  private async replyToMessage(
    client: WeComClient,
    frame: WsFrameHeaders,
    content: string,
  ): Promise<boolean> {
    try {
      await client.replyStream(
        frame,
        generateReqId("claude_workspace"),
        content,
        true,
      );
      return true;
    } catch (error) {
      console.error("Failed to reply to WeCom message", error);
      if (this.client !== client) {
        return false;
      }
      try {
        const message = (frame as WsFrame<BaseMessage>).body;
        const fallbackTarget =
          message?.chatid ||
          message?.from?.userid ||
          this.configuration.targetUserId;
        await client.sendMessage(fallbackTarget, {
          msgtype: "markdown",
          markdown: { content: truncateUtf8(content, 18_000) },
        });
        return true;
      } catch (fallbackError) {
        console.error("Failed to send WeCom reply fallback", fallbackError);
        return false;
      }
    }
  }

  private recordInbound(status: WeComInboundStatus, detail: string): void {
    this.updateState({
      ...this.state,
      lastInboundAt: Date.now(),
      lastInboundStatus: status,
      lastInboundDetail: detail,
    });
  }

  private recordClaudeHook(detail: string): void {
    this.updateState({
      ...this.state,
      lastClaudeHookAt: Date.now(),
      lastClaudeHookDetail: detail,
    });
  }

  private async sendPending(pending: PendingRemoteReply): Promise<void> {
    const client = this.client;
    if (
      !client ||
      this.authenticatedClient !== client ||
      this.sendingCodes.has(pending.code)
    ) {
      if (!client || this.authenticatedClient !== client) {
        this.recordClaudeHook(
          `已收到 Claude Code 消息，等待企业微信连接认证后发送（回复码 ${pending.code}）。`,
        );
      }
      return;
    }
    this.sendingCodes.add(pending.code);
    const session = this.sessionManager
      .listSessions()
      .find((candidate) => candidate.id === pending.workspaceSessionId);
    if (
      !session ||
      !this.sessionManager.isCurrentLaunch(
        pending.workspaceSessionId,
        pending.launchId,
      )
    ) {
      this.router.complete(pending.code);
      this.unsentCodes.delete(pending.code);
      this.sendingCodes.delete(pending.code);
      return;
    }
    const project = this.listProjects().find(
      (candidate) => candidate.id === session.projectId,
    );
    try {
      const sent = await this.enqueueOutboundSend(async () => {
        // A reconnect/configuration change may happen while an earlier push
        // is being acknowledged. Do not send a queued message through an old
        // client; the normal retry path will use the current authenticated
        // client instead.
        if (
          this.client !== client ||
          this.authenticatedClient !== client ||
          !this.unsentCodes.has(pending.code) ||
          !this.sessionManager.isCurrentLaunch(
            pending.workspaceSessionId,
            pending.launchId,
          )
        ) {
          return false;
        }
        await client.sendMessage(this.configuration.targetUserId, {
          msgtype: "markdown",
          markdown: {
            content: notificationMarkdown(pending, session, project),
          },
        });
        return true;
      });
      if (sent && this.client === client) {
        this.unsentCodes.delete(pending.code);
        this.recordClaudeHook(
          `企业微信已确认接收 Claude Code 推送（接收人 ${this.configuration.targetUserId}，回复码 ${pending.code}）。`,
        );
        if (
          this.authenticatedClient === client &&
          this.state.status === "error"
        ) {
          this.updateState({
            ...this.state,
            status: "connected",
            error: undefined,
          });
        }
      }
    } catch (error) {
      if (this.client === client) {
        const detail = `企业微信消息推送失败：${readableError(error)}`;
        this.recordClaudeHook(`Claude Code 消息推送失败：${readableError(error)}`);
        this.fail(detail);
        this.scheduleRetry();
      }
    } finally {
      this.sendingCodes.delete(pending.code);
      if (this.client === client) {
        this.scheduleRetry();
      }
    }
  }

  private enqueueOutboundSend(task: () => Promise<boolean>): Promise<boolean> {
    const next = this.outboundSendChain.then(task, task);
    this.outboundSendChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async flushUnsent(): Promise<void> {
    const pending = this.router
      .listForUser(this.configuration.targetUserId)
      .filter((entry) => this.unsentCodes.has(entry.code));
    for (const entry of pending) {
      await this.sendPending(entry);
    }
  }

  private pruneDeliveryState(): void {
    const activeCodes = new Set(
      this.router
        .listForUser(this.configuration.targetUserId)
        .map((pending) => pending.code),
    );
    for (const code of this.unsentCodes) {
      if (!activeCodes.has(code)) {
        this.unsentCodes.delete(code);
      }
    }
  }

  private scheduleRetry(): void {
    if (
      this.retryTimer ||
      !this.client ||
      this.authenticatedClient !== this.client ||
      this.unsentCodes.size === 0
    ) {
      return;
    }
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.flushUnsent();
    }, 5_000);
    this.retryTimer.unref();
  }

  private clearRetry(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private fail(error: string): void {
    this.updateState({ ...this.state, status: "error", error });
  }

  private updateState(state: WeComStateInput): void {
    this.state = {
      ...state,
      holdPromptsWhileAway: this.configuration.holdPromptsWhileAway ?? true,
      heldPrompts: this.heldPromptSummaries(),
      ...(state.error ? { error: state.error } : {}),
    };
    if (!state.error) {
      delete this.state.error;
    }
    this.emit("stateChanged", this.getState());
  }

  private heldPromptSummaries(): WeComHeldPrompt[] {
    return [...this.heldPrompts.values()]
      .map((held) => ({
        sessionId: held.sessionId,
        code: held.code,
        kind: held.kind,
        title: held.title,
        since: held.since,
      }))
      .sort((left, right) => left.since - right.since);
  }
}
