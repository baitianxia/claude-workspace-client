import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";

const MAX_ASSISTANT_RUNTIME_PATH_CHARACTERS = 4_000;

/**
 * Resolve the path saved for an assistant. The picker and the IPC boundary
 * both pass through this function so a profile never silently runs from a
 * workbench project selected elsewhere.
 */
export async function validateAssistantRuntimePath(value: unknown): Promise<string> {
  if (typeof value !== "string") {
    throw new Error("私人助理运行目录必须是字符串。");
  }
  const normalized = value.trim();
  if (
    !normalized ||
    [...normalized].length > MAX_ASSISTANT_RUNTIME_PATH_CHARACTERS ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(normalized)
  ) {
    throw new Error("私人助理运行目录格式无效。");
  }
  const absolutePath = resolve(normalized);
  let details: Awaited<ReturnType<typeof stat>>;
  try {
    details = await stat(absolutePath);
  } catch {
    throw new Error("私人助理运行目录不存在或无法访问。");
  }
  if (!details.isDirectory()) {
    throw new Error("私人助理运行目录必须是文件夹。");
  }
  try {
    return await realpath(absolutePath);
  } catch {
    throw new Error("私人助理运行目录无法解析。");
  }
}

export function assistantRuntimePathKey(value: string): string {
  const normalized = resolve(value);
  return process.platform === "win32"
    ? normalized.toLocaleLowerCase("en-US")
    : normalized;
}

/** Return the legacy workbench path only while an old profile is migrating. */
export function legacyRuntimePath(
  profile: { projectPath?: string; projectId?: string },
  getProject?: (projectId: string) => { rootPath: string } | undefined,
): string | undefined {
  const directPath = profile.projectPath?.trim();
  if (directPath) {
    return directPath;
  }
  if (profile.projectId && getProject) {
    return getProject(profile.projectId)?.rootPath;
  }
  return undefined;
}
