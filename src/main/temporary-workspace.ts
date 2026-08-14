import { mkdir, mkdtemp, rm } from "node:fs/promises";
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
      maxRetries: 5,
      retryDelay: 150,
    });
  }
}
