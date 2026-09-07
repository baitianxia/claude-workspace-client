import { describe, expect, it } from "vitest";
import {
  buildAssistantSdkOptions,
  ClaudeCodeAssistantRunner,
  type ClaudeCodeAssistantInput,
  type ClaudeSdkQueryFactory,
} from "../src/main/claude-code-assistant-runner";
import type { AssistantProfileRecord } from "../src/shared/contracts";

const SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";
const FIRST_TURN = "550e8400-e29b-41d4-a716-446655440010";
const SECOND_TURN = "550e8400-e29b-41d4-a716-446655440011";

function profile(
  overrides: Partial<AssistantProfileRecord> = {},
): AssistantProfileRecord {
  return {
    id: "assistant-one",
    name: "小岚",
    enabled: true,
    projectPath: "/project",
    projectId: "project-one",
    instructions: "先给结论。",
    ownerWeComUserId: "zhangsan",
    timeoutMinutes: 20,
    maxTurns: 20,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function input(
  overrides: Partial<ClaudeCodeAssistantInput> = {},
): ClaudeCodeAssistantInput {
  return {
    turnId: FIRST_TURN,
    profile: profile(),
    projectRoot: "/project",
    prompt: "整理今天的重点",
    ...overrides,
  };
}

class FakeQuery {
  readonly userMessages: Array<{ uuid?: string; message?: unknown }> = [];
  interruptCalls = 0;
  closeCalls = 0;
  private readonly values: unknown[] = [];
  private readonly waiters: Array<(value: IteratorResult<unknown>) => void> = [];
  private ended = false;

  constructor(private readonly endOnClose = true) {}

  push(value: unknown): void {
    if (this.ended) {
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value, done: false });
    } else {
      this.values.push(value);
    }
  }

  async interrupt(): Promise<void> {
    this.interruptCalls += 1;
  }

  close(): void {
    this.closeCalls += 1;
    if (!this.endOnClose) {
      return;
    }
    this.end();
  }

  end(): void {
    if (this.ended) {
      return;
    }
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value !== undefined) {
          return Promise.resolve({ value, done: false });
        }
        if (this.ended) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

function successResult(turnId: string, response: string) {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    result: response,
    session_id: SESSION_ID,
    user_message_uuid: turnId,
  };
}

function automaticFactory(state: {
  calls: Array<Parameters<ClaudeSdkQueryFactory>[0]>;
  queries: FakeQuery[];
}): ClaudeSdkQueryFactory {
  return ((parameters: Parameters<ClaudeSdkQueryFactory>[0]) => {
    state.calls.push(parameters);
    const query = new FakeQuery();
    state.queries.push(query);
    const stream = parameters.prompt;
    if (typeof stream === "string") {
      throw new Error("owner chat must use streaming input");
    }
    query.push({
      type: "system",
      subtype: "init",
      session_id: SESSION_ID,
    });
    void (async () => {
      let index = 0;
      for await (const message of stream) {
        const entry = message as { uuid?: string; message?: unknown };
        query.userMessages.push(entry);
        index += 1;
        query.push(successResult(entry.uuid ?? "", `回复 ${index}`));
      }
    })();
    return query as unknown as ReturnType<ClaudeSdkQueryFactory>;
  }) as ClaudeSdkQueryFactory;
}

