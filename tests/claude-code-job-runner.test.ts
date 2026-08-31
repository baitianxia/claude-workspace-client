import { EventEmitter } from "node:events";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildClaudeAutomationArgs,
  ClaudeCodeJobRunner,
  parseClaudeAutomationOutput,
  type AutomationChildProcess,
  type ClaudeCodeJobInput,
} from "../src/main/claude-code-job-runner";
import type { AutomationJobRecord } from "../src/shared/contracts";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "claude-job-runner-"));
  temporaryDirectories.push(directory);
  return directory;
}

function job(overrides: Partial<AutomationJobRecord> = {}): AutomationJobRecord {
  return {
    id: "job-one",
    name: "每日资讯",
    enabled: true,
    projectId: "project-one",
    schedule: "0 9 * * 1-5",
    mcpConfigPath: ".mcp.json",
    allowedMcpServers: ["web", "mail"],
    prompt: "读取网页并发送摘要。",
    emailRecipients: ["owner@example.com"],
    wecomTargetIds: ["group-one"],
    allowedWecomUserIds: ["zhangsan"],
    timeoutMinutes: 20,
    maxTurns: 20,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function outputEnvelope(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    session_id: "claude-session-one",
    structured_output: {
      outcome: "notify",
      summary: "发现一条新信息。",
      wecom_markdown: "## 新信息",
      evidence: [{ title: "来源", url: "https://example.com/news" }],
      email: {
        status: "sent",
        recipients: ["owner@example.com"],
        detail: "邮件 MCP 返回成功。",
      },
      ...overrides,
    },
  });
}

class FakeChildProcess extends EventEmitter implements AutomationChildProcess {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  pid = 42;
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

describe("ClaudeCodeJobRunner", () => {
  it("builds a non-interactive command with no built-in tools", () => {
    const input: ClaudeCodeJobInput = {
      runId: "run-one",
      job: job(),
      projectRoot: "/project",
      prompt: "检查网页",
    };

    const args = buildClaudeAutomationArgs(input);

    expect(args).toContain("--print");
    expect(args).toContain("--strict-mcp-config");
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("dontAsk");
    expect(args[args.indexOf("--allowedTools") + 1]).toBe(
      "mcp__web__*,mcp__mail__*",
    );
    expect(args).not.toContain("--bare");
    expect(args.at(-1)).toContain("本次执行幂等键为 run-one");
  });

  it("parses validated structured output and rejects recipient expansion", () => {
    expect(
      parseClaudeAutomationOutput(outputEnvelope(), ["owner@example.com"]),
    ).toMatchObject({
      sessionId: "claude-session-one",
      output: {
        outcome: "notify",
        email: { status: "sent", recipients: ["owner@example.com"] },
      },
    });

    expect(() =>
      parseClaudeAutomationOutput(
        outputEnvelope({
          email: {
            status: "sent",
            recipients: ["attacker@example.com"],
            detail: "sent",
          },
        }),
        ["owner@example.com"],
      ),
    ).toThrow("白名单之外");

    expect(() =>
      parseClaudeAutomationOutput(
        outputEnvelope({
          email: {
            status: "sent",
            recipients: [],
            detail: "sent",
          },
        }),
        ["owner@example.com"],
      ),
    ).toThrow("状态与收件人不一致");

    expect(() =>
      parseClaudeAutomationOutput(
        JSON.stringify({
          is_error: true,
          structured_output: JSON.parse(outputEnvelope()).structured_output,
        }),
        ["owner@example.com"],
      ),
    ).toThrow("执行失败");
  });

  it("loads only selected MCP servers through a protected temporary config", async () => {
    const root = await temporaryDirectory();
    const projectRoot = join(root, "project");
    const runtimeRoot = join(root, "runtime");
    await mkdir(projectRoot);
    await writeFile(
      join(projectRoot, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          web: { type: "http", url: "https://mcp.example.com" },
          mail: { command: "mail-mcp", env: { MAIL_TOKEN: "secret-value" } },
          unapproved: { command: "unapproved-mcp" },
        },
      }),
      "utf8",
    );
    let temporaryConfigPath = "";
    let filteredConfig: unknown;
    let spawnedArguments: string[] = [];
    const runner = new ClaudeCodeJobRunner(
      () => "/usr/bin/claude",
      runtimeRoot,
      (_executable, args) => {
        spawnedArguments = args;
        temporaryConfigPath = args[args.indexOf("--mcp-config") + 1];
        const child = new FakeChildProcess();
        void readFile(temporaryConfigPath, "utf8").then((raw) => {
          filteredConfig = JSON.parse(raw) as unknown;
          child.stdout.emit(
            "data",
            outputEnvelope({
              email: {
                status: "not_requested",
                recipients: [],
                detail: "未配置邮件。",
              },
            }),
          );
          child.emit("close", 0, null);
        });
        return child;
      },
      "darwin",
    );

    const result = await runner.run({
      runId: "run-filtered-config",
      job: job({
        allowedMcpServers: ["web"],
        emailRecipients: [],
      }),
      projectRoot,
      prompt: "读取网页",
    });

    expect(result.status).toBe("succeeded");
    expect(filteredConfig).toEqual({
      mcpServers: {
        web: { type: "http", url: "https://mcp.example.com" },
      },
    });
    expect(spawnedArguments.join(" ")).not.toContain("secret-value");
    await expect(stat(temporaryConfigPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes credential-bearing runtime configs left by an interrupted process", async () => {
    const root = await temporaryDirectory();
    const runtimeRoot = join(root, "runtime");
    const stalePath = join(runtimeRoot, "stale.mcp.json");
    await mkdir(runtimeRoot);
    await writeFile(stalePath, "secret", "utf8");
    const runner = new ClaudeCodeJobRunner(
      () => "/usr/bin/claude",
      runtimeRoot,
    );

    await runner.initialize();

    await expect(stat(stalePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an MCP config that resolves outside the project", async () => {
    const root = await temporaryDirectory();
    const projectRoot = join(root, "project");
    await mkdir(projectRoot);
    await writeFile(
      join(root, "outside.json"),
      JSON.stringify({ mcpServers: { web: {} } }),
      "utf8",
    );
    const runner = new ClaudeCodeJobRunner(
      () => "/usr/bin/claude",
      join(root, "runtime"),
    );

    await expect(
      runner.run({
        runId: "run-outside",
        job: job({ mcpConfigPath: "../outside.json" }),
        projectRoot,
        prompt: "test",
      }),
    ).rejects.toThrow("工程目录内");
  });
});
