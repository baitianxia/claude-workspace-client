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

    await expect(workspace.removeOrphans([kept], process.platform, 0)).resolves.toBe(1);

    await expect(access(kept)).resolves.toBeUndefined();
    await expect(access(unrelated)).resolves.toBeUndefined();
    await expect(access(orphan)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("skips directories created moments ago", async () => {
    const root = await mkdtemp(join(tmpdir(), "claude-workspace-temporary-"));
    roots.push(root);
    const workspace = new TemporaryWorkspace(join(root, "sessions"));
    const fresh = await workspace.createDirectory();

    await expect(workspace.removeOrphans([])).resolves.toBe(0);
    await expect(access(fresh)).resolves.toBeUndefined();

    // The same directory is an orphan once it is old enough.
    await expect(
      workspace.removeOrphans([], process.platform, 60_000, () => Date.now() + 120_000),
    ).resolves.toBe(1);
    await expect(access(fresh)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("re-reads references before each removal", async () => {
    const root = await mkdtemp(join(tmpdir(), "claude-workspace-temporary-"));
    roots.push(root);
    const workspace = new TemporaryWorkspace(join(root, "sessions"));
    const first = await workspace.createDirectory();
    const second = await workspace.createDirectory();
    const references: string[] = [];
    let calls = 0;

    const removed = await workspace.removeOrphans(
      () => {
        calls += 1;
        // A session for the second directory is registered after the
        // cleanup started.
        if (calls === 2) {
          references.push(first, second);
        }
        return [...references];
      },
      process.platform,
      0,
    );

    expect(removed).toBe(1);
    expect(calls).toBe(2);
    const remaining = await Promise.all(
      [first, second].map((path) => access(path).then(() => true, () => false)),
    );
    expect(remaining.filter(Boolean)).toHaveLength(1);
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
