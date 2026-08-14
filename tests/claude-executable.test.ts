import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createClaudeLaunchSpec,
  detectClaudeExecutable,
  validateClaudeExecutable,
} from "../src/main/claude-executable";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("Claude executable integration", () => {
  it("uses the executable reported by where.exe on Windows", async () => {
    const root = await mkdtemp(join(tmpdir(), "claude-executable-"));
    temporaryDirectories.push(root);
    const executable = join(root, "claude.exe");
    await writeFile(executable, "", "utf8");

    const detected = await detectClaudeExecutable({
      platform: "win32",
      env: {},
      runCommand: async (command, args) => {
        expect(command).toBe("where.exe");
        expect(args).toEqual(["claude"]);
        return { stdout: `${executable}\r\n`, stderr: "" };
      },
    });

    expect(detected).toBe(await realpath(executable));
  });

  it("falls back to the npm Claude wrapper location on Windows", async () => {
    const root = await mkdtemp(join(tmpdir(), "claude-executable-"));
    temporaryDirectories.push(root);
    const npmDirectory = join(root, "npm");
    await mkdir(npmDirectory);
    const wrapper = join(npmDirectory, "claude.cmd");
    await writeFile(wrapper, "@echo off", "utf8");

    const detected = await detectClaudeExecutable({
      platform: "win32",
      env: { APPDATA: root },
      runCommand: async () => {
        throw new Error("not found");
      },
    });

    expect(detected).toBe(await realpath(wrapper));
  });

  it("prefers the native Claude Code CLI over the Claude Desktop alias", async () => {
    const root = await mkdtemp(join(tmpdir(), "claude-executable-"));
    temporaryDirectories.push(root);
    const nativeDirectory = join(root, ".local", "bin");
    const windowsAppsDirectory = join(
      root,
      "AppData",
      "Local",
      "Microsoft",
      "WindowsApps",
    );
    await mkdir(nativeDirectory, { recursive: true });
    await mkdir(windowsAppsDirectory, { recursive: true });
    const nativeCli = join(nativeDirectory, "claude.exe");
    const desktopAlias = join(windowsAppsDirectory, "Claude.exe");
    await writeFile(nativeCli, "", "utf8");
    await writeFile(desktopAlias, "", "utf8");

    const detected = await detectClaudeExecutable({
      platform: "win32",
      env: {
        USERPROFILE: root,
        LOCALAPPDATA: join(root, "AppData", "Local"),
      },
      runCommand: async () => ({ stdout: `${desktopAlias}\r\n`, stderr: "" }),
    });

    expect(detected).toBe(await realpath(nativeCli));
  });

  it("ignores a WindowsApps alias and uses the npm wrapper", async () => {
    const root = await mkdtemp(join(tmpdir(), "claude-executable-"));
    temporaryDirectories.push(root);
    const localAppData = join(root, "Local");
    const appData = join(root, "Roaming");
    const windowsAppsDirectory = join(
      localAppData,
      "Microsoft",
      "WindowsApps",
    );
    const npmDirectory = join(appData, "npm");
    await mkdir(windowsAppsDirectory, { recursive: true });
    await mkdir(npmDirectory, { recursive: true });
    const desktopAlias = join(windowsAppsDirectory, "Claude.exe");
    const wrapper = join(npmDirectory, "claude.cmd");
    await writeFile(desktopAlias, "", "utf8");
    await writeFile(wrapper, "@echo off", "utf8");

    const detected = await detectClaudeExecutable({
      platform: "win32",
      env: { LOCALAPPDATA: localAppData, APPDATA: appData },
      runCommand: async () => ({ stdout: `${desktopAlias}\r\n`, stderr: "" }),
    });

    expect(detected).toBe(await realpath(wrapper));
  });

  it("rejects a manually selected Claude Desktop WindowsApps alias", async () => {
    const root = await mkdtemp(join(tmpdir(), "claude-executable-"));
    temporaryDirectories.push(root);
    const localAppData = join(root, "Local");
    const windowsAppsDirectory = join(
      localAppData,
      "Microsoft",
      "WindowsApps",
    );
    await mkdir(windowsAppsDirectory, { recursive: true });
    const desktopAlias = join(windowsAppsDirectory, "Claude.exe");
    await writeFile(desktopAlias, "", "utf8");

    await expect(
      validateClaudeExecutable(desktopAlias, {
        platform: "win32",
        env: { LOCALAPPDATA: localAppData },
      }),
    ).rejects.toThrow(/WindowsApps\/Claude Desktop/u);
  });

  it("launches native executables directly", () => {
    const launch = createClaudeLaunchSpec("C:\\Tools\\claude.exe", ["--version"], {
      platform: "win32",
      env: { PATH: "C:\\Windows" },
    });

    expect(launch.executable).toBe("C:\\Tools\\claude.exe");
    expect(launch.args).toEqual(["--version"]);
  });

  it("launches cmd wrappers through PowerShell without interpolating paths", () => {
    const wrapper = "C:\\Users\\Dev User\\AppData\\Roaming\\npm\\claude.cmd";
    const launch = createClaudeLaunchSpec(wrapper, ["--worktree", "task-one"], {
      platform: "win32",
      env: {},
    });

    expect(launch.executable).toBe("powershell.exe");
    expect(launch.env.CLAUDE_WORKSPACE_EXECUTABLE).toBe(wrapper);
    expect(launch.env.CLAUDE_WORKSPACE_ARGUMENTS).toBe(
      JSON.stringify(["--worktree", "task-one"]),
    );
    expect(launch.args.join(" ")).not.toContain(wrapper);
  });
});
