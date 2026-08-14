import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectStore } from "../src/main/project-store";
import type { SessionRecord } from "../src/shared/contracts";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "claude-workspace-store-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("ProjectStore", () => {
  it("persists a selected project using its canonical directory", async () => {
    const root = await temporaryDirectory();
    const projectPath = join(root, "sample-project");
    const storePath = join(root, "data", "workspace.json");
    await mkdir(projectPath);

    const store = new ProjectStore(storePath);
    await store.initialize();
    const project = await store.addProject(projectPath);

    expect(project.name).toBe("sample-project");
    expect(project.rootPath).toBe(await realpath(projectPath));
    expect(store.listProjects()).toHaveLength(1);

    const reloaded = new ProjectStore(storePath);
    await reloaded.initialize();
    expect(reloaded.listProjects()).toEqual([project]);
  });

  it("deduplicates a folder and keeps the same project identity", async () => {
    const root = await temporaryDirectory();
    const projectPath = join(root, "sample-project");
    await mkdir(projectPath);
    const store = new ProjectStore(join(root, "workspace.json"));
    await store.initialize();

    const first = await store.addProject(projectPath);
    const second = await store.addProject(join(projectPath, "."));

    expect(second.id).toBe(first.id);
    expect(store.listProjects()).toHaveLength(1);
  });

  it("does not delete project files when removing a project record", async () => {
    const root = await temporaryDirectory();
    const projectPath = join(root, "sample-project");
    const markerPath = join(projectPath, "keep.txt");
    await mkdir(projectPath);
    await writeFile(markerPath, "keep", "utf8");
    const store = new ProjectStore(join(root, "workspace.json"));
    await store.initialize();
    const project = await store.addProject(projectPath);

    await store.removeProject(project.id);

    expect(store.listProjects()).toHaveLength(0);
    expect(await readFile(markerPath, "utf8")).toBe("keep");
  });

  it("backs up malformed workspace data before starting with an empty store", async () => {
    const root = await temporaryDirectory();
    const storePath = join(root, "workspace.json");
    await writeFile(storePath, "not-json", "utf8");
    const store = new ProjectStore(storePath);

    await store.initialize();

    expect(store.listProjects()).toEqual([]);
    const entries = await import("node:fs/promises").then(({ readdir }) => readdir(root));
    expect(entries.some((entry) => entry.startsWith("workspace.json.corrupt-"))).toBe(
      true,
    );
  });

  it("updates project aliases and keeps pinned projects first", async () => {
    const root = await temporaryDirectory();
    const firstPath = join(root, "first-project");
    const secondPath = join(root, "second-project");
    await mkdir(firstPath);
    await mkdir(secondPath);
    const storePath = join(root, "workspace.json");
    const store = new ProjectStore(storePath);
    await store.initialize();
    const first = await store.addProject(firstPath);
    const second = await store.addProject(secondPath);

    const updated = await store.updateProject({
      projectId: first.id,
      alias: "商城服务",
      pinned: true,
    });

    expect(updated).toMatchObject({ alias: "商城服务", pinned: true });
    expect(store.listProjects().map((project) => project.id)).toEqual([
      first.id,
      second.id,
    ]);

    const reloaded = new ProjectStore(storePath);
    await reloaded.initialize();
    expect(reloaded.getProject(first.id)).toMatchObject({
      alias: "商城服务",
      pinned: true,
    });
  });

  it("persists session labels and removes them with their project", async () => {
    const root = await temporaryDirectory();
    const projectPath = join(root, "sample-project");
    await mkdir(projectPath);
    const storePath = join(root, "workspace.json");
    const store = new ProjectStore(storePath);
    await store.initialize();
    const project = await store.addProject(projectPath);
    const session: SessionRecord = {
      id: "session-one",
      projectId: project.id,
      title: "修复登录问题",
      cwd: project.rootPath,
      status: "running",
      createdAt: 123,
    };

    await store.replaceSessions([session]);
    const reloaded = new ProjectStore(storePath);
    await reloaded.initialize();
    expect(reloaded.listSessions()).toEqual([session]);

    await reloaded.removeProject(project.id);
    expect(reloaded.listSessions()).toEqual([]);
  });

  it("migrates version 1 workspace data without losing projects", async () => {
    const root = await temporaryDirectory();
    const storePath = join(root, "workspace.json");
    await writeFile(
      storePath,
      JSON.stringify({
        version: 1,
        projects: [
          {
            id: "legacy-project",
            name: "legacy",
            rootPath: "C:\\work\\legacy",
            createdAt: 1,
            lastOpenedAt: 2,
          },
        ],
        settings: {},
      }),
      "utf8",
    );
    const store = new ProjectStore(storePath, "win32");

    await store.initialize();

    expect(store.listProjects()).toEqual([
      expect.objectContaining({
        id: "legacy-project",
        name: "legacy",
        pinned: false,
      }),
    ]);
    expect(store.listSessions()).toEqual([]);
  });
});
