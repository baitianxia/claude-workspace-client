import { randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import type {
  ProjectRecord,
  SessionRecord,
  SessionStatus,
  UpdateProjectRequest,
} from "../shared/contracts";

interface AppSettings {
  claudeExecutable?: string;
}

interface StoreData {
  version: 2;
  projects: ProjectRecord[];
  sessions: SessionRecord[];
  settings: AppSettings;
}

const EMPTY_STORE: StoreData = {
  version: 2,
  projects: [],
  sessions: [],
  settings: {},
};

const SESSION_STATUSES = new Set<SessionStatus>([
  "starting",
  "running",
  "exited",
  "failed",
  "interrupted",
]);

function cloneEmptyStore(): StoreData {
  return {
    version: EMPTY_STORE.version,
    projects: [],
    sessions: [],
    settings: {},
  };
}

function normalizeProjectRecord(value: unknown): ProjectRecord | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Partial<ProjectRecord>;
  if (
    typeof candidate.id !== "string" ||
    typeof candidate.name !== "string" ||
    typeof candidate.rootPath !== "string" ||
    typeof candidate.createdAt !== "number" ||
    typeof candidate.lastOpenedAt !== "number" ||
    (candidate.alias !== undefined && typeof candidate.alias !== "string") ||
    (candidate.pinned !== undefined && typeof candidate.pinned !== "boolean")
  ) {
    return null;
  }

  const alias = candidate.alias?.trim();
  return {
    id: candidate.id,
    name: candidate.name,
    ...(alias ? { alias } : {}),
    pinned: candidate.pinned ?? false,
    rootPath: candidate.rootPath,
    createdAt: candidate.createdAt,
    lastOpenedAt: candidate.lastOpenedAt,
  };
}

function normalizeSessionRecord(value: unknown): SessionRecord | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Partial<SessionRecord>;
  if (
    typeof candidate.id !== "string" ||
    typeof candidate.projectId !== "string" ||
    typeof candidate.title !== "string" ||
    typeof candidate.cwd !== "string" ||
    typeof candidate.status !== "string" ||
    !SESSION_STATUSES.has(candidate.status as SessionStatus) ||
    typeof candidate.createdAt !== "number" ||
    (candidate.exitCode !== undefined && typeof candidate.exitCode !== "number") ||
    (candidate.error !== undefined && typeof candidate.error !== "string")
  ) {
    return null;
  }

  return {
    id: candidate.id,
    projectId: candidate.projectId,
    title: candidate.title,
    cwd: candidate.cwd,
    status: candidate.status as SessionStatus,
    createdAt: candidate.createdAt,
    ...(candidate.exitCode === undefined ? {} : { exitCode: candidate.exitCode }),
    ...(candidate.error === undefined ? {} : { error: candidate.error }),
  };
}

function parseStore(raw: string): StoreData {
  const parsed = JSON.parse(raw) as {
    version?: unknown;
    projects?: unknown;
    sessions?: unknown;
    settings?: unknown;
  };
  if (
    (parsed.version !== 1 && parsed.version !== 2) ||
    !Array.isArray(parsed.projects) ||
    !parsed.settings ||
    typeof parsed.settings !== "object"
  ) {
    throw new Error("Workspace data has an unsupported format.");
  }

  const projects = parsed.projects.map(normalizeProjectRecord);
  if (projects.some((project) => project === null)) {
    throw new Error("Workspace data contains an invalid project.");
  }

  const settings = parsed.settings as AppSettings;
  if (
    settings.claudeExecutable !== undefined &&
    typeof settings.claudeExecutable !== "string"
  ) {
    throw new Error("Workspace settings contain an invalid Claude executable path.");
  }

  const rawSessions = parsed.version === 2 ? parsed.sessions : [];
  if (!Array.isArray(rawSessions)) {
    throw new Error("Workspace data contains an invalid session list.");
  }
  const sessions = rawSessions.map(normalizeSessionRecord);
  if (sessions.some((session) => session === null)) {
    throw new Error("Workspace data contains an invalid session.");
  }

  const normalizedProjects = projects as ProjectRecord[];
  const projectIds = new Set(normalizedProjects.map((project) => project.id));
  return {
    version: 2,
    projects: normalizedProjects,
    sessions: (sessions as SessionRecord[]).filter((session) =>
      projectIds.has(session.projectId),
    ),
    settings: settings.claudeExecutable
      ? { claudeExecutable: settings.claudeExecutable }
      : {},
  };
}

export class ProjectStore {
  private data: StoreData = cloneEmptyStore();
  private initialized = false;
  private persistQueue: Promise<void> = Promise.resolve();

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
    return this.data.projects
      .map((project) => ({ ...project }))
      .sort(
        (left, right) =>
          Number(right.pinned) - Number(left.pinned) ||
          right.lastOpenedAt - left.lastOpenedAt,
      );
  }

  getProject(projectId: string): ProjectRecord | undefined {
    this.assertInitialized();
    const project = this.data.projects.find((item) => item.id === projectId);
    return project ? { ...project } : undefined;
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
      pinned: false,
      rootPath: canonicalPath,
      createdAt: now,
      lastOpenedAt: now,
    };
    this.data.projects.push(project);
    await this.persist();
    return { ...project };
  }

  async updateProject(request: UpdateProjectRequest): Promise<ProjectRecord> {
    this.assertInitialized();
    const project = this.data.projects.find(
      (candidate) => candidate.id === request.projectId,
    );
    if (!project) {
      throw new Error("Project does not exist.");
    }

    if (request.alias !== undefined) {
      const alias = request.alias?.trim() ?? "";
      if ([...alias].length > 60) {
        throw new Error("工程别名不能超过 60 个字符。");
      }
      if (/\p{Cc}/u.test(alias)) {
        throw new Error("工程别名不能包含控制字符。");
      }
      if (alias) {
        project.alias = alias;
      } else {
        delete project.alias;
      }
    }
    if (request.pinned !== undefined) {
      project.pinned = request.pinned;
    }

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
    this.data.sessions = this.data.sessions.filter(
      (session) => session.projectId !== projectId,
    );
    await this.persist();
  }

  listSessions(): SessionRecord[] {
    this.assertInitialized();
    return this.data.sessions
      .map((session) => ({ ...session }))
      .sort((left, right) => left.createdAt - right.createdAt);
  }

  async replaceSessions(sessions: SessionRecord[]): Promise<void> {
    this.assertInitialized();
    const projectIds = new Set(this.data.projects.map((project) => project.id));
    this.data.sessions = sessions
      .filter((session) => projectIds.has(session.projectId))
      .map((session) => ({ ...session }));
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
    return this.platform === "win32"
      ? normalized.toLocaleLowerCase("en-US")
      : normalized;
  }

  private persist(): Promise<void> {
    const serialized = `${JSON.stringify(this.data, null, 2)}\n`;
    const temporaryPath = `${this.storePath}.tmp`;
    const operation = this.persistQueue.then(async () => {
      try {
        await writeFile(temporaryPath, serialized, "utf8");
        await rename(temporaryPath, this.storePath);
      } catch (error) {
        await rm(temporaryPath, { force: true }).catch(() => undefined);
        throw error;
      }
    });
    this.persistQueue = operation.catch(() => undefined);
    return operation;
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
