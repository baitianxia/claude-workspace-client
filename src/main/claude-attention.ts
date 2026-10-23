import type {
  ClaudeHookEvent,
  ClaudeHookPayload,
} from "./claude-hook-server";
import type {
  RemoteAttention,
  RemoteAttentionKind,
  RemoteInputMode,
} from "./remote-reply-router";

const MAX_ATTENTION_BODY_LENGTH = 8_000;
const SENSITIVE_PARAMETER_KEY =
  /(?:password|passwd|secret|token|api[_-]?key|authorization|cookie|credential|private[_-]?key)/iu;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function textValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function truncate(value: string, length: number): string {
  return value.length <= length ? value : `${value.slice(0, length - 1)}…`;
}

function safeJson(value: unknown): string {
  try {
    return truncate(
      JSON.stringify(
        value,
        (key, nestedValue) =>
          key && SENSITIVE_PARAMETER_KEY.test(key)
            ? "（敏感值已隐藏）"
            : nestedValue,
        2,
      ),
      4_000,
    );
  } catch {
    return "（无法展示详细参数）";
  }
}

function takeInputText(
  input: Record<string, unknown>,
  consumed: Set<string>,
  keys: string[],
): string | null {
  let firstValue: string | null = null;
  for (const key of keys) {
    if (Object.hasOwn(input, key)) {
      consumed.add(key);
    }
    const value = textValue(input[key]);
    if (!firstValue && value) {
      firstValue = value;
    }
  }
  return firstValue;
}

function toolInputDetails(payload: ClaudeHookPayload): string[] {
  const input = asRecord(payload.tool_input);
  if (!input) {
    return payload.tool_input === undefined
      ? []
      : [`参数：\n${safeJson(payload.tool_input)}`];
  }

  const consumed = new Set<string>();
  const details: string[] = [];
  const isWebFetch = payload.tool_name === "WebFetch";
  const add = (label: string, keys: string[], maxLength: number) => {
    const value = takeInputText(input, consumed, keys);
    if (value) {
      details.push(`${label}：${truncate(value, maxLength)}`);
    }
  };

  add("说明", ["description"], 1_500);
  add("命令", ["command"], 3_000);
  add("目标文件", ["file_path", "notebook_path", "path"], 2_000);
  add("计划文件", ["planFilePath"], 2_000);
  add(isWebFetch ? "目标网址" : "网址", ["url"], 2_000);
  add("查询内容", ["query"], 2_000);
  add(isWebFetch ? "获取后的处理要求" : "请求内容", ["prompt"], 2_000);
  add("计划内容", ["plan"], 5_000);
  add("替换前", ["old_string"], 1_500);
  add("替换后", ["new_string"], 1_500);
  add("写入内容预览", ["content", "new_source"], 2_000);

  if (input.allowedPrompts !== undefined) {
    consumed.add("allowedPrompts");
    details.push(`计划申请的权限：\n${safeJson(input.allowedPrompts)}`);
  }

  const remaining = Object.fromEntries(
    Object.entries(input).filter(([key]) => !consumed.has(key)),
  );
  if (Object.keys(remaining).length > 0) {
    details.push(
      `${details.length > 0 ? "其他参数" : "参数"}：\n${safeJson(remaining)}`,
    );
  }
  return details;
}

/**
 * Short texts Claude Code prints in the permission dialog for this request.
 * They let the remote reply path check that the dialog on screen belongs to
 * this notification and not to another queued request with the same menu
 * shape. Kept short so they survive wrapping and truncation in the dialog.
 */
