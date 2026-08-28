import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionHostStateStore } from "../src/main/session-host/state-store";

describe("SessionHostStateStore", () => {
  it("persists session metadata atomically", async () => {
    const directory = await mkdtemp(join(tmpdir(), "workspace-host-state-"));
    const statePath = join(directory, "state.json");
    try {
      const store = new SessionHostStateStore(statePath);
      await store.persist([
        {
          id: "session-one",
          projectId: "project-one",
          title: "排查登录",
          cwd: "C:\\work\\mall",
          status: "running",
          createdAt: 123,
        },
      ]);

      await expect(store.load()).resolves.toEqual({
        existed: true,
        sessions: [
          {
            id: "session-one",
            projectId: "project-one",
            title: "排查登录",
            cwd: "C:\\work\\mall",
            status: "running",
            createdAt: 123,
          },
        ],
      });
      expect(await readdir(directory)).toEqual(["state.json"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("quarantines invalid state instead of adopting untrusted records", async () => {
    const directory = await mkdtemp(join(tmpdir(), "workspace-host-state-"));
    const statePath = join(directory, "state.json");
    try {
      await writeFile(
        statePath,
        JSON.stringify({ version: 1, sessions: [{ id: 42 }] }),
        "utf8",
      );
      const store = new SessionHostStateStore(statePath);

      await expect(store.load()).resolves.toEqual({
        existed: false,
        sessions: [],
      });
      const files = await readdir(directory);
      expect(files).toHaveLength(1);
      expect(files[0]).toMatch(/^state\.json\.corrupt-\d+\.json$/u);
      await expect(readFile(join(directory, files[0]), "utf8")).resolves.toContain(
        '"id":42',
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
