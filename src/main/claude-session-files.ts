import { readdirSync, statSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Whether Claude Code still has a transcript for a session ID.
 *
 * - "found": a non-empty `<id>.jsonl` exists in some project directory.
 * - "missing": the projects directory was readable and no transcript exists.
 *   Claude Code removes transcripts after `cleanupPeriodDays` (30 days by
 *   default) and does not write one for a session that never received a
 *   message, so `--resume <id>` would fail with "No conversation found".
 * - "unknown": the lookup could not be completed (unusual ID shape or an I/O
 *   error). Callers keep their previous behaviour and try to resume.
 */
export type ClaudeTranscriptLookup = "found" | "missing" | "unknown";

const SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** Matches the CLI message printed when `--resume <id>` finds nothing. */
export const CLAUDE_RESUME_NOT_FOUND_PATTERN =
  /No conversation found with session ID/iu;

export function claudeProjectsDirectory(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configured = env.CLAUDE_CONFIG_DIR?.trim();
  return join(configured || join(homedir(), ".claude"), "projects");
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;
}

/**
 * `claude --resume <id>` searches the current project first and then every
 * other project on the machine, so look in every project directory as well.
 */
export async function findClaudeTranscript(
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ClaudeTranscriptLookup> {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    return "unknown";
  }
  const projectsDirectory = claudeProjectsDirectory(env);
  let entries: string[];
  try {
    entries = await readdir(projectsDirectory);
  } catch (error) {
    return errorCode(error) === "ENOENT" ? "missing" : "unknown";
  }
  let uncertain = false;
  for (const entry of entries) {
    try {
      const details = await stat(
        join(projectsDirectory, entry, `${sessionId}.jsonl`),
      );
      if (details.isFile() && details.size > 0) {
        return "found";
      }
    } catch (error) {
      const code = errorCode(error);
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        uncertain = true;
      }
    }
  }
  return uncertain ? "unknown" : "missing";
}

/** Synchronous variant for the user-initiated, synchronous restart path. */
export function findClaudeTranscriptSync(
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): ClaudeTranscriptLookup {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    return "unknown";
  }
  const projectsDirectory = claudeProjectsDirectory(env);
  let entries: string[];
  try {
    entries = readdirSync(projectsDirectory);
  } catch (error) {
    return errorCode(error) === "ENOENT" ? "missing" : "unknown";
  }
  let uncertain = false;
  for (const entry of entries) {
    try {
      const details = statSync(
        join(projectsDirectory, entry, `${sessionId}.jsonl`),
      );
      if (details.isFile() && details.size > 0) {
        return "found";
      }
    } catch (error) {
      const code = errorCode(error);
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        uncertain = true;
      }
    }
  }
  return uncertain ? "unknown" : "missing";
}

const ANSI_ESCAPE_PATTERN =
  // CSI sequences, OSC sequences (BEL or ST terminated) and single-character
  // escapes. Only used to make plain-text matching on PTY output reliable.
  /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/gu;

export function stripAnsi(value: string): string {
  return value.replace(ANSI_ESCAPE_PATTERN, "");
}
