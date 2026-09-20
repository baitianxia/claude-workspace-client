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

function permissionSuggestions(payload: ClaudeHookPayload): unknown[] {
  return Array.isArray(payload.permission_suggestions)
    ? payload.permission_suggestions
    : [];
}

interface PermissionCopy {
  introduction: string;
  question: string;
  allowOnce: string;
  deny: string;
  allowSimilar: string;
}

interface PermissionPrompt {
  body: string;
  optionLabels: string[];
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
      allowSimilar: host
        ? `允许：以后从 ${host} 获取内容时不再询问`
        : "允许：以后获取此类网页内容时不再询问",
    };
  }
  if (toolName === "Bash") {
    return {
      introduction: "权限请求：Claude Code 希望运行下面的命令。",
      question: "是否允许 Claude Code 运行该命令？",
      allowOnce: "允许：仅运行本次命令",
      deny:
        "拒绝：不运行本次命令，并告诉 Claude Code 应如何调整（选择后还需要回复具体调整要求）",
      allowSimilar: "允许：以后运行此类命令时不再询问",
    };
  }
  return {
    introduction: `权限请求：Claude Code 希望使用 ${toolName} 执行下面的操作。`,
    question: "是否允许 Claude Code 执行该操作？",
    allowOnce: "允许：仅执行本次操作",
    deny:
      "拒绝：不执行本次操作，并告诉 Claude Code 应如何调整（选择后还需要回复具体调整要求）",
    allowSimilar: "允许：以后执行此类操作时不再询问",
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

function permissionModeAction(mode: string | null): string | null {
  switch (mode) {
    case "acceptEdits":
      return "自动接受文件编辑";
    case "default":
    case "manual":
      return "恢复逐项权限确认";
    case "auto":
      return "切换到自动模式";
    case "dontAsk":
      return "切换到不再询问模式";
    case "bypassPermissions":
      return "绕过权限检查";
    case "plan":
      return "切换到计划模式";
    default:
      return mode ? `切换到“${truncate(mode, 200)}”权限模式` : null;
  }
}

function permissionSuggestionLabel(
  payload: ClaudeHookPayload,
  value: unknown,
): string {
  const suggestion = asRecord(value);
  const type = textValue(suggestion?.type);
  const destination = textValue(suggestion?.destination);

  if (type === "setMode") {
    const mode = textValue(suggestion?.mode);
    const sessionPrefix = destination === "session" ? "在本会话内" : "以后";
    const action = permissionModeAction(mode);
    return action
      ? `允许：本次操作，并${sessionPrefix}${action}`
      : permissionCopy(payload).allowSimilar;
  }

  if (type === "addDirectories" || type === "removeDirectories") {
    const directories = Array.isArray(suggestion?.directories)
      ? suggestion.directories.flatMap((directoryValue) => {
          const directory = textValue(directoryValue);
          return directory ? [`“${truncate(directory, 500)}”`] : [];
        })
      : [];
    if (directories.length > 0) {
      const action = type === "addDirectories" ? "添加为" : "移出";
      const scope = destination === "session" ? "本会话工作目录" : "工作目录";
      return `允许：本次操作，并将 ${directories.join("、")} ${action}${scope}`;
    }
    return permissionCopy(payload).allowSimilar;
  }

  const rules = Array.isArray(suggestion?.rules) ? suggestion.rules : [];
  const scopes = rules.flatMap((ruleValue) => {
    const scope = permissionRuleScope(ruleValue);
    return scope ? [scope] : [];
  });

  if (
    (type === "replaceRules" || type === "removeRules") &&
    scopes.length > 0
  ) {
    const behavior = textValue(suggestion?.behavior);
    const behaviorLabel =
      behavior === "deny"
        ? "拒绝"
        : behavior === "ask"
          ? "询问"
          : "允许";
    const action = type === "replaceRules" ? "替换" : "移除";
    return `允许：本次操作，并${action}${behaviorLabel}权限规则：${scopes.join("，或")}`;
  }

  const scopeText =
    scopes.length > 0
      ? `允许：以后${scopes.join("，或")}时不再询问`
      : type
        ? `允许：本次操作，并应用 Claude Code 提供的“${truncate(type, 200)}”权限设置`
        : permissionCopy(payload).allowSimilar;
  return scopeText;
}

function permissionDestinationDescription(value: unknown): string | null {
  const destination = textValue(asRecord(value)?.destination);
  if (destination === "session") {
    return "仅当前会话";
  }
  if (destination === "localSettings") {
    return "当前工程本地设置";
  }
  if (destination === "projectSettings") {
    return "当前工程共享设置";
  }
  if (destination === "userSettings") {
    return "用户设置";
  }
  return destination ? truncate(destination, 200) : null;
}

function normalizedPermissionLabel(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim()
    .toLocaleLowerCase("en-US");
}

function duplicatePermissionLabels(labels: string[]): Set<string> {
  const counts = new Map<string, number>();
  for (const label of labels) {
    const normalized = normalizedPermissionLabel(label);
    counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
  }
  return new Set(
    [...counts.entries()].flatMap(([label, count]) =>
      count > 1 ? [label] : [],
    ),
  );
}

function disambiguatePermissionSuggestionLabels(
  suggestions: unknown[],
  labels: string[],
): string[] {
  const duplicateBaseLabels = duplicatePermissionLabels(labels);
  const labelsWithDestinations = labels.map((label, index) => {
    if (!duplicateBaseLabels.has(normalizedPermissionLabel(label))) {
      return label;
    }
    const destination = permissionDestinationDescription(suggestions[index]);
    return destination
      ? `${label}（权限保存范围：${destination}）`
      : label;
  });
  const remainingDuplicates = duplicatePermissionLabels(
    labelsWithDestinations,
  );
  return labelsWithDestinations.map((label, index) =>
    remainingDuplicates.has(normalizedPermissionLabel(label))
      ? `${label}（Claude Code 权限建议 ${index + 1}）`
      : label,
  );
}

function webFetchSuggestionHost(value: unknown): string | null {
  const suggestion = asRecord(value);
  const rules = Array.isArray(suggestion?.rules) ? suggestion.rules : [];
  for (const ruleValue of rules) {
    const rule = asRecord(ruleValue);
    if (textValue(rule?.toolName) !== "WebFetch") {
      continue;
    }
    const ruleContent = textValue(rule?.ruleContent);
    const domain = ruleContent
      ? /^domain:(.+)$/iu.exec(ruleContent)?.[1]?.trim()
      : null;
    if (domain) {
      return truncate(domain, 500);
    }
  }
  return null;
}

function webFetchSuggestionLabel(
  payload: ClaudeHookPayload,
  value: unknown,
): string {
  const suggestion = asRecord(value);
  const type = textValue(suggestion?.type);
  const hasRules = Array.isArray(suggestion?.rules);
  if (type !== "addRules" && !hasRules) {
    return permissionSuggestionLabel(payload, value);
  }
  const suggestionHost = webFetchSuggestionHost(value) ?? webFetchHost(payload);
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
  const suggestions = permissionSuggestions(payload);
  const suggestionLabels = disambiguatePermissionSuggestionLabels(
    suggestions,
    suggestions.map((suggestion) =>
      webFetchSuggestionLabel(payload, suggestion),
    ),
  );
  const optionLabels = [
    "是",
    ...suggestionLabels,
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
  };
}

function permissionPrompt(payload: ClaudeHookPayload): PermissionPrompt {
  if (payload.tool_name === "WebFetch") {
    return webFetchPermissionPrompt(payload);
  }
  const details = toolInputDetails(payload);
  const suggestions = permissionSuggestions(payload);
  const copy = permissionCopy(payload);
  const suggestionLabels = disambiguatePermissionSuggestionLabels(
    suggestions,
    suggestions.map((suggestion) =>
      permissionSuggestionLabel(payload, suggestion),
    ),
  );
  const optionLabels = [
    copy.allowOnce,
    ...suggestionLabels,
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
    return [
      heading,
      "",
      quotedPrompt,
      "",
      "#### 回复选项",
      "",
      ...optionLines,
      `${optionLabels.length + 1}. 输入其他回答（Type something.）`,
      `${optionLabels.length + 2}. 与 Claude 讨论这个问题（Chat about this）`,
      ...(multiSelect ? ["（可多选，使用逗号分隔编号）"] : []),
      "（选择“输入其他回答”或“讨论这个问题”后，企业微信会继续提示你发送具体内容。）",
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
      permissionSuggestionCount: permissionSuggestions(payload).length,
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
