import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getWorkspacePaths,
  migrateLegacyWorkspaceData,
} from "../src/main/workspace-paths";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("workspace paths", () => {
  it("keeps Windows runtime and user data under the product-owned profile directory", () => {
    const paths = getWorkspacePaths(
      "win32",
      "C:\\Users\\Ada Lovelace",
      "C:\\Users\\Ada Lovelace\\AppData\\Roaming\\Claude Workspace",
    );

    expect(paths.workspaceRoot).toBe("C:\\Users\\Ada Lovelace\\claude-workspace");
    expect(paths.settingsPath).toBe(
      "C:\\Users\\Ada Lovelace\\claude-workspace\\config\\settings.json",
    );
    expect(paths.assistantStorePath).toBe(
      "C:\\Users\\Ada Lovelace\\claude-workspace\\data\\assistant.json",
    );
    expect(paths.logsDir).toBe("C:\\Users\\Ada Lovelace\\claude-workspace\\logs");
  });

  it("retains the existing Electron layout outside Windows", () => {
    const paths = getWorkspacePaths(
      "darwin",
      "/Users/ada",
      "/Users/ada/Library/Application Support/Claude Workspace",
    );

    expect(paths.workspaceRoot).toBe(
      "/Users/ada/Library/Application Support/Claude Workspace",
    );
    expect(paths.settingsPath).toBe(`${paths.workspaceRoot}/workspace.json`);
    expect(paths.assistantStorePath).toBe(`${paths.workspaceRoot}/assistant.json`);
  });

  it("copies legacy Windows files without deleting the source", async () => {
    const home = await mkdtemp(join(tmpdir(), "claude-workspace-home-"));
    const legacy = await mkdtemp(join(tmpdir(), "claude-workspace-legacy-"));
    temporaryDirectories.push(home, legacy);
    await writeFile(join(legacy, "workspace.json"), '{"version":4}', "utf8");
    await writeFile(join(legacy, "assistant.json"), '{"profiles":[]}', "utf8");

    // Use native temporary paths for the filesystem exercise while forcing
    // the migration code's Windows branch. The Windows path-shape assertions
    // are covered by the first test above.
    const paths = getWorkspacePaths("darwin", home, home);
    const migrated = await migrateLegacyWorkspaceData(paths, legacy, "win32");

    expect(migrated).toBe(2);
    await expect(readFile(paths.settingsPath, "utf8")).resolves.toBe('{"version":4}');
    await expect(readFile(paths.assistantStorePath, "utf8")).resolves.toBe(
      '{"profiles":[]}',
    );
    await expect(readFile(join(legacy, "workspace.json"), "utf8")).resolves.toBe(
      '{"version":4}',
    );
  });
});
