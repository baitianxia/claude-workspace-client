import type {
  ClaudeHookEvent,
  ClaudeHookPayload,
} from "./claude-hook-server";
import type {
  RemoteAttention,
  RemoteAttentionKind,
} from "./remote-reply-router";

const MAX_ATTENTION_BODY_LENGTH = 8_000;

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
    return truncate(JSON.stringify(value, null, 2), 4_000);
  } catch {
    return "（无法展示详细参数）";
  }
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
  const input = asRecord(payload.tool_input);
  const description = textValue(input?.description);
  const command = textValue(input?.command);
  const filePath =
    textValue(input?.file_path) ?? textValue(input?.path) ?? textValue(input?.url);
  const details = [
    description ? `说明：${description}` : null,
    command ? `命令：${truncate(command, 3_000)}` : null,
    filePath ? `目标：${truncate(filePath, 2_000)}` : null,
  ].filter((value): value is string => Boolean(value));
  if (details.length === 0 && payload.tool_input !== undefined) {
    details.push(`参数：\n${safeJson(payload.tool_input)}`);
  }
  const suggestions = permissionSuggestions(payload);
  const choices = [
    "回复选项：",
    "1. 允许本次",
    ...suggestions.map(permissionSuggestionText),
    `${suggestions.length + 2}. 拒绝`,
  ];
  return [
    `工具：${payload.tool_name ?? "未知工具"}`,
    ...details,
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
    return [
      `${questions.length > 1 ? `问题 ${questionIndex + 1}：` : ""}${prompt}`,
      ...optionLines,
      ...(multiSelect ? ["（可多选，使用逗号分隔编号）"] : []),
    ];
  });
  return {
    body:
      sections.length > 0
        ? sections.join("\n")
        : `Claude Code 正在询问用户：\n${safeJson(payload.tool_input)}`,
    supportsMultipleSelection,
    questionSelectionModes,
  };
}

function planBody(payload: ClaudeHookPayload): string {
  const input = asRecord(payload.tool_input);
  const plan = textValue(input?.plan);
  return plan
    ? `Claude Code 请求确认以下计划：\n${truncate(plan, 6_000)}`
    : "Claude Code 已完成计划，正在等待是否进入实施。";
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
