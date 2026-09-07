import { execFile } from "node:child_process";

/**
 * A small abstraction around the Windows process-tree terminator.  `node-pty`
 * and the Agent SDK both expose the PID of their immediate child, but that
 * child may be a PowerShell/npm wrapper which has already spawned Claude Code.
 * Killing only the wrapper leaves the real CLI running in the background.
 */
export type ProcessTreeCommand = (args: string[]) => Promise<void>;

export interface ProcessTreeTerminationOptions {
  platform?: NodeJS.Platform;
  runTaskkill?: ProcessTreeCommand;
}
function defaultTaskkill(args: string[]): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    execFile(
      "taskkill.exe",
      args,
      {
        windowsHide: true,
        timeout: 5_000,
      },
      (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      },
    );
  });
}

/**
 * Terminate one Claude process and all of its descendants on Windows.
 *
 * The operation is deliberately best effort: a process can disappear between
 * reading its PID and invoking taskkill, and that is already the desired end
 * state. Callers still perform their normal handle-level kill as a fallback.
 */
export async function terminateProcessTree(
  pid: number,
  options: ProcessTreeTerminationOptions = {},
): Promise<void> {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32" || !Number.isInteger(pid) || pid <= 0) {
    return;
  }
  try {
    await (options.runTaskkill ?? defaultTaskkill)([
      "/PID",
      String(pid),
      "/T",
      "/F",
    ]);
  } catch {
    // The process may have exited already, or taskkill may have raced with a
    // wrapper shutting itself down. Either way, shutdown should continue.
  }
}
