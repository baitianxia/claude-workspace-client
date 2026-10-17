import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

export class TemporaryWorkspace {
  private readonly rootPath: string;

  constructor(rootPath: string) {
    this.rootPath = resolve(rootPath);
  }

  async createDirectory(): Promise<string> {
    await mkdir(this.rootPath, { recursive: true });
    return mkdtemp(join(this.rootPath, "session-"));
  }

  async removeDirectory(candidatePath: string): Promise<void> {
    const resolvedCandidate = resolve(candidatePath);
    const relativePath = relative(this.rootPath, resolvedCandidate);
    if (
      !relativePath ||
      relativePath === ".." ||
      relativePath.startsWith(`..${sep}`) ||
      isAbsolute(relativePath) ||
      dirname(resolvedCandidate) !== this.rootPath ||
      !basename(resolvedCandidate).startsWith("session-")
    ) {
      throw new Error("Refusing to remove an unmanaged temporary workspace.");
    }
    await rm(resolvedCandidate, {
      recursive: true,
      force: true,
      // A just-terminated process can hold the directory for a moment on
      // Windows; retry for about two seconds before giving up.
      maxRetries: 10,
      retryDelay: 200,
    });
  }

  /**
   * Delete temporary session directories that no saved session refers to,
   * for example ones left behind when an earlier removal failed. Returns the
   * number of directories removed.
   *
   * `referencedPaths` may be a function: it is called again right before
   * each removal, so a session created while the cleanup is running is not
   * mistaken for an orphan. Directories modified within `minimumAgeMs` are
   * also skipped, which covers the short window between creating a new
   * session's directory and registering the session.
   */
  async removeOrphans(
    referencedPaths: string[] | (() => string[]),
    platform: NodeJS.Platform = process.platform,
    minimumAgeMs = 60_000,
    now: () => number = Date.now,
  ): Promise<number> {
    const key = (value: string) =>
      platform === "win32" ? resolve(value).toLocaleLowerCase("en-US") : resolve(value);
    const currentReferences = () =>
      new Set(
        (typeof referencedPaths === "function" ? referencedPaths() : referencedPaths).map(key),
      );
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(this.rootPath, { withFileTypes: true });
    } catch {
      return 0;
    }
    let removed = 0;
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith("session-")) {
        continue;
      }
      const candidate = join(this.rootPath, entry.name);
      if (minimumAgeMs > 0) {
        try {
          const info = await stat(candidate);
          const changedAt = Math.max(info.mtimeMs, info.ctimeMs, info.birthtimeMs || 0);
          if (now() - changedAt < minimumAgeMs) {
            continue;
          }
        } catch {
          continue;
        }
      }
      // Re-read the references right before removing: sessions may have been
      // created or restored while earlier directories were being deleted.
      if (currentReferences().has(key(candidate))) {
        continue;
      }
      try {
        await this.removeDirectory(candidate);
        removed += 1;
      } catch (error) {
        console.error("Failed to remove orphaned temporary workspace", error);
      }
    }
    return removed;
  }
}
