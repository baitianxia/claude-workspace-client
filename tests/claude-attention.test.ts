import { describe, expect, it } from "vitest";
import { attentionFromClaudeHook } from "../src/main/claude-attention";
import type { ClaudeHookEvent } from "../src/main/claude-hook-server";

function hook(
  payload: Partial<ClaudeHookEvent["payload"]>,
): ClaudeHookEvent {
  return {
    workspaceSessionId: "workspace-session",
    launchId: "launch-id",
    payload: {
      session_id: "claude-session",
      transcript_path: "C:\\Claude\\transcript.jsonl",
      cwd: "C:\\work\\mall",
      hook_event_name: "Notification",
      ...payload,
    },
  };
}

describe("attentionFromClaudeHook", () => {
  it("includes the exact tool details in permission notifications", () => {
    const attention = attentionFromClaudeHook(
      hook({
        hook_event_name: "PermissionRequest",
        tool_name: "Bash",
        tool_input: {
          command: "npm run test",
          description: "运行测试",
        },
        permission_suggestions: [
          {
            type: "addRules",
            rules: [{ toolName: "Bash", ruleContent: "npm run test" }],
            behavior: "allow",
            destination: "localSettings",
          },
        ],
      }),
    );

    expect(attention).toMatchObject({
      kind: "permission",
      workspaceSessionId: "workspace-session",
      launchId: "launch-id",
      claudeSessionId: "claude-session",
      expectsMenuSelection: true,
      permissionSuggestionCount: 1,
      body: expect.stringMatching(
        /Claude Code 希望运行下面的命令[\s\S]*Bash[\s\S]*运行测试[\s\S]*npm run test[\s\S]*是否允许 Claude Code 运行该命令[\s\S]*1\. 允许：仅运行本次命令[\s\S]*2\. 允许：以后运行符合“npm run test”规则的命令时不再询问[\s\S]*3\. 拒绝：不运行本次命令，并告诉 Claude Code 应如何调整/u,
      ),
    });
  });

  it("matches Claude Code's WebFetch permission dialog line for line", () => {
    const attention = attentionFromClaudeHook(
      hook({
        hook_event_name: "PermissionRequest",
        tool_name: "WebFetch",
        tool_input: {
          url: "https://www.anthropic.com/hook-test",
          prompt: "Hook 生效性测试，返回页面标题即可。",
        },
        permission_suggestions: [
          {
            type: "addRules",
            rules: [
              {
                toolName: "WebFetch",
                ruleContent: "domain:www.anthropic.com",
              },
            ],
            behavior: "allow",
            destination: "localSettings",
          },
        ],
      }),
    );

    expect(attention).toMatchObject({
      kind: "permission",
      permissionSuggestionCount: 1,
      body: [
        "### Fetch",
        "",
        "https://www.anthropic.com/hook-test",
        "Claude 想从 www.anthropic.com 获取内容。",
        "",
        "是否允许 Claude 获取此内容？",
        "1. 是",
        "2. 是，并且以后从 www.anthropic.com 获取内容时不再询问",
        "3. 否，并告诉 Claude 应如何调整（Esc）",
      ].join("\n"),
    });
    expect(attention?.body).not.toContain("Hook 生效性测试");
    expect(attention?.body).not.toContain("工具：WebFetch");
  });

  it("formats AskUserQuestion choices and preserves multi-select behavior", () => {
    const toolInput = {
      questions: [
        {
          header: "监控能力",
          question: "选择需要启用的功能",
          options: [
            { label: "日志", description: "输出详细日志" },
            { label: "指标", description: "收集运行指标" },
          ],
          multiSelect: true,
        },
      ],
    };
    const attention = attentionFromClaudeHook(
      hook({
        hook_event_name: "PreToolUse",
        tool_name: "AskUserQuestion",
        tool_input: toolInput,
      }),
    );
    const permissionEventAttention = attentionFromClaudeHook(
      hook({
        hook_event_name: "PermissionRequest",
        tool_name: "AskUserQuestion",
        tool_input: toolInput,
      }),
    );

    expect(attention).toMatchObject({
      kind: "question",
      expectsMenuSelection: true,
      supportsMultipleSelection: true,
      body: expect.stringMatching(
        /监控能力[\s\S]*选择需要启用的功能[\s\S]*1\. 日志[\s\S]*2\. 指标/u,
      ),
    });
    expect(permissionEventAttention).toEqual(attention);
    expect(permissionEventAttention?.body).not.toContain("允许本次");
    expect(permissionEventAttention?.body).not.toContain('"questions"');
    expect(permissionEventAttention?.body).toContain(
      "3. 输入其他回答（Type something.）",
    );
    expect(permissionEventAttention?.body).toContain(
      "4. 与 Claude 讨论这个问题（Chat about this）",
    );
  });

  it("renders the reported single-choice PermissionRequest as a question", () => {
    const attention = attentionFromClaudeHook(
      hook({
        hook_event_name: "PermissionRequest",
        tool_name: "AskUserQuestion",
        tool_input: {
          questions: [
            {
              question: "这是一条测试消息：你收到确认弹窗/通知了吗？",
              header: "Hook测试",
              options: [
                { label: "收到了", description: "确认弹窗或通知已正常出现" },
                { label: "没收到", description: "没有看到任何确认提示或通知" },
              ],
              multiSelect: false,
            },
          ],
        },
      }),
    );

    expect(attention).toMatchObject({
      kind: "question",
      title: "Claude Code 有问题需要回复",
      questionSelectionModes: ["single"],
      questionOptionLabels: [["收到了", "没收到"]],
      body: expect.stringMatching(
        /Hook测试[\s\S]*你收到确认弹窗\/通知了吗[\s\S]*1\. 收到了[\s\S]*2\. 没收到[\s\S]*3\. 输入其他回答（Type something\.）[\s\S]*4\. 与 Claude 讨论这个问题（Chat about this）/u,
      ),
    });
    expect(attention?.body).not.toContain("允许");
    expect(attention?.body).not.toContain('"questions"');
  });

  it("forwards Claude's exact completed response and background status", () => {
    const attention = attentionFromClaudeHook(
      hook({
        hook_event_name: "Stop",
        last_assistant_message:
          "订单接口已经修复，3 个回归测试全部通过。是否继续发布？",
        background_tasks: [
          {
            type: "shell",
            status: "running",
            description: "持续观察生产日志",
          },
        ],
      }),
    );

    expect(attention).toMatchObject({
      kind: "completion",
      title: "Claude Code 已完成本轮，等待你的下一步",
      expectsMenuSelection: false,
      body: expect.stringMatching(
        /订单接口已经修复[\s\S]*3 个回归测试全部通过[\s\S]*持续观察生产日志/u,
      ),
    });
  });

  it("includes the injected plan and requested implementation permissions", () => {
    const attention = attentionFromClaudeHook(
      hook({
        hook_event_name: "PreToolUse",
        tool_name: "ExitPlanMode",
        tool_input: {
          plan: "1. 修改路由\n2. 运行回归测试",
          planFilePath: "C:\\Claude\\plans\\router.md",
          allowedPrompts: [{ tool: "Bash", prompt: "运行测试" }],
        },
      }),
    );

    expect(attention).toMatchObject({
      kind: "plan",
      body: expect.stringMatching(
        /修改路由[\s\S]*运行回归测试[\s\S]*router\.md[\s\S]*Bash[\s\S]*运行测试/u,
      ),
    });
  });

  it("shows remaining tool parameters but redacts sensitive keyed values", () => {
    const attention = attentionFromClaudeHook(
      hook({
        hook_event_name: "PermissionRequest",
        tool_name: "mcp__deploy__release",
        tool_input: {
          environment: "production",
          release: "2026.08.20",
          access_token: "do-not-forward",
        },
      }),
    );

    expect(attention?.body).toContain("production");
    expect(attention?.body).toContain("2026.08.20");
    expect(attention?.body).toContain("敏感值已隐藏");
    expect(attention?.body).not.toContain("do-not-forward");
  });

  it("forwards background-agent input notifications as freeform replies", () => {
    const attention = attentionFromClaudeHook(
      hook({
        notification_type: "agent_needs_input",
        title: "后台测试任务需要输入",
        message: "是否继续等待集成测试？",
      }),
    );

    expect(attention).toMatchObject({
      kind: "agent",
      title: "后台测试任务需要输入",
      body: "是否继续等待集成测试？",
      expectsMenuSelection: false,
    });
  });

  it("ignores unrelated hook events", () => {
    expect(
      attentionFromClaudeHook(
        hook({ hook_event_name: "PostToolUse", tool_name: "Bash" }),
      ),
    ).toBeNull();
  });
});
