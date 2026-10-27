import type { ClaudeHookPayload } from "./claude-hook-server";
import {
  questionSelectionsForLabels,
  terminalActionForRemoteReply,
  type PendingRemoteReply,
  type RemoteAttention,
  type RemoteReplyStage,
} from "./remote-reply-router";

/**
 * Answering Claude Code prompts through the Hook response.
 *
 * While the owner is away, the bridge keeps PermissionRequest / PreToolUse
 * Hooks open instead of letting Claude Code draw a dialog. The WeCom reply is
 * then turned into the Hook's JSON output: Claude Code applies it directly,
 * so there is no menu to read, no pointer to move and nothing that can land
 * on the wrong row. This module is the pure translation layer; the bridge
 * owns the held connections.
 */

export type HookVerdict =
  | {
      behavior: "allow";
      updatedInput?: Record<string, unknown>;
      updatedPermissions?: unknown[];
    }
  | { behavior: "deny"; message?: string };

/** The Hook output object Claude Code expects for a verdict. */
export function hookOutputFor(
  hookEventName: string,
  verdict: HookVerdict,
): Record<string, unknown> {
  if (hookEventName === "PermissionRequest") {
    return {
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision:
          verdict.behavior === "allow"
            ? {
                behavior: "allow",
                ...(verdict.updatedInput ? { updatedInput: verdict.updatedInput } : {}),
                ...(verdict.updatedPermissions && verdict.updatedPermissions.length > 0
                  ? { updatedPermissions: verdict.updatedPermissions }
                  : {}),
              }
            : {
                behavior: "deny",
                ...(verdict.message ? { message: verdict.message } : {}),
              },
      },
    };
  }
  // PreToolUse (AskUserQuestion, ExitPlanMode).
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      ...(verdict.behavior === "allow"
        ? {
            permissionDecision: "allow",
            ...(verdict.updatedInput ? { updatedInput: verdict.updatedInput } : {}),
          }
        : {
            permissionDecision: "deny",
            ...(verdict.message ? { permissionDecisionReason: verdict.message } : {}),
          }),
    },
  };
}

export const HELD_PLAN_OPTION_LABELS = [
  "批准计划，开始实施",
  "拒绝，并说明需要修改的地方（选择后再回复意见）",
];

/**
 * A plan-approval notification for a held prompt: the Hook payload carries
 * no menu and no dialog will be drawn, so the two answers the Hook protocol
 * can express are offered instead.
 */
export function withHeldPlanOptions(attention: RemoteAttention): RemoteAttention {
  if (attention.kind !== "plan") {
    return attention;
  }
  return {
    ...attention,
    body: [
      attention.body,
      "",
      "## 可用回复",
      ...HELD_PLAN_OPTION_LABELS.map((label, index) => `${index + 1}. ${label}`),
      "也可直接发送「拒绝：修改意见」一步完成。",
    ].join("\n"),
    renderedMenuLabels: [...HELD_PLAN_OPTION_LABELS],
  };
}

