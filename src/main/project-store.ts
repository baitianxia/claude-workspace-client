import { randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  readFile,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import type { ProjectRecord } from "../shared/contracts";

interface AppSettings {
  claudeExecutable?: string;
}

interface StoreData {
  version: 1;
  projects: ProjectRecord[];
  settings: AppSettings;
}

const EMPTY_STORE: StoreData = {
  version: 1,
  projects: [],
  settings: {},
};

function cloneEmptyStore(): StoreData {
  return {
    version: EMPTY_STORE.version,
    projects: [],
    settings: {},
  };
}

function isProjectRecord(value: unknown): value is ProjectRecord {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<ProjectRecord>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.name === "string" &&
    typeof candidate.rootPath === "string" &&
    typeof candidate.createdAt === "number" &&
    typeof candidate.lastOpenedAt === "number"
  );
}

function parseStore(raw: string): StoreData {
  const parsed = JSON.parse(raw) as Partial<StoreData>;
  if (
    parsed.version !== 1 ||
    !Array.isArray(parsed.projects) ||
    !parsed.projects.every(isProjectRecord) ||
    !parsed.settings ||
    typeof parsed.settings !== "object"
  ) {
    throw new Error("Workspace data has an unsupported format.");
  }

  const claudeExecutable = parsed.settings.claudeExecutable;
  if (claudeExecutable !== undefined && typeof claudeExecutable !== "string") {
    throw new Error("Workspace settings contain an invalid Claude executable path.");
  }

  return {
    version: 1,
    projects: parsed.projects,
    settings: claudeExecutable ? { claudeExecutable } : {},
  };
}

export class ProjectStore {
  private data: StoreData = cloneEmptyStore();
  private initialized = false;

  constructor(
    private readonly storePath: string,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    await mkdir(dirname(this.storePath), { recursive: true });

    try {
      const raw = await readFile(this.storePath, "utf8");
      this.data = parseStore(raw);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        await this.backupCorruptStore().catch(() => undefined);
      }
      this.data = cloneEmptyStore();
    }

    this.initialized = true;
  }

  listProjects(): ProjectRecord[] {
    this.assertInitialized();
    return [...this.data.projects].sort(
      (left, right) => right.lastOpenedAt - left.lastOpenedAt,
    );
  }

  getProject(projectId: string): ProjectRecord | undefined {
    this.assertInitialized();
    return this.data.projects.find((project) => project.id === projectId);
  }

  async addProject(selectedPath: string): Promise<ProjectRecord> {
    this.assertInitialized();
    const canonicalPath = await this.canonicalDirectory(selectedPath);
    const key = this.pathKey(canonicalPath);
    const existing = this.data.projects.find(
      (project) => this.pathKey(project.rootPath) === key,
    );

    if (existing) {
      existing.lastOpenedAt = Date.now();
      await this.persist();
      return { ...existing };
    }

    const now = Date.now();
    const project: ProjectRecord = {
      id: randomUUID(),
      name: basename(canonicalPath) || canonicalPath,
      rootPath: canonicalPath,
      createdAt: now,
      lastOpenedAt: now,
    };
    this.data.projects.push(project);
    await this.persist();
    return { ...project };
  }

  async removeProject(projectId: string): Promise<void> {
    this.assertInitialized();
    const nextProjects = this.data.projects.filter(
      (project) => project.id !== projectId,
    );
    if (nextProjects.length === this.data.projects.length) {
      throw new Error("Project does not exist.");
    }
    this.data.projects = nextProjects;
    await this.persist();
  }

  getClaudeExecutable(): string | undefined {
    this.assertInitialized();
    return this.data.settings.claudeExecutable;
  }

  async setClaudeExecutable(executablePath?: string): Promise<void> {
    this.assertInitialized();
    this.data.settings = executablePath ? { claudeExecutable: executablePath } : {};
    await this.persist();
  }

  private async canonicalDirectory(selectedPath: string): Promise<string> {
    const absolutePath = resolve(selectedPath);
    const details = await stat(absolutePath);
    if (!details.isDirectory()) {
      throw new Error("The selected path is not a directory.");
    }
    return realpath(absolutePath);
  }

  private pathKey(candidatePath: string): string {
    const normalized = resolve(candidatePath);
    return this.platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
  }

  private async persist(): Promise<void> {
    const serialized = `${JSON.stringify(this.data, null, 2)}\n`;
    await writeFile(this.storePath, serialized, "utf8");
  }

  private async backupCorruptStore(): Promise<void> {
    const backupPath = `${this.storePath}.corrupt-${Date.now()}.json`;
    await copyFile(this.storePath, backupPath);
  }

  private assertInitialized(): void {
    if (!this.initialized) {
      throw new Error("Project store has not been initialized.");
    }
  }
}
