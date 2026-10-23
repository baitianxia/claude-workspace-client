import { describe, expect, it } from "vitest";
import type { ClaudeHookPayload } from "../src/main/claude-hook-server";
import {
  hookOutputFor,
  rememberedPermissionUpdates,
  resolveHeldReply,
  withHeldPlanOptions,
} from "../src/main/remote-hook-decision";
import type { PendingRemoteReply } from "../src/main/remote-reply-router";

function pending(overrides: Partial<PendingRemoteReply>): PendingRemoteReply {
  return {
    workspaceSessionId: "session",
    launchId: "launch",
    claudeSessionId: "claude",
    kind: "permission",
    title: "",
    body: "",
    inputMode: "menu",
    code: "ABCDE",
    userId: "zhangsan",
    createdAt: 0,
    fingerprint: "",
    ...overrides,
  };
}

const permissionPayload: ClaudeHookPayload = {
  session_id: "claude",
  transcript_path: "t.jsonl",
  cwd: "/work",
  hook_event_name: "PermissionRequest",
  tool_name: "Bash",
  tool_input: { command: "npm test" },
  permission_suggestions: [
    {
      type: "addRules",
      rules: [{ toolName: "Bash", ruleContent: "npm test:*" }],
      behavior: "allow",
      destination: "localSettings",
    },
    { type: "setMode", mode: "acceptEdits", destination: "session" },
    { type: "addRules", rules: [{ toolName: "Bash" }], behavior: "deny", destination: "session" },
  ],
};

const permission = pending({
  permissionOptionLabels: ["允许：仅运行本次命令", "允许：以后不再询问", "拒绝"],
  permissionMenuSource: "hook",
  permissionSuggestionCount: 1,
});

const questionPayload: ClaudeHookPayload = {
  session_id: "claude",
  transcript_path: "t.jsonl",
  cwd: "/work",
  hook_event_name: "PreToolUse",
  tool_name: "AskUserQuestion",
  tool_input: {
    questions: [
      {
        header: "发布方式",
        question: "选择发布策略",
        options: [{ label: "直接发布" }, { label: "先灰度" }],
        multiSelect: false,
      },
    ],
  },
};

const question = pending({
  kind: "question",
  questionSelectionModes: ["single"],
  questionOptionLabels: [["直接发布", "先灰度"]],
});

describe("hookOutputFor", () => {
  it("shapes verdicts for each Hook event", () => {
    expect(hookOutputFor("PermissionRequest", { behavior: "allow" })).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "allow" },
      },
    });
    expect(
      hookOutputFor("PermissionRequest", { behavior: "deny", message: "改用只读命令" }),
    ).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "deny", message: "改用只读命令" },
      },
    });
    expect(
      hookOutputFor("PreToolUse", {
        behavior: "allow",
        updatedInput: { questions: [], answers: { q: "a" } },
      }),
    ).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        updatedInput: { questions: [], answers: { q: "a" } },
      },
    });
    expect(hookOutputFor("PreToolUse", { behavior: "deny", message: "再想想" })).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "再想想",
      },
    });
  });
});

