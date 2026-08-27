import { execFile } from "node:child_process";
import {
  lstat,
  readFile,
  readlink,
  realpath,
} from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import { promisify } from "node:util";
import type {
  WorkspaceChangesSnapshot,
  WorkspaceFileChange,
  WorkspaceFileContent,
  WorkspaceFileStatus,
  WorkspaceFileViewMode,
} from "../shared/contracts";

const execFileAsync = promisify(execFile);
const MAX_STATUS_BYTES = 8 * 1024 * 1024;
const MAX_DIFF_BYTES = 3 * 1024 * 1024;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_VISIBLE_CHANGES = 2_000;

interface GitFailure extends Error {
  code?: number | string;
  stderr?: string;
}

interface RepositoryContext {
  projectRoot: string;
  repositoryRoot: string;
  projectPrefix: string;
  hasHead: boolean;
}

interface InternalFileChange extends WorkspaceFileChange {
  repositoryPath: string;
  previousRepositoryPath?: string;
}

interface WorkspaceScan {
  context: RepositoryContext;
  files: InternalFileChange[];
}

function gitErrorMessage(error: unknown): string {
  const failure = error as GitFailure;
  if (failure.code === "ENOENT") {
    return "未找到 Git，无法读取工程修改。";
  }
  if (
    failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ||
    /maxBuffer/iu.test(failure.message)
  ) {
    return "Git 输出超过客户端允许的大小。";
  }
  const stderr = typeof failure.stderr === "string" ? failure.stderr.trim() : "";
  return stderr || failure.message || "Git 命令执行失败。";
}

async function runGit(
  cwd: string,
  args: string[],
  maxBuffer = MAX_STATUS_BYTES,
): Promise<string> {
  try {
    const result = await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        LANG: "C",
        LC_ALL: "C",
      },
      maxBuffer,
      windowsHide: true,
    });
    return result.stdout;
  } catch (error) {
    throw new Error(gitErrorMessage(error));
  }
}

function normalizeGitPath(path: string): string {
  return path.split(sep).join("/");
}

function isInsideDirectory(
  parent: string,
  candidate: string,
  platform: NodeJS.Platform,
): boolean {
  const parentPath = platform === "win32" ? parent.toLocaleLowerCase() : parent;
  const candidatePath =
    platform === "win32" ? candidate.toLocaleLowerCase() : candidate;
  const pathFromParent = relative(parentPath, candidatePath);
  return (
    pathFromParent === "" ||
    (pathFromParent !== ".." &&
      !pathFromParent.startsWith(`..${sep}`) &&
      !isAbsolute(pathFromParent))
  );
}

function requireSafeRelativePath(path: string): string {
  if (
    !path ||
    path.length > 4_096 ||
    path.includes("\\") ||
    /\p{Cc}/u.test(path) ||
    path.startsWith("/")
  ) {
    throw new Error("文件路径无效。请刷新修改列表后重试。");
  }
  const segments = path.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("文件路径超出当前工程范围。");
  }
  return path;
}

function classifyStatus(
  indexStatus: string,
  worktreeStatus: string,
): WorkspaceFileStatus {
  const pair = `${indexStatus}${worktreeStatus}`;
  if (
    indexStatus === "U" ||
    worktreeStatus === "U" ||
    ["DD", "AU", "UD", "UA", "DU", "AA", "UU"].includes(pair)
  ) {
    return "conflicted";
  }
  if (indexStatus === "R" || worktreeStatus === "R") {
    return "renamed";
  }
  if (indexStatus === "C" || worktreeStatus === "C") {
    return "copied";
  }
  if (pair === "??") {
    return "untracked";
  }
  if (indexStatus === "D" || worktreeStatus === "D") {
    return "deleted";
  }
  if (indexStatus === "A" || worktreeStatus === "A") {
    return "added";
  }
  return "modified";
}

export function parsePorcelainStatus(output: string): InternalFileChange[] {
  const records = output.split("\0");
  const changes: InternalFileChange[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record || record.length < 4) {
      continue;
    }
    const indexStatus = record[0];
    const worktreeStatus = record[1];
    if (`${indexStatus}${worktreeStatus}` === "!!") {
      continue;
    }
    const repositoryPath = record.slice(3);
    let previousRepositoryPath: string | undefined;
    if (
      indexStatus === "R" ||
      indexStatus === "C" ||
      worktreeStatus === "R" ||
      worktreeStatus === "C"
    ) {
      previousRepositoryPath = records[index + 1] || undefined;
      index += 1;
    }
    changes.push({
      path: repositoryPath,
      repositoryPath,
      ...(previousRepositoryPath
        ? { previousPath: previousRepositoryPath, previousRepositoryPath }
        : {}),
      status: classifyStatus(indexStatus, worktreeStatus),
      staged: indexStatus !== " " && indexStatus !== "?" && indexStatus !== "!",
      unstaged: worktreeStatus !== " " && worktreeStatus !== "!",
    });
  }
  return changes;
}

