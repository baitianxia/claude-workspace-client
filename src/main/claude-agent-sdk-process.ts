import { spawn } from "node:child_process";
import { extname } from "node:path";
import type {
  Options,
  SpawnedProcess,
  SpawnOptions as ClaudeSdkSpawnOptions,
} from "@anthropic-ai/claude-agent-sdk" with {
  "resolution-mode": "import"
};
import { createClaudeLaunchSpec } from "./claude-executable";

const WINDOWS_SCRIPT_EXTENSIONS = new Set([".cmd", ".bat", ".ps1"]);

export function claudeAgentSdkProcessOverride(
  claudeExecutable: string,
  platform: NodeJS.Platform = process.platform,
): Pick<Options, "spawnClaudeCodeProcess"> {
  if (
    platform !== "win32" ||
    !WINDOWS_SCRIPT_EXTENSIONS.has(
      extname(claudeExecutable).toLocaleLowerCase("en-US"),
    )
  ) {
    return {};
  }
  return {
    spawnClaudeCodeProcess: (
      options: ClaudeSdkSpawnOptions,
    ): SpawnedProcess => {
      const launch = createClaudeLaunchSpec(options.command, options.args, {
        platform,
        env: options.env,
      });
      const child = spawn(launch.executable, launch.args, {
        cwd: options.cwd,
        env: launch.env,
        signal: options.signal,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      // The custom SDK process interface does not consume stderr. Drain it so
      // a verbose CLI cannot block after filling the operating-system pipe.
      child.stderr.resume();
      return child as unknown as SpawnedProcess;
    },
  };
}
