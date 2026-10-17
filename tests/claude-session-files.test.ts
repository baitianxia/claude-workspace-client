import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CLAUDE_RESUME_NOT_FOUND_PATTERN,
  claudeProjectsDirectory,
  findClaudeTranscript,
  findClaudeTranscriptSync,
  stripAnsi,
} from "../src/main/claude-session-files";

const SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";
const OTHER_SESSION_ID = "550e8400-e29b-41d4-a716-446655440001";
const temporaryDirectories: string[] = [];

async function configDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "claude-session-files-"));
  temporaryDirectories.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Claude transcript lookup", () => {
  it("uses CLAUDE_CONFIG_DIR when it is configured", () => {
    expect(claudeProjectsDirectory({ CLAUDE_CONFIG_DIR: "/srv/claude" })).toBe(
      join("/srv/claude", "projects"),
    );
  });

  it("finds a non-empty transcript in any project directory", async () => {
    const root = await configDirectory();
    const env = { CLAUDE_CONFIG_DIR: root };
    await mkdir(join(root, "projects", "-work-mall"), { recursive: true });
    await mkdir(join(root, "projects", "-work-other"), { recursive: true });
    await writeFile(
      join(root, "projects", "-work-other", `${SESSION_ID}.jsonl`),
      '{"type":"user"}\n',
    );

    await expect(findClaudeTranscript(SESSION_ID, env)).resolves.toBe("found");
    expect(findClaudeTranscriptSync(SESSION_ID, env)).toBe("found");
    await expect(findClaudeTranscript(OTHER_SESSION_ID, env)).resolves.toBe(
      "missing",
    );
    expect(findClaudeTranscriptSync(OTHER_SESSION_ID, env)).toBe("missing");
  });

  it("treats an empty transcript or a missing projects directory as missing", async () => {
    const root = await configDirectory();
    const env = { CLAUDE_CONFIG_DIR: root };
    await expect(findClaudeTranscript(SESSION_ID, env)).resolves.toBe("missing");
    expect(findClaudeTranscriptSync(SESSION_ID, env)).toBe("missing");

    await mkdir(join(root, "projects", "-work-mall"), { recursive: true });
    await writeFile(join(root, "projects", "-work-mall", `${SESSION_ID}.jsonl`), "");
    await expect(findClaudeTranscript(SESSION_ID, env)).resolves.toBe("missing");
    expect(findClaudeTranscriptSync(SESSION_ID, env)).toBe("missing");
  });

  it("reports unknown for IDs that are not Claude session UUIDs", async () => {
    const root = await configDirectory();
    const env = { CLAUDE_CONFIG_DIR: root };
    await expect(findClaudeTranscript("../escape", env)).resolves.toBe("unknown");
    expect(findClaudeTranscriptSync("claude-session-1", env)).toBe("unknown");
  });

  it("recognises Claude's resume error through terminal escape sequences", () => {
    const output = stripAnsi(
      `\u001b[31mNo conversation found with session ID: ${SESSION_ID}\u001b[0m\r\n`,
    );
    expect(output).toBe(
      `No conversation found with session ID: ${SESSION_ID}\r\n`,
    );
    expect(CLAUDE_RESUME_NOT_FOUND_PATTERN.test(output)).toBe(true);
  });
});
