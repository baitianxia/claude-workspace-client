import {
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { isAbsolute, join, relative, resolve } from "node:path";

const MAX_MCP_CONFIG_BYTES = 2 * 1024 * 1024;

export interface RestrictedMcpConfigInput {
  projectRoot: string;
  mcpConfigPath: string;
  allowedMcpServers: string[];
  runtimeDirectory: string;
  runtimeId: string;
}

export interface PreparedRestrictedMcpConfig {
  path: string;
  cleanup(): Promise<void>;
}

export async function prepareRestrictedMcpConfig(
  input: RestrictedMcpConfigInput,
): Promise<PreparedRestrictedMcpConfig> {
  let selectedServers: Record<string, unknown> = {};
  if (input.allowedMcpServers.length > 0) {
    if (!input.mcpConfigPath || isAbsolute(input.mcpConfigPath)) {
      throw new Error("MCP 配置必须使用工程内的相对路径。");
    }
    const projectRoot = await realpath(input.projectRoot);
    const requestedPath = resolve(projectRoot, input.mcpConfigPath);
    const sourcePath = await realpath(requestedPath);
    const sourceRelativePath = relative(projectRoot, sourcePath);
    if (
      !sourceRelativePath ||
      sourceRelativePath.startsWith("..") ||
      isAbsolute(sourceRelativePath)
    ) {
      throw new Error("MCP 配置必须是工程目录内的普通 JSON 文件。");
    }
    const sourceStat = await stat(sourcePath);
    if (!sourceStat.isFile() || sourceStat.size > MAX_MCP_CONFIG_BYTES) {
      throw new Error("MCP 配置不是普通文件或超过 2 MB 限制。");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(sourcePath, "utf8")) as unknown;
    } catch {
      throw new Error("MCP 配置不是有效的 JSON 文件。");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("MCP 配置根节点必须是 JSON 对象。");
    }
    const allServers = (parsed as { mcpServers?: unknown }).mcpServers;
    if (!allServers || typeof allServers !== "object" || Array.isArray(allServers)) {
      throw new Error("MCP 配置必须包含 mcpServers 对象。");
    }
    const serverMap = allServers as Record<string, unknown>;
    selectedServers = {};
    for (const serverName of input.allowedMcpServers) {
      if (!Object.hasOwn(serverMap, serverName)) {
        throw new Error(`MCP 配置中没有名为 ${serverName} 的服务器。`);
      }
      selectedServers[serverName] = serverMap[serverName];
    }
  }

  await mkdir(input.runtimeDirectory, { recursive: true, mode: 0o700 });
  const safeRuntimeId = input.runtimeId.replace(/[^a-zA-Z0-9_-]/gu, "_").slice(0, 80);
  const runtimePath = join(
    input.runtimeDirectory,
    `${safeRuntimeId || "run"}-${randomUUID()}.mcp.json`,
  );
  await writeFile(
    runtimePath,
    `${JSON.stringify({ mcpServers: selectedServers }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  return {
    path: runtimePath,
    cleanup: () => rm(runtimePath, { force: true }),
  };
}
