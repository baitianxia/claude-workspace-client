import { copyFile, cp, mkdir, stat } from "node:fs/promises";
import { dirname, join, resolve, win32 } from "node:path";

/** Locations owned by the Claude 工作台 installation and its user data. */
export interface WorkspacePaths {
  workspaceRoot: string;
  configDir: string;
  settingsPath: string;
  dataDir: string;
  assistantStorePath: string;
  automationStorePath: string;
  assistantTaskStorePath: string;
  temporaryWorkspacePath: string;
  logsDir: string;
  versionsDir: string;
  activeDir: string;
  rollbackDir: string;
  lockPath: string;
  activeStatePath: string;
}

export type WorkspaceLocation = "root" | "config" | "data" | "logs";

/**
 * Resolve persistent locations without making renderer code depend on
 * Electron's platform-specific userData directory.
 *
 * Windows releases use a product-owned directory under the user's profile.
 * Other platforms retain the existing Electron layout for compatibility.
 */
export function getWorkspacePaths(
  platform: NodeJS.Platform,
  homeDir: string,
  electronUserDataDir: string,
  workspaceRootOverride?: string,
): WorkspacePaths {
  const isWindows = platform === "win32";
  const joinPath = isWindows ? win32.join : join;
  const resolvePath = isWindows ? win32.resolve : resolve;
  const workspaceRoot = resolvePath(
    workspaceRootOverride ??
      (isWindows ? joinPath(homeDir, "claude-workspace") : electronUserDataDir),
  );
  const configDir = isWindows ? joinPath(workspaceRoot, "config") : workspaceRoot;
  const dataDir = isWindows ? joinPath(workspaceRoot, "data") : workspaceRoot;

  return {
    workspaceRoot,
    configDir,
    settingsPath: isWindows
      ? joinPath(configDir, "settings.json")
      : joinPath(workspaceRoot, "workspace.json"),
    dataDir,
    assistantStorePath: joinPath(dataDir, "assistant.json"),
    automationStorePath: joinPath(dataDir, "automation.json"),
    assistantTaskStorePath: joinPath(dataDir, "assistant-tasks.json"),
    temporaryWorkspacePath: joinPath(dataDir, "temporary-workspaces"),
    logsDir: joinPath(workspaceRoot, "logs"),
    versionsDir: joinPath(workspaceRoot, "versions"),
    activeDir: joinPath(workspaceRoot, "active"),
    rollbackDir: joinPath(workspaceRoot, "rollback"),
    lockPath: joinPath(workspaceRoot, "install.lock"),
    activeStatePath: joinPath(workspaceRoot, "active.json"),
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

/**
 * Copy legacy Windows data into the product-owned directory once.
 *
 * The source is deliberately retained so a failed upgrade remains reversible.
 * Existing destination files always win, which makes the operation safe to
 * retry after an interrupted first launch.
 */
export async function migrateLegacyWorkspaceData(
  paths: WorkspacePaths,
  legacyUserDataDir: string,
  platform: NodeJS.Platform,
): Promise<number> {
  if (platform !== "win32") {
    return 0;
  }

  const fileMappings = [
    [join(legacyUserDataDir, "workspace.json"), paths.settingsPath],
    [join(legacyUserDataDir, "assistant.json"), paths.assistantStorePath],
    [join(legacyUserDataDir, "automation.json"), paths.automationStorePath],
    [join(legacyUserDataDir, "assistant-tasks.json"), paths.assistantTaskStorePath],
  ] as const;
  const directoryMappings = [
    [
      join(legacyUserDataDir, "temporary-workspaces"),
      paths.temporaryWorkspacePath,
    ],
  ] as const;

  let migrated = 0;
  for (const [source, destination] of fileMappings) {
    if (resolve(source) === resolve(destination)) {
      continue;
    }
    if (!(await pathExists(source)) || (await pathExists(destination))) {
      continue;
    }
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination);
    migrated += 1;
  }

  for (const [source, destination] of directoryMappings) {
    if (resolve(source) === resolve(destination)) {
      continue;
    }
    if (!(await pathExists(source)) || (await pathExists(destination))) {
      continue;
    }
    await mkdir(dirname(destination), { recursive: true });
    await cp(source, destination, { recursive: true, force: false });
    migrated += 1;
  }

  return migrated;
}