function projectRelativePath(
  repositoryPath: string,
  projectPrefix: string,
): string | null {
  if (!projectPrefix) {
    return repositoryPath;
  }
  const prefix = `${projectPrefix}/`;
  return repositoryPath.startsWith(prefix)
    ? repositoryPath.slice(prefix.length)
    : null;
}

function isBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8_192));
  if (sample.includes(0)) {
    return true;
  }
  let controlBytes = 0;
  for (const byte of sample) {
    if ((byte < 7 || (byte > 13 && byte < 32)) && byte !== 27) {
      controlBytes += 1;
    }
  }
  return sample.length > 0 && controlBytes / sample.length > 0.15;
}

function lineCount(content: string): number {
  if (!content) {
    return 0;
  }
  return content.endsWith("\n")
    ? content.split("\n").length - 1
    : content.split("\n").length;
}

function formatDiffPath(prefix: "a" | "b", path: string): string {
  const fullPath = `${prefix}/${path}`;
  return /["\\]/u.test(fullPath) ? JSON.stringify(fullPath) : fullPath;
}

export function createAddedFileDiff(path: string, content: string): string {
  const beforePath = formatDiffPath("a", path);
  const afterPath = formatDiffPath("b", path);
  const lines = content.split("\n");
  if (content.endsWith("\n")) {
    lines.pop();
  }
  const additions = lines.map((line) => `+${line}`).join("\n");
  const suffix =
    content.endsWith("\n") || !content
      ? "\n"
      : "\n\\ No newline at end of file\n";
  return [
    `diff --git ${beforePath} ${afterPath}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ ${afterPath}`,
    `@@ -0,0 +1,${lineCount(content)} @@`,
    additions,
  ].join("\n") + suffix;
}

export class WorkspaceFiles {
  constructor(private readonly platform: NodeJS.Platform = process.platform) {}

  async list(projectRoot: string): Promise<WorkspaceChangesSnapshot> {
    const scan = await this.scan(projectRoot);
    if (!scan) {
      return {
        isGitRepository: false,
        files: [],
        truncated: false,
      };
    }
    return {
      isGitRepository: true,
      files: scan.files.slice(0, MAX_VISIBLE_CHANGES).map((file) => ({
        path: file.path,
        ...(file.previousPath ? { previousPath: file.previousPath } : {}),
        status: file.status,
        staged: file.staged,
        unstaged: file.unstaged,
      })),
      truncated: scan.files.length > MAX_VISIBLE_CHANGES,
    };
  }

  async read(
    projectRoot: string,
    path: string,
    mode: WorkspaceFileViewMode,
  ): Promise<WorkspaceFileContent> {
    const safePath = requireSafeRelativePath(path);
    const scan = await this.scan(projectRoot);
    if (!scan) {
      throw new Error("当前工程不是 Git 仓库。");
    }
    const change = scan.files.find((candidate) => candidate.path === safePath);
    if (!change) {
      throw new Error("该文件已不在修改列表中，请刷新后重试。");
    }
    if (mode === "latest") {
      return this.readLatest(scan.context, change);
    }
    if (mode !== "diff") {
      throw new Error("不支持的文件查看方式。");
    }
    return this.readDiff(scan.context, change);
  }

  private async repositoryContext(
    projectRoot: string,
  ): Promise<RepositoryContext | null> {
    const canonicalProjectRoot = await realpath(projectRoot).catch(() => {
      throw new Error("工程目录不存在或无法访问。");
    });
    let repositoryRootOutput: string;
    try {
      repositoryRootOutput = await runGit(canonicalProjectRoot, [
        "rev-parse",
        "--show-toplevel",
      ]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/not a git repository/iu.test(message)) {
        return null;
      }
      throw error;
    }
    const repositoryRoot = await realpath(repositoryRootOutput.trim());
    if (!isInsideDirectory(repositoryRoot, canonicalProjectRoot, this.platform)) {
      throw new Error("Git 仓库根目录与当前工程不一致。");
    }
    const projectPrefix = normalizeGitPath(
      relative(repositoryRoot, canonicalProjectRoot),
    );
    let hasHead = true;
    try {
      await runGit(repositoryRoot, ["rev-parse", "--verify", "HEAD"]);
    } catch {
      hasHead = false;
    }
    return {
      projectRoot: canonicalProjectRoot,
      repositoryRoot,
      projectPrefix,
      hasHead,
    };
  }

  private async scan(projectRoot: string): Promise<WorkspaceScan | null> {
    const context = await this.repositoryContext(projectRoot);
    if (!context) {
      return null;
    }
    const status = await runGit(context.repositoryRoot, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--",
      context.projectPrefix || ".",
    ]);
    const files = parsePorcelainStatus(status)
      .flatMap((file): InternalFileChange[] => {
        const relativePath = projectRelativePath(
          file.repositoryPath,
          context.projectPrefix,
        );
        if (!relativePath) {
          return [];
        }
        try {
          requireSafeRelativePath(relativePath);
        } catch {
          return [];
        }
        const previousPath = file.previousRepositoryPath
          ? projectRelativePath(
              file.previousRepositoryPath,
              context.projectPrefix,
            )
          : null;
        return [
          {
            ...file,
            path: relativePath,
            ...(previousPath ? { previousPath } : { previousPath: undefined }),
          },
        ];
      })
      .sort((left, right) => left.path.localeCompare(right.path, "zh-CN"));
    return { context, files };
  }

  private async readLatest(
    context: RepositoryContext,
    change: InternalFileChange,
  ): Promise<WorkspaceFileContent> {
    if (change.status === "deleted") {
      return {
        path: change.path,
        mode: "latest",
        kind: "deleted",
        content: "",
      };
    }
    const absolutePath = resolve(
      context.projectRoot,
      ...change.path.split("/"),
    );
    if (!isInsideDirectory(context.projectRoot, absolutePath, this.platform)) {
      throw new Error("文件路径超出当前工程范围。");
    }
    let fileStat;
    try {
      fileStat = await lstat(absolutePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return {
          path: change.path,
          mode: "latest",
          kind: "deleted",
          content: "",
        };
      }
      throw error;
    }
    if (fileStat.isSymbolicLink()) {
      const target = await readlink(absolutePath);
      const resolvedTarget = resolve(dirname(absolutePath), target);
      if (
        !isInsideDirectory(context.projectRoot, resolvedTarget, this.platform)
      ) {
        throw new Error("符号链接目标超出当前工程范围。");
      }
      return {
        path: change.path,
        mode: "latest",
        kind: "text",
        content: target,
        size: Buffer.byteLength(target),
      };
    }
    if (!fileStat.isFile()) {
      throw new Error("当前修改项不是可读取的普通文件。");
    }
    if (fileStat.size > MAX_FILE_BYTES) {
      return {
        path: change.path,
        mode: "latest",
        kind: "too-large",
        content: "",
        size: fileStat.size,
      };
    }
    const canonicalFile = await realpath(absolutePath);
    if (!isInsideDirectory(context.projectRoot, canonicalFile, this.platform)) {
      throw new Error("符号链接目标超出当前工程范围。");
    }
    const buffer = await readFile(canonicalFile);
    if (isBinary(buffer)) {
      return {
        path: change.path,
        mode: "latest",
        kind: "binary",
        content: "",
        size: buffer.length,
      };
    }
    return {
      path: change.path,
      mode: "latest",
      kind: "text",
      content: buffer.toString("utf8"),
      size: buffer.length,
    };
  }

  private async readDiff(
    context: RepositoryContext,
    change: InternalFileChange,
  ): Promise<WorkspaceFileContent> {
    if (change.status === "untracked" || !context.hasHead) {
      const latest = await this.readLatest(context, change);
      if (latest.kind !== "text") {
        return { ...latest, mode: "diff" };
      }
      return {
        path: change.path,
        mode: "diff",
        kind: "text",
        content: createAddedFileDiff(change.path, latest.content),
        size: latest.size,
      };
    }
    const paths = [change.repositoryPath];
    if (change.previousPath && change.previousRepositoryPath) {
      paths.push(change.previousRepositoryPath);
    }
    const args = [
      "diff",
      "--no-ext-diff",
      "--no-color",
      "--find-renames",
      ...(context.projectPrefix
        ? [`--relative=${context.projectPrefix}`]
        : []),
      "HEAD",
      "--",
      ...paths,
    ];
    let content: string;
    try {
      content = await runGit(context.repositoryRoot, args, MAX_DIFF_BYTES);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/超过客户端允许的大小/u.test(message)) {
        return {
          path: change.path,
          mode: "diff",
          kind: "too-large",
          content: "",
        };
      }
      throw error;
    }
    return {
      path: change.path,
      mode: "diff",
      kind: "text",
      content,
      size: Buffer.byteLength(content),
    };
  }
}