describe("resolveHeldReply", () => {
  it("allows, remembers or denies a permission request", () => {
    expect(resolveHeldReply(permission, permissionPayload, "允许")).toMatchObject({
      status: "respond",
      verdict: { behavior: "allow" },
    });
    expect(resolveHeldReply(permission, permissionPayload, "2")).toMatchObject({
      status: "respond",
      verdict: {
        behavior: "allow",
        updatedPermissions: [
          expect.objectContaining({ type: "addRules", behavior: "allow" }),
        ],
      },
    });
    expect(resolveHeldReply(permission, permissionPayload, "拒绝")).toMatchObject({
      status: "stage",
      stage: "permission-denial-reason",
    });
    expect(
      resolveHeldReply(
        { ...permission, replyStage: "permission-denial-reason" },
        permissionPayload,
        "请改用只读命令",
      ),
    ).toMatchObject({
      status: "respond",
      verdict: { behavior: "deny", message: "请改用只读命令" },
    });
    expect(resolveHeldReply(permission, permissionPayload, "9")).toMatchObject({
      status: "reject",
    });
  });

  it("keeps only allow-type rule and directory suggestions for updatedPermissions", () => {
    expect(rememberedPermissionUpdates(permissionPayload)).toEqual([
      expect.objectContaining({ type: "addRules", behavior: "allow" }),
    ]);
  });

  it("answers a question with the chosen label, free text or a message to Claude", () => {
    expect(resolveHeldReply(question, questionPayload, "2")).toMatchObject({
      status: "respond",
      verdict: {
        behavior: "allow",
        updatedInput: expect.objectContaining({ answers: { 选择发布策略: "先灰度" } }),
      },
    });
    expect(resolveHeldReply(question, questionPayload, "先灰度")).toMatchObject({
      status: "respond",
      verdict: {
        behavior: "allow",
        updatedInput: expect.objectContaining({ answers: { 选择发布策略: "先灰度" } }),
      },
    });
    expect(resolveHeldReply(question, questionPayload, "其他：分批 1%")).toMatchObject({
      status: "respond",
      verdict: {
        behavior: "allow",
        updatedInput: expect.objectContaining({ answers: { 选择发布策略: "分批 1%" } }),
      },
    });
    expect(resolveHeldReply(question, questionPayload, "输入其他回答")).toMatchObject({
      status: "stage",
      stage: "question-custom-answer",
    });
    expect(
      resolveHeldReply(
        { ...question, replyStage: "question-custom-answer" },
        questionPayload,
        "分批发布",
      ),
    ).toMatchObject({
      status: "respond",
      verdict: {
        behavior: "allow",
        updatedInput: expect.objectContaining({ answers: { 选择发布策略: "分批发布" } }),
      },
    });
    expect(resolveHeldReply(question, questionPayload, "讨论：比例能改吗")).toMatchObject({
      status: "respond",
      verdict: { behavior: "deny", message: "比例能改吗" },
    });
    expect(resolveHeldReply(question, questionPayload, "3")).toMatchObject({
      status: "reject",
    });
  });

  it("joins multi-select answers and accepts free text per wizard question", () => {
    const multi = pending({
      kind: "question",
      questionSelectionModes: ["multiple"],
      questionOptionLabels: [["日志", "指标", "链路"]],
    });
    const multiPayload: ClaudeHookPayload = {
      ...questionPayload,
      tool_input: {
        questions: [
          {
            question: "启用哪些能力",
            options: [{ label: "日志" }, { label: "指标" }, { label: "链路" }],
            multiSelect: true,
          },
        ],
      },
    };
    expect(resolveHeldReply(multi, multiPayload, "1,3")).toMatchObject({
      status: "respond",
      verdict: {
        behavior: "allow",
        updatedInput: expect.objectContaining({ answers: { 启用哪些能力: "日志, 链路" } }),
      },
    });

    const wizard = pending({
      kind: "question",
      questionSelectionModes: ["single", "single"],
      questionOptionLabels: [["文本文件", "Markdown 文档"], ["空文件", "描述内容"]],
    });
    const wizardPayload: ClaudeHookPayload = {
      ...questionPayload,
      tool_input: {
        questions: [
          { question: "类型？", options: [{ label: "文本文件" }, { label: "Markdown 文档" }] },
          { question: "内容？", options: [{ label: "空文件" }, { label: "描述内容" }] },
        ],
      },
    };
    expect(resolveHeldReply(wizard, wizardPayload, "2;写一段欢迎词")).toMatchObject({
      status: "respond",
      verdict: {
        behavior: "allow",
        updatedInput: expect.objectContaining({
          answers: { "类型？": "Markdown 文档", "内容？": "写一段欢迎词" },
        }),
      },
    });
    expect(resolveHeldReply(wizard, wizardPayload, "1")).toMatchObject({ status: "reject" });
  });

  it("approves or returns a plan", () => {
    const plan = withHeldPlanOptions(
      pending({ kind: "plan", title: "Claude Code 等待计划确认", body: "## 实施计划\n..." }),
    );
    expect(plan.body).toContain("1. 批准计划，开始实施");
    const planPayload: ClaudeHookPayload = {
      ...questionPayload,
      tool_name: "ExitPlanMode",
      tool_input: { plan: "..." },
    };
    expect(resolveHeldReply(plan as PendingRemoteReply, planPayload, "1")).toMatchObject({
      status: "respond",
      verdict: { behavior: "allow" },
    });
    expect(resolveHeldReply(plan as PendingRemoteReply, planPayload, "批准")).toMatchObject({
      status: "respond",
      verdict: { behavior: "allow" },
    });
    expect(resolveHeldReply(plan as PendingRemoteReply, planPayload, "2")).toMatchObject({
      status: "stage",
      stage: "plan-feedback",
    });
    expect(
      resolveHeldReply(plan as PendingRemoteReply, planPayload, "拒绝：先补测试"),
    ).toMatchObject({
      status: "respond",
      verdict: { behavior: "deny", message: "先补测试" },
    });
    expect(resolveHeldReply(plan as PendingRemoteReply, planPayload, "随便")).toMatchObject({
      status: "reject",
    });
  });
});