export function permissionIdentityProbes(payload: ClaudeHookPayload): string[] {
  const input = asRecord(payload.tool_input);
  const probes: string[] = [];
  const add = (value: string | null | undefined, length: number) => {
    const text = value?.replace(/\s+/gu, " ").trim();
    if (text) {
      probes.push(text.slice(0, length));
    }
  };
  const command = textValue(input?.command);
  if (command) {
    add(command.split(/\r?\n/u)[0], 24);
  }
  const url = textValue(input?.url);
  if (url) {
    try {
      add(new URL(url).hostname, 64);
    } catch {
      add(url, 32);
    }
  }
  for (const key of ["file_path", "notebook_path", "path", "planFilePath"]) {
    const filePath = textValue(input?.[key]);
    if (filePath) {
      const baseName = filePath.split(/[\\/]/u).filter(Boolean).pop();
      add(baseName ?? filePath, 48);
    }
  }
  // The persistent-allow rows name the directories and rules Claude Code
  // offers to remember, so they identify the dialog as well.
  const summary = permissionSuggestionSummary(payload);
  for (const directory of summary.directories) {
    const baseName = directory.split(/[\\/]/u).filter(Boolean).pop();
    add(baseName ?? directory, 48);
  }
  for (const rule of summary.rules) {
    if (rule.ruleContent) {
      add(rule.ruleContent.replace(/[:*]+$/u, ""), 32);
    }
  }
  if (probes.length === 0 && payload.tool_name) {
    // MCP tools and the like: the dialog names the tool.
    add(payload.tool_name.replace(/^mcp__[^_]+__/u, ""), 48);
  }
  return [...new Set(probes)];
}

function rawPermissionSuggestions(payload: ClaudeHookPayload): unknown[] {
  return Array.isArray(payload.permission_suggestions)
    ? payload.permission_suggestions
    : [];
}

interface PermissionRuleSuggestion {
  toolName: string;
  ruleContent?: string;
}

interface PermissionSuggestionSummary {
  rules: PermissionRuleSuggestion[];
  directories: string[];
  destinations: Set<"session" | "localSettings">;
}

/**
 * Claude Code treats permission_suggestions as update candidates, not as the
 * menu itself. The interactive dialog only exposes allow rules/directories
 * that can be saved to the session or local settings, and combines them into
 * one consent row. The current Claude Code permission renderer does not expose
 * mode updates as a separate row, so setMode is intentionally ignored here.
 */
function permissionSuggestionSummary(
  payload: ClaudeHookPayload,
): PermissionSuggestionSummary {
  const rules: PermissionRuleSuggestion[] = [];
  const directories: string[] = [];
  const destinations = new Set<"session" | "localSettings">();
  const seenRules = new Set<string>();
  const seenDirectories = new Set<string>();

  for (const value of rawPermissionSuggestions(payload)) {
    const suggestion = asRecord(value);
    if (!suggestion) {
      continue;
    }
    const type = textValue(suggestion.type);
    const behavior = textValue(suggestion.behavior);
    if (type === "addDirectories") {
      if (behavior && behavior !== "allow") {
        continue;
      }
    } else if (behavior !== "allow") {
      continue;
    }
    const destination = textValue(suggestion.destination);
    if (destination !== "session" && destination !== "localSettings") {
      continue;
    }
    if (type === "addRules" && Array.isArray(suggestion.rules)) {
      for (const ruleValue of suggestion.rules) {
        const rule = asRecord(ruleValue);
        const toolName = textValue(rule?.toolName);
        if (!toolName) {
          continue;
        }
        let ruleContent: string | undefined;
        if (rule?.ruleContent !== undefined) {
          ruleContent = textValue(rule.ruleContent) ?? undefined;
          if (!ruleContent) {
            continue;
          }
        }
        const key = `${toolName}\u0000${ruleContent ?? ""}`;
        if (seenRules.has(key)) {
          continue;
        }
        seenRules.add(key);
        rules.push({ toolName, ...(ruleContent ? { ruleContent } : {}) });
        destinations.add(destination);
      }
      continue;
    }

    if (type === "addDirectories" && Array.isArray(suggestion.directories)) {
      for (const directoryValue of suggestion.directories) {
        const directory = textValue(directoryValue);
        if (!directory || seenDirectories.has(directory)) {
          continue;
        }
        seenDirectories.add(directory);
        directories.push(directory);
        destinations.add(destination);
      }
    }
  }

  return { rules, directories, destinations };
}

interface PermissionCopy {
  introduction: string;
  question: string;
  allowOnce: string;
  deny: string;
}

interface PermissionPrompt {
  body: string;
  optionLabels: string[];
  suggestionCount: number;
}

