import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TemporaryWorkspace } from "../src/main/temporary-workspace";

const roots: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("TemporaryWorkspace", () => {
  it("creates an isolated directory and removes it on request", async () => {
    const root = await mkdtemp(join(tmpdir(), "claude-workspace-temporary-"));
    roots.push(root);
    const workspace = new TemporaryWorkspace(join(root, "sessions"));
    const directory = await workspace.createDirectory();
    const marker = join(directory, "draft.txt");
    await writeFile(marker, "temporary", "utf8");

    await workspace.removeDirectory(directory);

    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes only orphaned session directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "claude-workspace-temporary-"));
    roots.push(root);
    const managedRoot = join(root, "sessions");
    const workspace = new TemporaryWorkspace(managedRoot);
    const kept = await workspace.createDirectory();
    const orphan = await workspace.createDirectory();
    const unrelated = join(managedRoot, "keep-me");
    await mkdir(unrelated, { recursive: true });

    await expect(workspace.removeOrphans([kept])).resolves.toBe(1);

    await expect(access(kept)).resolves.toBeUndefined();
    await expect(access(unrelated)).resolves.toBeUndefined();
    await expect(access(orphan)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("ignores a missing managed root when cleaning orphans", async () => {
    const root = await mkdtemp(join(tmpdir(), "claude-workspace-temporary-"));
    roots.push(root);
    const workspace = new TemporaryWorkspace(join(root, "never-created"));

    await expect(workspace.removeOrphans([])).resolves.toBe(0);
  });

  it("refuses to remove a directory outside its managed root", async () => {
    const root = await mkdtemp(join(tmpdir(), "claude-workspace-temporary-"));
    roots.push(root);
    const workspace = new TemporaryWorkspace(join(root, "sessions"));

    await expect(workspace.removeDirectory(root)).rejects.toThrow(
      "unmanaged temporary workspace",
    );
  });

  it("refuses to remove unrelated directories inside its managed root", async () => {
    const root = await mkdtemp(join(tmpdir(), "claude-workspace-temporary-"));
    roots.push(root);
    const managedRoot = join(root, "sessions");
    const unrelatedDirectory = join(managedRoot, "keep-me");
    await mkdir(unrelatedDirectory, { recursive: true });
    const workspace = new TemporaryWorkspace(managedRoot);

    await expect(workspace.removeDirectory(unrelatedDirectory)).rejects.toThrow(
      "unmanaged temporary workspace",
    );
  });
});
