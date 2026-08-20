import type {
  ClaudeHookEvent,
  ClaudeHookPayload,
} from "./claude-hook-server";
import type {
  RemoteAttention,
  RemoteAttentionKind,
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
  add("网址", ["url"], 2_000);
  add("查询内容", ["query"], 2_000);
  add("请求内容", ["prompt"], 2_000);
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

function permissionSuggestionText(value: unknown, index: number): string {
  const suggestion = asRecord(value);
  const rules = Array.isArray(suggestion?.rules) ? suggestion.rules : [];
  const ruleLabels = rules.flatMap((ruleValue) => {
    const rule = asRecord(ruleValue);
    const toolName = textValue(rule?.toolName);
    if (!toolName) {
      return [];
    }
    const ruleContent = textValue(rule?.ruleContent);
    return [
      ruleContent
        ? `${toolName}(${truncate(ruleContent, 500)})`
        : toolName,
    ];
  });
  return `${index + 2}. 始终允许${
    ruleLabels.length > 0 ? `：${ruleLabels.join("、")}` : "此类操作"
  }`;
}

function permissionBody(payload: ClaudeHookPayload): string {
  const details = toolInputDetails(payload);
  const suggestions = permissionSuggestions(payload);
  const choices = [
    "回复选项：",
    "1. 允许本次",
    ...suggestions.map(permissionSuggestionText),
    `${suggestions.length + 2}. 拒绝`,
  ];
  return [
    `工具：${payload.tool_name ?? "未知工具"}`,
    ...(details.length > 0 ? details : ["参数：Claude Code 未提供操作详情"]),
    "",
    ...choices,
  ].join("\n");
}

function questionBody(payload: ClaudeHookPayload): {
  body: string;
  supportsMultipleSelection: boolean;
  questionSelectionModes: Array<"single" | "multiple">;
} {
  const input = asRecord(payload.tool_input);
  const questions = Array.isArray(input?.questions) ? input.questions : [];
  let supportsMultipleSelection = false;
  const questionSelectionModes: Array<"single" | "multiple"> = [];
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
    const optionLines = options.flatMap((optionValue, optionIndex) => {
      const option = asRecord(optionValue);
      const label = textValue(option?.label);
      if (!label) {
        return [];
      }
      const description = textValue(option?.description);
      return [
        `${optionIndex + 1}. ${label}${description ? ` — ${description}` : ""}`,
      ];
    });
    const heading =
      questions.length > 1
        ? `### 问题 ${questionIndex + 1}${header ? ` · ${header}` : ""}`
        : `### ${header || "需要你的选择"}`;
    return [
      heading,
      prompt,
      "",
      ...optionLines,
      ...(multiSelect ? ["（可多选，使用逗号分隔编号）"] : []),
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

function baseAttention(
  event: ClaudeHookEvent,
  kind: RemoteAttentionKind,
  title: string,
  body: string,
  expectsMenuSelection: boolean,
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
    expectsMenuSelection,
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
          false,
        )
      : null;
  }
  if (payload.hook_event_name === "PermissionRequest") {
    return {
      ...baseAttention(
        event,
        "permission",
        "Claude Code 需要权限确认",
        permissionBody(payload),
        true,
      ),
      permissionSuggestionCount: permissionSuggestions(payload).length,
    };
  }

  if (
    payload.hook_event_name === "PreToolUse" &&
    payload.tool_name === "AskUserQuestion"
  ) {
    const question = questionBody(payload);
    return baseAttention(
      event,
      "question",
      "Claude Code 有问题需要回复",
      question.body,
      true,
      question.supportsMultipleSelection,
      question.questionSelectionModes,
    );
  }

  if (
    payload.hook_event_name === "PreToolUse" &&
    payload.tool_name === "ExitPlanMode"
  ) {
    return baseAttention(
      event,
      "plan",
      "Claude Code 等待计划确认",
      planBody(payload),
      true,
    );
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
      false,
    );
  }
  if (payload.notification_type === "elicitation_dialog") {
    return baseAttention(
      event,
      "elicitation",
      payload.title?.trim() || "Claude Code 等待外部交互",
      payload.message?.trim() || "Claude Code 正在等待用户完成交互。",
      true,
    );
  }
  if (payload.notification_type === "elicitation_url_dialog") {
    return baseAttention(
      event,
      "elicitation",
      payload.title?.trim() || "Claude Code 等待打开外部链接",
      payload.message?.trim() || "Claude Code 正在等待用户完成外部交互。",
      false,
    );
  }
  if (payload.notification_type === "agent_needs_input") {
    return baseAttention(
      event,
      "agent",
      payload.title?.trim() || "Claude Code 后台任务需要回复",
      payload.message?.trim() || "Claude Code 的后台任务正在等待用户输入。",
      false,
    );
  }
  return null;
}
