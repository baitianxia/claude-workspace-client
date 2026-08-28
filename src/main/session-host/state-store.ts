import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { SessionRecord, SessionStatus } from "../../shared/contracts";

interface StoredSessionHostState {
  version: 1;
  sessions: SessionRecord[];
}

const SESSION_STATUSES = new Set<SessionStatus>([
  "starting",
  "running",
  "exited",
  "failed",
  "interrupted",
]);

export function normalizeSessionRecord(value: unknown): SessionRecord | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as Partial<SessionRecord>;
  if (
    typeof candidate.id !== "string" ||
    !candidate.id ||
    candidate.id.length > 200 ||
    (candidate.projectId !== null &&
      (typeof candidate.projectId !== "string" ||
        !candidate.projectId ||
        candidate.projectId.length > 200)) ||
    typeof candidate.title !== "string" ||
    !candidate.title.trim() ||
    [...candidate.title].length > 80 ||
    /\p{Cc}/u.test(candidate.title) ||
    typeof candidate.cwd !== "string" ||
    !candidate.cwd ||
    candidate.cwd.length > 32_000 ||
    typeof candidate.status !== "string" ||
    !SESSION_STATUSES.has(candidate.status as SessionStatus) ||
    typeof candidate.createdAt !== "number" ||
    !Number.isFinite(candidate.createdAt) ||
    candidate.createdAt < 0 ||
    (candidate.exitCode !== undefined &&
      (!Number.isInteger(candidate.exitCode) ||
        !Number.isFinite(candidate.exitCode))) ||
    (candidate.error !== undefined &&
      (typeof candidate.error !== "string" || candidate.error.length > 32_000))
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

export interface LoadedSessionHostState {
  existed: boolean;
  sessions: SessionRecord[];
}

export class SessionHostStateStore {
  private persistQueue: Promise<void> = Promise.resolve();

  constructor(private readonly statePath: string) {}

  async load(): Promise<LoadedSessionHostState> {
    await mkdir(dirname(this.statePath), { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(this.statePath, "utf8")) as {
        version?: unknown;
        sessions?: unknown;
      };
      if (parsed.version !== 1 || !Array.isArray(parsed.sessions)) {
        throw new Error("Session Host state has an unsupported format.");
      }
      const sessions = parsed.sessions.map(normalizeSessionRecord);
      if (
        sessions.some((session) => session === null) ||
        new Set(sessions.map((session) => session?.id)).size !== sessions.length
      ) {
        throw new Error("Session Host state contains an invalid session.");
      }
      return { existed: true, sessions: sessions as SessionRecord[] };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { existed: false, sessions: [] };
      }
      const corruptPath = `${this.statePath}.corrupt-${Date.now()}.json`;
      await rename(this.statePath, corruptPath).catch(() => undefined);
      return { existed: false, sessions: [] };
    }
  }

  persist(sessions: SessionRecord[]): Promise<void> {
    const state: StoredSessionHostState = {
      version: 1,
      sessions: sessions.map((session) => ({ ...session })),
    };
    const serialized = `${JSON.stringify(state, null, 2)}\n`;
    const temporaryPath = `${this.statePath}.tmp`;
    const operation = this.persistQueue.then(async () => {
      try {
        await writeFile(temporaryPath, serialized, { encoding: "utf8", mode: 0o600 });
        await rename(temporaryPath, this.statePath);
      } catch (error) {
        await rm(temporaryPath, { force: true }).catch(() => undefined);
        throw error;
      }
    });
    this.persistQueue = operation.catch(() => undefined);
    return operation;
  }
}
