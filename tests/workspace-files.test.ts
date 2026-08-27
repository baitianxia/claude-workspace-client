import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  createAddedFileDiff,
  parsePorcelainStatus,
  WorkspaceFiles,
} from "../src/main/workspace-files";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "claude-workspace-files-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

async function initializeRepository(root: string): Promise<void> {
  await git(root, "init");
  await git(root, "config", "user.email", "workspace@example.test");
  await git(root, "config", "user.name", "Workspace Test");
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("workspace file status parsing", () => {
  it("parses staged, unstaged, untracked, renamed and conflicted entries", () => {
    const changes = parsePorcelainStatus(
      [
        "M  staged.ts",
        " M working.ts",
        "MM both.ts",
        "?? new file.md",
        "R  new/name.ts",
        "old/name.ts",
        "UU conflict.ts",
        "",
      ].join("\0"),
    );

    expect(changes).toEqual([
      expect.objectContaining({
        path: "staged.ts",
        status: "modified",
        staged: true,
        unstaged: false,
      }),
      expect.objectContaining({
        path: "working.ts",
        status: "modified",
        staged: false,
        unstaged: true,
      }),
      expect.objectContaining({
        path: "both.ts",
        staged: true,
        unstaged: true,
      }),
      expect.objectContaining({
        path: "new file.md",
        status: "untracked",
      }),
      expect.objectContaining({
        path: "new/name.ts",
        previousPath: "old/name.ts",
        status: "renamed",
      }),
      expect.objectContaining({
        path: "conflict.ts",
        status: "conflicted",
      }),
    ]);
  });

  it("creates a unified diff for an untracked text file", () => {
    expect(createAddedFileDiff("docs/new file.md", "first\nsecond")).toContain(
      "@@ -0,0 +1,2 @@\n+first\n+second\n\\ No newline at end of file",
    );
  });
});

describe("WorkspaceFiles", () => {
  it("lists changes and reads latest, tracked diff and untracked diff content", async () => {
    const root = await temporaryDirectory();
    await initializeRepository(root);
    await mkdir(join(root, "src"));
    await writeFile(join(root, "README.md"), "# Before\n", "utf8");
    await writeFile(join(root, "src", "app.ts"), "export const value = 1;\n", "utf8");
    await git(root, "add", ".");
    await git(root, "commit", "-m", "initial");

    await writeFile(
      join(root, "README.md"),
      "# After\n\n```mermaid\ngraph LR\nA --> B\n```\n",
      "utf8",
    );
    await writeFile(join(root, "src", "new.ts"), "export const added = true;\n", "utf8");

    const workspaceFiles = new WorkspaceFiles();
    const snapshot = await workspaceFiles.list(root);

    expect(snapshot).toMatchObject({
      isGitRepository: true,
      truncated: false,
    });
    expect(snapshot.files).toEqual([
      expect.objectContaining({ path: "README.md", status: "modified" }),
      expect.objectContaining({ path: "src/new.ts", status: "untracked" }),
    ]);

    const latest = await workspaceFiles.read(root, "README.md", "latest");
    expect(latest).toMatchObject({ kind: "text", mode: "latest" });
    expect(latest.content).toContain("```mermaid");

    const diff = await workspaceFiles.read(root, "README.md", "diff");
    expect(diff.content).toContain("-# Before");
    expect(diff.content).toContain("+# After");

    const untrackedDiff = await workspaceFiles.read(root, "src/new.ts", "diff");
    expect(untrackedDiff.content).toContain("--- /dev/null");
    expect(untrackedDiff.content).toContain("+export const added = true;");
  });

  it("includes staged content by comparing the working tree with HEAD", async () => {
    const root = await temporaryDirectory();
    await initializeRepository(root);
    await writeFile(join(root, "staged.txt"), "before\n", "utf8");
    await git(root, "add", "staged.txt");
    await git(root, "commit", "-m", "initial");
    await writeFile(join(root, "staged.txt"), "after\n", "utf8");
    await git(root, "add", "staged.txt");

    const workspaceFiles = new WorkspaceFiles();
    const snapshot = await workspaceFiles.list(root);
    expect(snapshot.files[0]).toMatchObject({
      path: "staged.txt",
      staged: true,
      unstaged: false,
    });
    const diff = await workspaceFiles.read(root, "staged.txt", "diff");
    expect(diff.content).toContain("-before");
    expect(diff.content).toContain("+after");
  });

  it("keeps rename metadata and exposes deleted files through the diff", async () => {
    const root = await temporaryDirectory();
    await initializeRepository(root);
    await writeFile(join(root, "old-name.ts"), "export const value = 1;\n", "utf8");
    await writeFile(join(root, "removed.ts"), "export const removed = true;\n", "utf8");
    await git(root, "add", ".");
    await git(root, "commit", "-m", "initial");
    await git(root, "mv", "old-name.ts", "new-name.ts");
    await rm(join(root, "removed.ts"));

    const workspaceFiles = new WorkspaceFiles();
    const snapshot = await workspaceFiles.list(root);
    expect(snapshot.files).toEqual([
      expect.objectContaining({
        path: "new-name.ts",
        previousPath: "old-name.ts",
        status: "renamed",
      }),
      expect.objectContaining({ path: "removed.ts", status: "deleted" }),
    ]);

    const renameDiff = await workspaceFiles.read(root, "new-name.ts", "diff");
    expect(renameDiff.content).toContain("rename from old-name.ts");
    expect(renameDiff.content).toContain("rename to new-name.ts");

    const latestDeleted = await workspaceFiles.read(root, "removed.ts", "latest");
    expect(latestDeleted.kind).toBe("deleted");
    const deletedDiff = await workspaceFiles.read(root, "removed.ts", "diff");
    expect(deletedDiff.content).toContain("-export const removed = true;");
  });

  it("limits a project nested inside a larger repository to its own files", async () => {
    const root = await temporaryDirectory();
    const projectRoot = join(root, "packages", "client");
    await mkdir(projectRoot, { recursive: true });
    await initializeRepository(root);
    await writeFile(join(root, "outside.txt"), "before\n", "utf8");
    await writeFile(join(projectRoot, "inside.txt"), "before\n", "utf8");
    await git(root, "add", ".");
    await git(root, "commit", "-m", "initial");
    await writeFile(join(root, "outside.txt"), "after\n", "utf8");
    await writeFile(join(projectRoot, "inside.txt"), "after\n", "utf8");

    const workspaceFiles = new WorkspaceFiles();
    const snapshot = await workspaceFiles.list(projectRoot);
    expect(snapshot.files.map((file) => file.path)).toEqual(["inside.txt"]);

    const diff = await workspaceFiles.read(projectRoot, "inside.txt", "diff");
    expect(diff.content).toContain("a/inside.txt");
    expect(diff.content).not.toContain("outside.txt");
  });

  it("returns a non-repository state and rejects paths outside the project", async () => {
    const plainDirectory = await temporaryDirectory();
    const workspaceFiles = new WorkspaceFiles();
    await expect(workspaceFiles.list(plainDirectory)).resolves.toEqual({
      isGitRepository: false,
      files: [],
      truncated: false,
    });

    const repository = await temporaryDirectory();
    await initializeRepository(repository);
    await writeFile(join(repository, "inside.txt"), "inside\n", "utf8");
    await expect(
      workspaceFiles.read(repository, "../outside.txt", "latest"),
    ).rejects.toThrow("超出当前工程范围");
  });

  it("does not decode binary files as text", async () => {
    const root = await temporaryDirectory();
    await initializeRepository(root);
    await writeFile(join(root, "asset.bin"), Buffer.from([0, 1, 2, 3, 4]));

    const workspaceFiles = new WorkspaceFiles();
    const content = await workspaceFiles.read(root, "asset.bin", "latest");
    expect(content).toMatchObject({
      path: "asset.bin",
      kind: "binary",
      size: 5,
    });
  });

  it.skipIf(process.platform === "win32")(
    "rejects a changed symbolic link that points outside the selected project",
    async () => {
      const root = await temporaryDirectory();
      const projectRoot = join(root, "project");
      await mkdir(projectRoot);
      await initializeRepository(root);
      await writeFile(join(root, "outside.txt"), "secret outside content\n", "utf8");
      await symlink("../outside.txt", join(projectRoot, "outside-link.txt"));

      const workspaceFiles = new WorkspaceFiles();
      await expect(
        workspaceFiles.read(projectRoot, "outside-link.txt", "latest"),
      ).rejects.toThrow("符号链接目标超出当前工程范围");
    },
  );
});
