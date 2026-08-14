import { execFile as execFileCallback } from "node:child_process";
import { access, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { extname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export interface ClaudeLaunchSpec {
  executable: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

export interface DetectionOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  runCommand?: (
    command: string,
    args: string[],
  ) => Promise<{ stdout: string; stderr: string }>;
}

export interface ValidationOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

const WINDOWS_CLAUDE_EXTENSIONS = new Set([".exe", ".cmd", ".bat", ".ps1"]);

async function existingFile(candidate: string): Promise<string | null> {
  try {
    const absolute = resolve(candidate);
    const details = await stat(absolute);
    if (!details.isFile()) {
      return null;
    }
    await access(absolute, constants.R_OK);
    return await realpath(absolute);
  } catch {
    return null;
  }
}

function outputLines(output: string): string[] {
  return output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
}

function windowsCandidates(env: NodeJS.ProcessEnv): {
  preferred: string[];
  fallback: string[];
} {
  const preferred: string[] = [];
  const fallback: string[] = [];
  if (env.USERPROFILE) {
    preferred.push(join(env.USERPROFILE, ".local", "bin", "claude.exe"));
    fallback.push(
      join(env.USERPROFILE, "AppData", "Roaming", "npm", "claude.cmd"),
    );
  }
  if (env.APPDATA) {
    fallback.push(join(env.APPDATA, "npm", "claude.cmd"));
  }
  return { preferred, fallback };
}

function unixCandidates(env: NodeJS.ProcessEnv): string[] {
  const candidates: string[] = [];
  if (env.HOME) {
    candidates.push(join(env.HOME, ".local", "bin", "claude"));
  }
  candidates.push("/usr/local/bin/claude", "/opt/homebrew/bin/claude");
  return candidates;
}

function normalizeWindowsPath(candidate: string): string {
  return candidate.replaceAll("/", "\\").toLocaleLowerCase("en-US");
}

function isWithinWindowsDirectory(candidate: string, directory: string): boolean {
  const normalizedCandidate = normalizeWindowsPath(candidate);
  const normalizedDirectory = normalizeWindowsPath(directory).replace(/\\+$/u, "");
  return (
    normalizedCandidate === normalizedDirectory ||
    normalizedCandidate.startsWith(`${normalizedDirectory}\\`)
  );
}

function isWindowsAppsExecutable(
  candidate: string,
  env: NodeJS.ProcessEnv,
): boolean {
  if (
    env.LOCALAPPDATA &&
    isWithinWindowsDirectory(
      candidate,
      join(env.LOCALAPPDATA, "Microsoft", "WindowsApps"),
    )
  ) {
    return true;
  }

  const normalized = normalizeWindowsPath(candidate);
  return (
    normalized.includes("\\microsoft\\windowsapps\\") ||
    normalized.includes("\\program files\\windowsapps\\")
  );
}

function windowsCandidateProblem(
  candidate: string,
  env: NodeJS.ProcessEnv,
): string | null {
  if (isWindowsAppsExecutable(candidate, env)) {
    return (
      "所选文件属于 WindowsApps/Claude Desktop，不是 Claude Code CLI。" +
      "请选择 %USERPROFILE%\\.local\\bin\\claude.exe，或 npm 安装目录中的 claude.cmd。"
    );
  }

  const extension = extname(candidate).toLocaleLowerCase("en-US");
  if (!WINDOWS_CLAUDE_EXTENSIONS.has(extension)) {
    return (
      "所选文件不是 Windows 版 Claude Code 启动文件。" +
      "请选择 claude.exe、claude.cmd、claude.bat 或 claude.ps1。"
    );
  }
  return null;
}

export async function detectClaudeExecutable(
  options: DetectionOptions = {},
): Promise<string | null> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const runCommand = options.runCommand ?? (async (command, args) => execFile(command, args));
  const commandCandidates: string[] = [];

  try {
    if (platform === "win32") {
      const result = await runCommand("where.exe", ["claude"]);
      commandCandidates.push(...outputLines(result.stdout));
    } else {
      const result = await runCommand("which", ["claude"]);
      commandCandidates.push(...outputLines(result.stdout));
    }
  } catch {
    // Fall through to known installation locations.
  }

  const knownCandidates =
    platform === "win32" ? windowsCandidates(env) : null;
  const candidates =
    platform === "win32"
      ? [
          ...(knownCandidates?.preferred ?? []),
          ...commandCandidates,
          ...(knownCandidates?.fallback ?? []),
        ]
      : [...commandCandidates, ...unixCandidates(env)];

  for (const candidate of candidates) {
    if (platform === "win32" && windowsCandidateProblem(candidate, env)) {
      continue;
    }
    const found = await existingFile(candidate);
    if (
      found &&
      (platform !== "win32" || !windowsCandidateProblem(found, env))
    ) {
      return found;
    }
  }
  return null;
}

export async function validateClaudeExecutable(
  executablePath: string,
  options: ValidationOptions = {},
): Promise<string> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  if (platform === "win32") {
    const problem = windowsCandidateProblem(executablePath, env);
    if (problem) {
      throw new Error(problem);
    }
  }

  const found = await existingFile(executablePath);
  if (!found) {
    throw new Error("所选 Claude Code 启动文件不存在或不可读。");
  }
  if (platform === "win32") {
    const problem = windowsCandidateProblem(found, env);
    if (problem) {
      throw new Error(problem);
    }
  }
  return found;
}

export function createClaudeLaunchSpec(
  executablePath: string,
  claudeArgs: string[],
  options: {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
  } = {},
): ClaudeLaunchSpec {
  const platform = options.platform ?? process.platform;
  const env = { ...(options.env ?? process.env) };
  const extension = extname(executablePath).toLocaleLowerCase("en-US");

  if (
    platform === "win32" &&
    (extension === ".cmd" || extension === ".bat" || extension === ".ps1")
  ) {
    env.CLAUDE_WORKSPACE_EXECUTABLE = executablePath;
    env.CLAUDE_WORKSPACE_ARGUMENTS = JSON.stringify(claudeArgs);
    const script = [
      "$claudeArguments = @(ConvertFrom-Json $env:CLAUDE_WORKSPACE_ARGUMENTS)",
      "& $env:CLAUDE_WORKSPACE_EXECUTABLE @claudeArguments",
      "exit $LASTEXITCODE",
    ].join("; ");
    return {
      executable: "powershell.exe",
      args: [
        "-NoLogo",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        script,
      ],
      env,
    };
  }

  return {
    executable: executablePath,
    args: [...claudeArgs],
    env,
  };
}