export type HeldReplyResolution =
  | { status: "respond"; verdict: HookVerdict; summary: string }
  | { status: "stage"; stage: RemoteReplyStage; message: string }
  | { status: "reject"; message: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function questionTexts(payload: ClaudeHookPayload): string[] {
  const input = asRecord(payload.tool_input);
  const questions = Array.isArray(input?.questions) ? input.questions : [];
  return questions.map((question) => {
    const text = asRecord(question)?.question;
    return typeof text === "string" ? text : "";
  });
}

function answersInput(
  payload: ClaudeHookPayload,
  answers: Record<string, string>,
): Record<string, unknown> {
  return { ...(asRecord(payload.tool_input) ?? {}), answers };
}

/**
 * The permission updates Claude Code offered to remember for this request,
 * in the shape its Hook decision accepts (the dialog's "don't ask again"
 * row applies the same list).
 */
export function rememberedPermissionUpdates(payload: ClaudeHookPayload): unknown[] {
  const suggestions = Array.isArray(payload.permission_suggestions)
    ? payload.permission_suggestions
    : [];
  return suggestions.filter((value) => {
    const suggestion = asRecord(value);
    if (!suggestion) {
      return false;
    }
    const type = suggestion.type;
    const behavior = suggestion.behavior;
    if (type !== "addRules" && type !== "addDirectories") {
      return false;
    }
    return behavior === undefined || behavior === "allow";
  });
}

const PLAN_APPROVE = /^(?:1|批准|批准计划|同意|允许|通过|yes|y|ok|approve)$/iu;
const PLAN_REJECT = /^(?:2|拒绝|否|不|no|n|reject)$/iu;
const PLAN_REJECT_WITH_REASON = /^(?:2|拒绝|否|不|no|reject)\s*[：:]\s*([\s\S]+)$/iu;

function permissionOptionCount(pending: PendingRemoteReply): number {
  const labels = pending.permissionOptionLabels;
  if (labels && labels.length >= 2) {
    return labels.length;
  }
  return Math.max(0, Math.floor(pending.permissionSuggestionCount ?? 0)) + 2;
}

/**
 * Translate a WeCom reply to a held prompt into a Hook verdict, a request for
 * more text, or a rejection. `payload` is the Hook payload the prompt came
 * from (it carries the questions and permission suggestions).
 */
export function resolveHeldReply(
  pending: PendingRemoteReply,
  payload: ClaudeHookPayload,
  reply: string,
): HeldReplyResolution {
  const text = reply.trim();
  if (!text) {
    return { status: "reject", message: "回复内容不能为空。" };
  }
  const questions = questionTexts(payload);

  if (pending.replyStage) {
    switch (pending.replyStage) {
      case "permission-denial-reason":
        return {
          status: "respond",
          verdict: { behavior: "deny", message: text },
          summary: `拒绝，并转达：${text}`,
        };
      case "question-custom-answer":
        return {
          status: "respond",
          verdict: {
            behavior: "allow",
            updatedInput: answersInput(payload, { [questions[0] ?? ""]: text }),
          },
          summary: `回答：${text}`,
        };
      case "question-chat-message":
        return {
          status: "respond",
          verdict: { behavior: "deny", message: text },
          summary: `不选择选项，转而告诉 Claude：${text}`,
        };
      case "plan-feedback":
        return {
          status: "respond",
          verdict: { behavior: "deny", message: text },
          summary: `退回计划，并反馈：${text}`,
        };
    }
  }

  if (pending.kind === "permission") {
    let selection: number;
    try {
      const action = terminalActionForRemoteReply(pending, reply);
      selection = action.menuSelections?.[0] ?? Number.NaN;
    } catch (error) {
      return {
        status: "reject",
        message: error instanceof Error ? error.message : "权限回复无效。",
      };
    }
    const optionCount = permissionOptionCount(pending);
    if (!Number.isInteger(selection)) {
      return { status: "reject", message: "权限回复无效，请回复允许、拒绝或选项编号。" };
    }
    if (selection === 1) {
      return {
        status: "respond",
        verdict: { behavior: "allow" },
        summary: "允许本次操作",
      };
    }
    if (selection === optionCount) {
      return {
        status: "stage",
        stage: "permission-denial-reason",
        message: "已选择拒绝。请继续回复拒绝原因，或告诉 Claude Code 应该如何调整。",
      };
    }
    const updates = rememberedPermissionUpdates(payload);
    if (updates.length === 0) {
      return {
        status: "reject",
        message: "这条请求没有可记住的授权规则，请回复允许或拒绝。",
      };
    }
    return {
      status: "respond",
      verdict: { behavior: "allow", updatedPermissions: updates },
      summary: "允许，并记住这条授权规则",
    };
  }

  if (pending.kind === "question") {
    const modes = pending.questionSelectionModes ?? [];
    const labels = pending.questionOptionLabels ?? [];
    if (modes.length > 1) {
      // The multi-question wizard: one answer per question, in order. An
      // answer that names no option is sent as free text, which the Hook
      // protocol accepts even though the terminal wizard would not.
      const answers = text.split(/\s*(?:;|；|\r?\n)\s*/u).filter(Boolean);
      if (answers.length !== modes.length) {
        return {
          status: "reject",
          message: `这组提问有 ${modes.length} 个问题，请按顺序用分号或换行分隔 ${modes.length} 个回答。`,
        };
      }
      const resolved: Record<string, string> = {};
      for (const [index, answer] of answers.entries()) {
        const options = labels[index] ?? [];
        const selections = questionSelectionsForLabels(answer, options);
        if (modes[index] === "single" && selections && selections.length > 1) {
          return {
            status: "reject",
            message: `第 ${index + 1} 个问题是单选题，只能选择一个选项。`,
          };
        }
        const value =
          selections && selections.length > 0
            ? selections.map((selection) => options[selection - 1]).join(", ")
            : answer;
        resolved[questions[index] ?? String(index)] = value;
      }
      return {
        status: "respond",
        verdict: { behavior: "allow", updatedInput: answersInput(payload, resolved) },
        summary: `回答：${Object.values(resolved).join("；")}`,
      };
    }
    let selections: number[];
    let inline: string | undefined;
    try {
      const action = terminalActionForRemoteReply(pending, reply);
      selections = action.menuSelections ?? [];
      inline = action.inlineFollowUp;
    } catch (error) {
      return {
        status: "reject",
        message: error instanceof Error ? error.message : "问题回复无效。",
      };
    }
    const options = labels[0] ?? [];
    const question = questions[0] ?? "";
    if (selections.includes(options.length + 1)) {
      if (inline) {
        return {
          status: "respond",
          verdict: { behavior: "allow", updatedInput: answersInput(payload, { [question]: inline }) },
          summary: `回答：${inline}`,
        };
      }
      return {
        status: "stage",
        stage: "question-custom-answer",
        message: "请继续回复你的具体答案。",
      };
    }
    if (selections.includes(options.length + 2)) {
      if (inline) {
        return {
          status: "respond",
          verdict: { behavior: "deny", message: inline },
          summary: `不选择选项，转而告诉 Claude：${inline}`,
        };
      }
      return {
        status: "stage",
        stage: "question-chat-message",
        message: "请继续回复你想和 Claude 讨论或补充的内容。",
      };
    }
    const chosen = selections
      .filter((selection) => selection >= 1 && selection <= options.length)
      .map((selection) => options[selection - 1]);
    if (chosen.length === 0) {
      return { status: "reject", message: "问题回复无效，请回复选项编号或选项文字。" };
    }
    const value = chosen.join(", ");
    return {
      status: "respond",
      verdict: { behavior: "allow", updatedInput: answersInput(payload, { [question]: value }) },
      summary: `选择：${value}`,
    };
  }

  if (pending.kind === "plan") {
    const withReason = PLAN_REJECT_WITH_REASON.exec(text);
    if (withReason) {
      return {
        status: "respond",
        verdict: { behavior: "deny", message: withReason[1].trim() },
        summary: `退回计划，并反馈：${withReason[1].trim()}`,
      };
    }
    if (PLAN_APPROVE.test(text)) {
      return {
        status: "respond",
        verdict: { behavior: "allow" },
        summary: "批准计划",
      };
    }
    if (PLAN_REJECT.test(text)) {
      return {
        status: "stage",
        stage: "plan-feedback",
        message: "已选择退回计划。请继续回复需要修改的地方。",
      };
    }
    return {
      status: "reject",
      message: "计划回复无效：回复 1 或「批准」开始实施；回复 2 或「拒绝：修改意见」退回计划。",
    };
  }

  return { status: "reject", message: "这类提示不能通过 Hook 直接回复。" };
}