describe("ClaudeCodeAssistantRunner", () => {
  it("keeps the owner's local capabilities but routes scheduling through the app", () => {
    const taskServer = {} as never;
    const options = buildAssistantSdkOptions(
      input({ taskMcpServer: taskServer }),
      "/usr/bin/claude",
    );

    expect(options).toMatchObject({
      cwd: "/project",
      pathToClaudeCodeExecutable: "/usr/bin/claude",
      settingSources: ["user", "project", "local"],
      tools: { type: "preset", preset: "claude_code" },
      skills: "all",
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      persistSession: true,
      mcpServers: { assistant_tasks: taskServer },
      disallowedTools: [
        "CronCreate",
        "CronDelete",
        "CronList",
        "ScheduleWakeup",
        "RemoteTrigger",
      ],
    });
    expect(options).not.toHaveProperty("resume");
    expect(options).not.toHaveProperty("maxTurns");
    expect(JSON.stringify(options)).not.toContain("allowedMcpServers");
    expect(String(options.systemPrompt && JSON.stringify(options.systemPrompt))).toContain(
      "mcp__assistant_tasks__*",
    );
  });

  it("keeps one live streaming query for consecutive owner messages", async () => {
    const state: {
      calls: Array<Parameters<ClaudeSdkQueryFactory>[0]>;
      queries: FakeQuery[];
    } = { calls: [], queries: [] };
    const savedSessionIds: string[] = [];
    const runner = new ClaudeCodeAssistantRunner(
      () => "/usr/bin/claude",
      automaticFactory(state),
    );

    const first = await runner.run(
      input({
        onSessionId: (sessionId) => {
          savedSessionIds.push(sessionId);
        },
      }),
    );
    const second = await runner.run(
      input({ turnId: SECOND_TURN, prompt: "继续处理" }),
    );

    expect(first).toMatchObject({
      status: "succeeded",
      response: "回复 1",
      sessionId: SESSION_ID,
    });
    expect(second).toMatchObject({
      status: "succeeded",
      response: "回复 2",
      sessionId: SESSION_ID,
    });
    expect(state.calls).toHaveLength(1);
    expect(state.queries[0].userMessages.map((message) => message.uuid)).toEqual([
      FIRST_TURN,
      SECOND_TURN,
    ]);
    expect(savedSessionIds).toEqual([SESSION_ID]);
    expect(runner.listOpenAssistantIds()).toEqual(["assistant-one"]);

    await runner.close("assistant-one");
  });

  it("resumes only after the live owner query has been explicitly closed", async () => {
    const state: {
      calls: Array<Parameters<ClaudeSdkQueryFactory>[0]>;
      queries: FakeQuery[];
    } = { calls: [], queries: [] };
    const runner = new ClaudeCodeAssistantRunner(
      () => "/usr/bin/claude",
      automaticFactory(state),
    );

    await runner.run(input());
    await runner.close("assistant-one");
    await runner.run(
      input({
        turnId: SECOND_TURN,
        prompt: "关闭后继续",
        sessionId: SESSION_ID,
      }),
    );

    expect(state.calls).toHaveLength(2);
    expect(state.calls[0].options).not.toHaveProperty("resume");
    expect(state.calls[1].options).toMatchObject({ resume: SESSION_ID });
    expect(state.queries[0].closeCalls).toBeGreaterThan(0);

    await runner.close("assistant-one");
  });

  it("detaches a closed session without waiting for SDK iterator shutdown", async () => {
    const state: {
      calls: Array<Parameters<ClaudeSdkQueryFactory>[0]>;
      queries: FakeQuery[];
    } = { calls: [], queries: [] };
    const runner = new ClaudeCodeAssistantRunner(
      () => "/usr/bin/claude",
      ((parameters: Parameters<ClaudeSdkQueryFactory>[0]) => {
        state.calls.push(parameters);
        const query = new FakeQuery(false);
        state.queries.push(query);
        const stream = parameters.prompt;
        if (typeof stream === "string") {
          throw new Error("owner chat must use streaming input");
        }
        query.push({
          type: "system",
          subtype: "init",
          session_id: SESSION_ID,
        });
        void (async () => {
          for await (const message of stream) {
            query.push(successResult((message as { uuid?: string }).uuid ?? "", "完成"));
          }
        })();
        return query as unknown as ReturnType<ClaudeSdkQueryFactory>;
      }) as ClaudeSdkQueryFactory,
    );

    await runner.run(input());
    const closePromise = runner.close("assistant-one");
    await expect(
      Promise.race([
        closePromise.then(() => "closed"),
        new Promise<string>((resolve) => setTimeout(() => resolve("timed-out"), 100)),
      ]),
    ).resolves.toBe("closed");
    expect(runner.listOpenAssistantIds()).toEqual([]);

    // Let the fake SDK iterator finish so the test does not leave a pending
    // async loop behind. A real SDK query may take much longer to observe EOF.
    state.queries[0]?.end();
  });

  it("rejects an invalid persisted resume id before starting Claude Code", () => {
    expect(() =>
      buildAssistantSdkOptions(
        input({ sessionId: "not-a-session-id" }),
        "/usr/bin/claude",
      ),
    ).toThrow("会话 ID 格式无效");
  });

  it("wraps Windows script installations instead of asking the SDK to spawn them directly", () => {
    const options = buildAssistantSdkOptions(
      input(),
      "C:\\Users\\developer\\AppData\\Roaming\\npm\\claude.cmd",
      "win32",
    );

    expect(options.spawnClaudeCodeProcess).toBeTypeOf("function");
  });
});