function webFetchHost(payload: ClaudeHookPayload): string | null {
  const input = asRecord(payload.tool_input);
  const url = textValue(input?.url);
  if (!url) {
    return null;
  }
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

function permissionCopy(payload: ClaudeHookPayload): PermissionCopy {
  const toolName = payload.tool_name ?? "未知工具";
  if (toolName === "WebFetch") {
    const host = webFetchHost(payload);
    return {
      introduction: host
        ? `权限请求：Claude Code 希望从 ${host} 获取网页内容。`
        : "权限请求：Claude Code 希望获取网页内容。",
      question: "是否允许 Claude Code 获取该网页内容？",
      allowOnce: "允许：仅获取本次网页内容",
      deny:
        "拒绝：不获取本次网页内容，并告诉 Claude Code 应如何调整（选择后还需要回复具体调整要求）",
    };
  }
  if (toolName === "Bash") {
    return {
      introduction: "权限请求：Claude Code 希望运行下面的命令。",
      question: "是否允许 Claude Code 运行该命令？",
      allowOnce: "允许：仅运行本次命令",
      deny:
        "拒绝：不运行本次命令，并告诉 Claude Code 应如何调整（选择后还需要回复具体调整要求）",
    };
  }
  return {
    introduction: `权限请求：Claude Code 希望使用 ${toolName} 执行下面的操作。`,
    question: "是否允许 Claude Code 执行该操作？",
    allowOnce: "允许：仅执行本次操作",
    deny:
      "拒绝：不执行本次操作，并告诉 Claude Code 应如何调整（选择后还需要回复具体调整要求）",
  };
}

function permissionRuleScope(ruleValue: unknown): string | null {
  const rule = asRecord(ruleValue);
  const toolName = textValue(rule?.toolName);
  if (!toolName) {
    return null;
  }
  const ruleContent = textValue(rule?.ruleContent);
  if (toolName === "WebFetch" && ruleContent) {
    const domain = /^domain:(.+)$/iu.exec(ruleContent)?.[1]?.trim();
    if (domain) {
      return `从 ${truncate(domain, 500)} 获取内容`;
    }
  }
  if (toolName === "Bash") {
    return ruleContent
      ? `运行符合“${truncate(ruleContent, 500)}”规则的命令`
      : "运行 Bash 命令";
  }
  return ruleContent
    ? `使用 ${toolName}（范围：${truncate(ruleContent, 500)}）`
    : `使用 ${toolName}`;
}

function permissionSuggestionLabel(
  summary: PermissionSuggestionSummary,
): string | null {
  const scopes = summary.rules.flatMap((rule) => {
    const scope = permissionRuleScope(rule);
    return scope ? [scope] : [];
  });
  const directories = summary.directories.map((directory) =>
    `“${truncate(directory, 500)}”`,
  );
  if (scopes.length === 0 && directories.length === 0) {
    return null;
  }

  if (scopes.length > 0 && directories.length > 0) {
    return `允许：以后${scopes.join("，或")}时不再询问，并将 ${directories.join("、")} 添加为工作目录`;
  }
  if (scopes.length > 0) {
    return `允许：以后${scopes.join("，或")}时不再询问`;
  }

  const sessionOnly =
    summary.destinations.size === 1 && summary.destinations.has("session");
  if (directories.length > 0) {
    return `允许：本次操作，并将 ${directories.join("、")} 添加为${sessionOnly ? "本会话工作目录" : "工作目录"}`;
  }
  return null;
}

function webFetchSuggestionLabel(
  payload: ClaudeHookPayload,
  summary: PermissionSuggestionSummary,
): string | null {
  if (summary.rules.length === 0) {
    const generic = permissionSuggestionLabel(summary);
    return generic ? generic.replace(/^允许：/u, "是，") : null;
  }
  const suggestionHost =
    summary.rules
      .map((rule) =>
        rule.toolName === "WebFetch" && rule.ruleContent
          ? /^domain:(.+)$/iu.exec(rule.ruleContent)?.[1]?.trim() ?? null
          : null,
      )
      .find((value): value is string => Boolean(value)) ?? webFetchHost(payload);
  return suggestionHost
    ? `是，并且以后从 ${suggestionHost} 获取内容时不再询问`
    : "是，并且以后获取此类内容时不再询问";
}

function webFetchPermissionPrompt(
  payload: ClaudeHookPayload,
): PermissionPrompt {
  const input = asRecord(payload.tool_input);
  const url = textValue(input?.url);
  const host = webFetchHost(payload);
  const summary = permissionSuggestionSummary(payload);
  const suggestionLabel = webFetchSuggestionLabel(payload, summary);
  const optionLabels = [
    "是",
    ...(suggestionLabel ? [suggestionLabel] : []),
    "否，并告诉 Claude 应如何调整（Esc）",
  ];
  return {
    body: [
      "### Fetch",
      "",
      url ?? "（Hook 未提供目标网址）",
      host ? `Claude 想从 ${host} 获取内容。` : "Claude 想获取网页内容。",
      "",
      "是否允许 Claude 获取此内容？",
      ...optionLabels.map((label, index) => `${index + 1}. ${label}`),
    ].join("\n"),
    optionLabels,
    suggestionCount: optionLabels.length - 2,
  };
}

function permissionPrompt(payload: ClaudeHookPayload): PermissionPrompt {
  if (payload.tool_name === "WebFetch") {
    return webFetchPermissionPrompt(payload);
  }
  const details = toolInputDetails(payload);
  const copy = permissionCopy(payload);
  const summary = permissionSuggestionSummary(payload);
  const suggestionLabel = permissionSuggestionLabel(summary);
  const optionLabels = [
    copy.allowOnce,
    ...(suggestionLabel ? [suggestionLabel] : []),
    copy.deny,
  ];
  return {
    body: [
      copy.introduction,
      "",
      `工具：${payload.tool_name ?? "未知工具"}`,
      ...(details.length > 0
        ? details
        : ["参数：Claude Code 未提供操作详情"]),
      "",
      copy.question,
      ...optionLabels.map((label, index) => `${index + 1}. ${label}`),
    ].join("\n"),
    optionLabels,
    suggestionCount: optionLabels.length - 2,
  };
}

function questionBody(payload: ClaudeHookPayload): {
  body: string;
  supportsMultipleSelection: boolean;
  questionSelectionModes: Array<"single" | "multiple">;
  questionOptionLabels: string[][];
} {
  const input = asRecord(payload.tool_input);
  const questions = Array.isArray(input?.questions) ? input.questions : [];
  let supportsMultipleSelection = false;
  const questionSelectionModes: Array<"single" | "multiple"> = [];
  const questionOptionLabels: string[][] = [];
  const sections = questions.flatMap((questionValue, questionIndex) => {
    const question = asRecord(questionValue);
    const prompt = textValue(question?.question);
    if (!prompt) {
      return [];
    }
    const header = textValue(question?.header);
    const multiSelect = question?.multiSelect === true;
    supportsMultipleSelection ||= multiSelect;
    questionSelectionModes.push(multiSelect ? "multiple" : "single");
    const options = Array.isArray(question?.options) ? question.options : [];
    const optionLabels: string[] = [];
    const optionLines = options.flatMap((optionValue) => {
      const option = asRecord(optionValue);
      const label = textValue(option?.label);
      if (!label) {
        return [];
      }
      optionLabels.push(label);
      const description = textValue(option?.description);
      return [
        `${optionLabels.length}. ${label}${description ? ` — ${description}` : ""}`,
      ];
    });
    questionOptionLabels.push(optionLabels);
    const heading =
      questions.length > 1
        ? `### ${questionIndex + 1}. ${header ? `问题主题：${header}` : "需要你的选择"}`
        : `### ${header ? `问题主题：${header}` : "需要你的选择"}`;
    const quotedPrompt = prompt
      .split(/\r?\n/gu)
      .map((line) => `> ${line}`)
      .join("\n");
    // Only Claude's own options get numbers: they are the only rows the Hook
    // payload describes. Whether the terminal also shows "Type something" and
    // "Chat about this" depends on the Claude Code version, the question type
    // and its layout, so those are offered as keywords and resolved against
    // the screen when the reply arrives.
    return [
      heading,
      "",
      quotedPrompt,
      "",
      "#### 回复选项",
      "",
      ...optionLines,
      ...(multiSelect ? ["（可多选，使用逗号分隔编号）"] : []),
      ...(questions.length > 1
        ? []
        : [
            "",
            "自由回答：回复「其他：你的内容」",
            ...(multiSelect ? [] : ["想和 Claude 讨论：回复「讨论：你想说的内容」"]),
            "（以上两项是否可用以终端为准，不可用时会提示你。）",
          ]),
      "",
    ];
  });
  return {
    body:
      sections.length > 0
        ? sections.join("\n").trim()
        : `Claude Code 正在询问用户：\n${safeJson(payload.tool_input)}`,
    supportsMultipleSelection,
    questionSelectionModes,
    questionOptionLabels,
  };
}

function planBody(payload: ClaudeHookPayload): string {
  const input = asRecord(payload.tool_input);
  const plan = textValue(input?.plan);
  const planFilePath = textValue(input?.planFilePath);
  const allowedPrompts = Array.isArray(input?.allowedPrompts)
    ? input.allowedPrompts
    : [];
  const sections = [
    plan ? `## 实施计划\n${truncate(plan, 6_000)}` : null,
    planFilePath ? `计划文件：${truncate(planFilePath, 1_000)}` : null,
    allowedPrompts.length > 0
      ? `## 实施阶段申请的权限\n${safeJson(allowedPrompts)}`
      : null,
  ].filter((value): value is string => Boolean(value));
  return sections.length > 0
    ? sections.join("\n\n")
    : `Claude Code 已完成计划，但 Hook 未提供计划正文。\n参数：\n${safeJson(payload.tool_input)}`;
}

function backgroundTaskSummary(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((taskValue, index) => {
    const task = asRecord(taskValue);
    if (!task) {
      return [];
    }
    const status = textValue(task.status) ?? "状态未知";
    const description =
      textValue(task.description) ??
      textValue(task.command) ??
      textValue(task.name) ??
      textValue(task.type) ??
      `任务 ${index + 1}`;
    return [`- ${status}：${truncate(description, 1_000)}`];
  });
}

function completionBody(payload: ClaudeHookPayload): string | null {
  const message = textValue(payload.last_assistant_message);
  if (!message) {
    return null;
  }
  const tasks = backgroundTaskSummary(payload.background_tasks);
  return [
    `## Claude Code 的回复\n${truncate(message, 7_000)}`,
    ...(tasks.length > 0
      ? [`## 仍在运行的后台任务\n${tasks.join("\n")}`]
      : []),
  ].join("\n\n");
}

function failureBody(payload: ClaudeHookPayload): string | null {
  const message =
    textValue(payload.last_assistant_message) ??
    textValue(payload.error_details) ??
    textValue(payload.error) ??
    textValue(payload.message);
  if (!message) {
    return null;
  }
  return `## Claude Code 本轮未完成\n${truncate(message, 7_000)}`;
}

function baseAttention(
  event: ClaudeHookEvent,
  kind: RemoteAttentionKind,
  title: string,
  body: string,
  inputMode: RemoteInputMode,
  supportsMultipleSelection = false,
  questionSelectionModes?: Array<"single" | "multiple">,
): RemoteAttention {
  return {
    workspaceSessionId: event.workspaceSessionId,
    launchId: event.launchId,
    claudeSessionId: event.payload.session_id,
    kind,
    title,
    body: truncate(body, MAX_ATTENTION_BODY_LENGTH),
    inputMode,
    ...(supportsMultipleSelection ? { supportsMultipleSelection: true } : {}),
    ...(questionSelectionModes && questionSelectionModes.length > 0
      ? { questionSelectionModes }
      : {}),
  };
}

export function attentionFromClaudeHook(
  event: ClaudeHookEvent,
): RemoteAttention | null {
  const payload = event.payload;
  if (payload.hook_event_name === "Stop") {
    const body = completionBody(payload);
    return body
      ? baseAttention(
          event,
          "completion",
          "Claude Code 已完成本轮，等待你的下一步",
          body,
          "text",
        )
      : null;
  }
  if (payload.hook_event_name === "StopFailure") {
    const body = failureBody(payload);
    return body
      ? baseAttention(
          event,
          "completion",
          "Claude Code 本轮未完成",
          body,
          "text",
        )
      : null;
  }
  if (
    ["PreToolUse", "PermissionRequest"].includes(payload.hook_event_name) &&
    payload.tool_name === "AskUserQuestion"
  ) {
    const question = questionBody(payload);
    return {
      ...baseAttention(
        event,
        "question",
        "Claude Code 有问题需要回复",
        question.body,
        "menu",
        question.supportsMultipleSelection,
        question.questionSelectionModes,
      ),
      questionOptionLabels: question.questionOptionLabels,
    };
  }

  if (
    ["PreToolUse", "PermissionRequest"].includes(payload.hook_event_name) &&
    payload.tool_name === "ExitPlanMode"
  ) {
    return baseAttention(
      event,
      "plan",
      "Claude Code 等待计划确认",
      planBody(payload),
      "menu",
    );
  }

  if (payload.hook_event_name === "PermissionRequest") {
    const prompt = permissionPrompt(payload);
    return {
      ...baseAttention(
        event,
        "permission",
        "Claude Code 需要权限确认",
        prompt.body,
        "menu",
      ),
      permissionOptionLabels: prompt.optionLabels,
      permissionMenuSource: "hook",
      permissionSuggestionCount: prompt.suggestionCount,
      identityProbes: permissionIdentityProbes(payload),
    };
  }

  if (payload.hook_event_name !== "Notification") {
    return null;
  }
  if (payload.notification_type === "idle_prompt") {
    return baseAttention(
      event,
      "idle",
      payload.title?.trim() || "Claude Code 等待下一步回复",
      payload.message?.trim() || "Claude Code 已暂停并等待用户输入。",
      "text",
    );
  }
  if (payload.notification_type === "elicitation_dialog") {
    return baseAttention(
      event,
      "elicitation",
      payload.title?.trim() || "Claude Code 等待外部交互",
      payload.message?.trim() || "Claude Code 正在等待用户完成交互。",
      // Notification only identifies this as an MCP form. It does not prove
      // that the currently focused field is a numbered terminal menu, so keep
      // remote replies as literal text instead of synthesizing arrow keys.
      "text",
    );
  }
  if (payload.notification_type === "elicitation_url_dialog") {
    return baseAttention(
      event,
      "elicitation",
      payload.title?.trim() || "Claude Code 等待打开外部链接",
      payload.message?.trim() || "Claude Code 正在等待用户完成外部交互。",
      "text",
    );
  }
  if (payload.notification_type === "agent_needs_input") {
    return baseAttention(
      event,
      "agent",
      payload.title?.trim() || "Claude Code 后台任务需要回复",
      payload.message?.trim() || "Claude Code 的后台任务正在等待用户输入。",
      "text",
    );
  }
  if (payload.notification_type === "permission_prompt") {
    // Notification has no tool input or menu layout. In particular, guessing
    // the deny index could select a persistent allow option instead.
    return baseAttention(
      event,
      "permission",
      textValue(payload.title) ?? "Claude Code 需要权限确认",
      textValue(payload.message) ?? "Claude Code 正在等待权限确认。",
      "none",
    );
  }
  return null;
}

/**
 * Replace the permission menu in a Hook-derived attention with labels read
 * from Claude Code's current terminal render. Hook suggestions are only
 * candidates, so this is the authoritative path whenever the screen can be
 * read; callers may keep the original attention when no menu is visible yet.
 */
export function withRenderedPermissionMenu(
  attention: RemoteAttention,
  labels: string[],
  sequence?: number,
): RemoteAttention {
  if (attention.kind !== "permission" || labels.length < 2) {
    return attention;
  }
  const normalized = labels.map((label) => label.trim());
  if (normalized.some((label) => !label)) {
    return attention;
  }
  const lines = attention.body.split(/\r?\n/u);
  let menuStart = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (/^\s*1\.[ \t\u00a0]+\S/u.test(lines[index])) {
      menuStart = index;
      break;
    }
  }
  if (menuStart < 0) {
    return attention;
  }
  return {
    ...attention,
    body: [
      ...lines.slice(0, menuStart),
      ...normalized.map((label, index) => `${index + 1}. ${label}`),
    ].join("\n"),
    permissionOptionLabels: normalized,
    permissionMenuSource: "rendered",
    ...(sequence !== undefined ? { permissionMenuSequence: sequence } : {}),
    permissionSuggestionCount: Math.max(0, normalized.length - 2),
  };
}

/**
 * Attach the menu Claude Code drew for a prompt whose Hook payload does not
 * describe its rows (plan approval). The rows are appended to the body so
 * the WeCom user can answer by number, and kept so the reply path can check
 * that the terminal still shows the same menu.
 */
export function withRenderedMenuLabels(
  attention: RemoteAttention,
  labels: string[],
): RemoteAttention {
  if (attention.kind !== "plan" || labels.length < 2) {
    return attention;
  }
  const normalized = labels.map((label) => label.trim());
  if (normalized.some((label) => !label)) {
    return attention;
  }
  return {
    ...attention,
    body: [
      attention.body,
      "",
      "## 终端当前选项",
      ...normalized.map((label, index) => `${index + 1}. ${label}`),
    ].join("\n"),
    renderedMenuLabels: normalized,
  };
}
