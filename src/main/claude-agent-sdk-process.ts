import { spawn, type ChildProcess } from "node:child_process";
import { extname } from "node:path";
import type {
  Options,
  SpawnedProcess,
  SpawnOptions as ClaudeSdkSpawnOptions,
} from "@anthropic-ai/claude-agent-sdk" with {
  "resolution-mode": "import"
};
import { createClaudeLaunchSpec } from "./claude-executable";
import { terminateProcessTree } from "./process-tree";

const WINDOWS_SCRIPT_EXTENSIONS = new Set([".cmd", ".bat", ".ps1"]);

/** Child processes created through the Agent SDK while this app is running. */
const trackedClaudeProcesses = new Set<ChildProcess>();

function trackClaudeProcess(
  child: ChildProcess,
  platform: NodeJS.Platform,
): void {
  trackedClaudeProcesses.add(child);
  const untrack = () => trackedClaudeProcesses.delete(child);
  child.once("exit", untrack);
  child.once("error", untrack);

  // The SDK's normal kill operation only knows about this immediate child.
  // On Windows it can be a wrapper whose Claude descendant survives. Keep the
  // SDK contract intact, but terminate the whole tree whenever it asks us to
  // kill the child.
  const originalKill = child.kill.bind(child);
  child.kill = ((signal?: NodeJS.Signals | number) => {
    if (platform === "win32" && child.pid) {
      void terminateProcessTree(child.pid, { platform });
    }
    return originalKill(signal);
  }) as typeof child.kill;
}

/**
 * Force all Agent SDK children to stop during application shutdown. This is a
 * final safety net for a query whose async iterator never observes EOF.
 */
export async function terminateTrackedClaudeProcesses(
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  const children = [...trackedClaudeProcesses];
  await Promise.allSettled(
    children.map(async (child) => {
      const pid = child.pid;
      if (platform === "win32" && pid) {
        await terminateProcessTree(pid, { platform });
      }
      if (!child.killed) {
        try {
          child.kill(platform === "win32" ? "SIGKILL" : "SIGTERM");
        } catch {
          // The child may have exited between the PID check and kill().
        }
      }
    }),
  );
}

export function claudeAgentSdkProcessOverride(
  claudeExecutable: string,
  platform: NodeJS.Platform = process.platform,
): Pick<Options, "spawnClaudeCodeProcess"> {
  // A custom process is needed for every Windows executable, not just script
  // wrappers. It lets shutdown retain the PID and terminate descendants of a
  // native claude.exe as well as descendants of PowerShell/npm wrappers.
  if (platform !== "win32") {
    return {};
  }
  return {
    spawnClaudeCodeProcess: (
      options: ClaudeSdkSpawnOptions,
    ): SpawnedProcess => {
      const isScript = WINDOWS_SCRIPT_EXTENSIONS.has(
        extname(claudeExecutable).toLocaleLowerCase("en-US"),
      );
      const launch = isScript
        ? createClaudeLaunchSpec(options.command, options.args, {
            platform,
            env: options.env,
          })
        : {
            executable: options.command,
            args: [...options.args],
            env: options.env,
          };
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
      trackClaudeProcess(child, platform);
      return child as unknown as SpawnedProcess;
    },
  };
}
