import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildClaudeAssistantArgs,
  ClaudeCodeAssistantRunner,
  parseClaudeAssistantOutput,
  type AssistantChildProcess,
  type ClaudeCodeAssistantInput,
} from "../src/main/claude-code-assistant-runner";
import type { AssistantProfileRecord } from "../src/shared/contracts";

const temporaryDirectories: string[] = [];
const SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";

function profile(
  overrides: Partial<AssistantProfileRecord> = {},
): AssistantProfileRecord {
  return {
    id: "assistant-one",
    name: "小岚",
    enabled: true,
    projectId: "project-one",
    instructions: "先给结论。",
    mcpConfigPath: ".mcp.json",
    allowedMcpServers: ["mail"],
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
    turnId: "turn-one",
    profile: profile(),
    projectRoot: "/project",
    prompt: "整理今天的重点",
    ...overrides,
  };
}

class FakeChildProcess extends EventEmitter implements AssistantChildProcess {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  killed = false;

  kill(): boolean {
    this.killed = true;
    queueMicrotask(() => this.emit("close", 143, "SIGTERM"));
    return true;
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("ClaudeCodeAssistantRunner", () => {
  it("keeps sessions persistent and resumes a fixed session with restricted tools", () => {
    const firstArgs = buildClaudeAssistantArgs(input());
    expect(firstArgs).toContain("--print");
    expect(firstArgs).toContain("--strict-mcp-config");
    expect(firstArgs[firstArgs.indexOf("--tools") + 1]).toBe("");
    expect(firstArgs[firstArgs.indexOf("--allowedTools") + 1]).toBe(
      "mcp__mail__*",
    );
    const systemPrompt =
      firstArgs[firstArgs.indexOf("--append-system-prompt") + 1];
    expect(systemPrompt.indexOf("助理专属指令")).toBeLessThan(
      systemPrompt.indexOf("以下安全边界优先于"),
    );
    expect(firstArgs).not.toContain("--no-session-persistence");
    expect(firstArgs).not.toContain("--resume");

    const resumedArgs = buildClaudeAssistantArgs(
      input({ sessionId: SESSION_ID }),
    );
    expect(resumedArgs.slice(resumedArgs.indexOf("--resume"), -2)).toEqual([
      "--resume",
      SESSION_ID,
    ]);
  });

  it("parses a bounded text reply and requires a valid Claude session id", () => {
    expect(
      parseClaudeAssistantOutput(
        JSON.stringify({ result: "主人，已整理完成。", session_id: SESSION_ID }),
      ),
    ).toEqual({ response: "主人，已整理完成。", sessionId: SESSION_ID });
    expect(() =>
      parseClaudeAssistantOutput(
        JSON.stringify({ result: "ok", session_id: "not-a-session" }),
      ),
    ).toThrow("有效的会话 ID");
  });

  it("loads only explicitly allowed MCP servers", async () => {
    const root = await mkdtemp(join(tmpdir(), "assistant-runner-"));
    temporaryDirectories.push(root);
    const projectRoot = join(root, "project");
    const runtimeRoot = join(root, "runtime");
    await mkdir(projectRoot);
    await writeFile(
      join(projectRoot, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          mail: { command: "mail-server", env: { TOKEN: "private" } },
          unrelated: { command: "other-server" },
        },
      }),
      "utf8",
    );
    let filtered: unknown;
    const runner = new ClaudeCodeAssistantRunner(
      () => "/usr/bin/claude",
      runtimeRoot,
      (_executable, args) => {
        const child = new FakeChildProcess();
        const configPath = args[args.indexOf("--mcp-config") + 1];
        void readFile(configPath, "utf8").then((raw) => {
          filtered = JSON.parse(raw) as unknown;
          child.stdout.emit(
            "data",
            JSON.stringify({ result: "完成", session_id: SESSION_ID }),
          );
          child.emit("close", 0, null);
        });
        return child;
      },
      "darwin",
    );

    const result = await runner.run(
      input({ projectRoot, profile: profile({ allowedMcpServers: ["mail"] }) }),
    );

    expect(result).toMatchObject({
      status: "succeeded",
      response: "完成",
      sessionId: SESSION_ID,
    });
    expect(filtered).toEqual({
      mcpServers: {
        mail: { command: "mail-server", env: { TOKEN: "private" } },
      },
    });
  });

  it("supports pure chat without reading a project MCP file", async () => {
    const root = await mkdtemp(join(tmpdir(), "assistant-runner-empty-"));
    temporaryDirectories.push(root);
    const projectRoot = join(root, "project");
    await mkdir(projectRoot);
    let filtered: unknown;
    const runner = new ClaudeCodeAssistantRunner(
      () => "/usr/bin/claude",
      join(root, "runtime"),
      (_executable, args) => {
        const child = new FakeChildProcess();
        const configPath = args[args.indexOf("--mcp-config") + 1];
        void readFile(configPath, "utf8").then((raw) => {
          filtered = JSON.parse(raw) as unknown;
          child.stdout.emit(
            "data",
            JSON.stringify({ result: "纯对话", session_id: SESSION_ID }),
          );
          child.emit("close", 0, null);
        });
        return child;
      },
      "darwin",
    );

    const result = await runner.run(
      input({
        projectRoot,
        profile: profile({ mcpConfigPath: "", allowedMcpServers: [] }),
      }),
    );

    expect(result.status).toBe("succeeded");
    expect(filtered).toEqual({ mcpServers: {} });
  });

  it("cancels the active Claude Code process for a turn", async () => {
    const root = await mkdtemp(join(tmpdir(), "assistant-runner-cancel-"));
    temporaryDirectories.push(root);
    const projectRoot = join(root, "project");
    await mkdir(projectRoot);
    let child: FakeChildProcess | undefined;
    const runner = new ClaudeCodeAssistantRunner(
      () => "/usr/bin/claude",
      join(root, "runtime"),
      () => {
        child = new FakeChildProcess();
        return child;
      },
      "darwin",
    );

    const pending = runner.run(
      input({
        projectRoot,
        profile: profile({ mcpConfigPath: "", allowedMcpServers: [] }),
      }),
    );
    for (let attempt = 0; !child && attempt < 50; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }

    expect(runner.cancel("turn-one")).toBe(true);
    await expect(pending).resolves.toMatchObject({ status: "cancelled" });
    expect(child?.killed).toBe(true);
  });
});
