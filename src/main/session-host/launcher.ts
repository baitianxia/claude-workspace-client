import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import {
  access,
  cp,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createConnection } from "node:net";
import { SessionHostClient } from "./client";
import {
  SESSION_HOST_ENDPOINT_ENV,
  SESSION_HOST_EXECUTABLE_FILENAME,
  SESSION_HOST_LOG_PATH_ENV,
  SESSION_HOST_RUNTIME_VERSION,
  SESSION_HOST_STATE_PATH_ENV,
  SESSION_HOST_TOKEN_ENV,
} from "./protocol";

const CONNECT_RETRY_DELAY_MS = 100;
const CONNECT_RETRY_COUNT = 50;
const AUTH_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

export interface SessionHostPaths {
  root: string;
  endpoint: string;
  tokenPath: string;
  statePath: string;
  logPath: string;
  runtimePath: string;
}

export interface SessionHostLauncherOptions {
  userDataPath: string;
  isPackaged: boolean;
  resourcesPath: string;
  platform?: NodeJS.Platform;
  developmentExecutablePath?: string;
  developmentHostScriptPath?: string;
}

interface HostCommand {
  executable: string;
  script: string;
  cwd: string;
  extraEnvironment?: NodeJS.ProcessEnv;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function endpointHash(userDataPath: string): string {
  return createHash("sha256")
    .update(resolve(userDataPath))
    .digest("hex")
    .slice(0, 24);
}

export function resolveSessionHostPaths(
  userDataPath: string,
  platform: NodeJS.Platform = process.platform,
): SessionHostPaths {
  const root = join(userDataPath, "session-host");
  const hash = endpointHash(userDataPath);
  return {
    root,
    endpoint:
      platform === "win32"
        ? `\\\\.\\pipe\\claude-workspace-session-${hash}`
        : join(tmpdir(), `claude-workspace-session-${hash}.sock`),
    tokenPath: join(root, "auth-token"),
    statePath: join(root, "state.json"),
    logPath: join(root, "host.log"),
    runtimePath: join(
      root,
      "versions",
      `runtime-${SESSION_HOST_RUNTIME_VERSION}`,
    ),
  };
}

async function readOrCreateToken(paths: SessionHostPaths): Promise<string> {
  await mkdir(paths.root, { recursive: true });
  try {
    const existing = (await readFile(paths.tokenPath, "utf8")).trim();
    if (AUTH_TOKEN_PATTERN.test(existing)) {
      return existing;
    }
    await rename(
      paths.tokenPath,
      `${paths.tokenPath}.invalid-${Date.now()}`,
    ).catch(() => undefined);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  const token = randomBytes(32).toString("base64url");
  try {
    await writeFile(paths.tokenPath, `${token}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    return token;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
    const racedToken = (await readFile(paths.tokenPath, "utf8")).trim();
    if (!AUTH_TOKEN_PATTERN.test(racedToken)) {
      throw new Error("Session Host authentication token is invalid.");
    }
    return racedToken;
  }
}

async function pathExists(candidatePath: string): Promise<boolean> {
  try {
    await access(candidatePath);
    return true;
  } catch {
    return false;
  }
}

async function stagePackagedRuntime(
  options: SessionHostLauncherOptions,
  paths: SessionHostPaths,
): Promise<HostCommand> {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    throw new Error("The packaged Session Host currently supports Windows only.");
  }
  const sourcePath = join(options.resourcesPath, "session-host");
  const executableRelativePath = SESSION_HOST_EXECUTABLE_FILENAME;
  const scriptRelativePath = join(
    "dist",
    "main",
    "main",
    "session-host",
    "process.js",
  );
  const executable = join(paths.runtimePath, executableRelativePath);
  const script = join(paths.runtimePath, scriptRelativePath);
  if (!(await pathExists(executable)) || !(await pathExists(script))) {
    await mkdir(dirname(paths.runtimePath), { recursive: true });
    if (await pathExists(paths.runtimePath)) {
      await rename(
        paths.runtimePath,
        `${paths.runtimePath}.invalid-${Date.now()}`,
      );
    }
    const stagingPath = `${paths.runtimePath}.staging-${randomBytes(8).toString("hex")}`;
    try {
      await cp(sourcePath, stagingPath, {
        recursive: true,
        force: false,
        errorOnExist: true,
      });
      await rename(stagingPath, paths.runtimePath);
    } catch (error) {
      await rm(stagingPath, { recursive: true, force: true }).catch(
        () => undefined,
      );
      throw error;
    }
  }
  if (!(await pathExists(executable)) || !(await pathExists(script))) {
    throw new Error("The bundled Session Host runtime is incomplete.");
  }
  return { executable, script, cwd: paths.runtimePath };
}

function developmentCommand(
  options: SessionHostLauncherOptions,
): HostCommand {
  const script =
    options.developmentHostScriptPath ?? join(__dirname, "process.js");
  return {
    executable: options.developmentExecutablePath ?? process.execPath,
    script,
    cwd: dirname(script),
    extraEnvironment: process.versions.electron
      ? { ELECTRON_RUN_AS_NODE: "1" }
      : undefined,
  };
}

async function connectOnce(
  endpoint: string,
  token: string,
  connectTimeoutMs = 500,
): Promise<SessionHostClient | null> {
  try {
    return await SessionHostClient.connect(endpoint, token, {
      connectTimeoutMs,
    });
  } catch {
    return null;
  }
}

async function endpointReachable(
  endpoint: string,
  timeoutMs = 500,
): Promise<boolean> {
  return new Promise((resolveReachable) => {
    const socket = createConnection(endpoint);
    let settled = false;
    const finish = (reachable: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolveReachable(reachable);
    };
    // A timeout is treated as occupied. Starting a competing Host is more
    // dangerous than asking the user to retry when an endpoint is unhealthy.
    const timer = setTimeout(() => finish(true), timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

async function waitForHostExit(
  endpoint: string,
  timeoutMs = 4_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await endpointReachable(endpoint, 100))) {
      return;
    }
    await delay(50);
  }
  throw new Error("旧版 Session Host 未能及时退出。");
}

async function connectWithRetry(
  endpoint: string,
  token: string,
): Promise<SessionHostClient> {
  let lastError: unknown;
  for (let attempt = 0; attempt < CONNECT_RETRY_COUNT; attempt += 1) {
    try {
      return await SessionHostClient.connect(endpoint, token, {
        connectTimeoutMs: 750,
      });
    } catch (error) {
      lastError = error;
      await delay(CONNECT_RETRY_DELAY_MS);
    }
  }
  const detail = lastError instanceof Error ? ` ${lastError.message}` : "";
  throw new Error(`无法启动或连接 Session Host。${detail}`);
}

async function spawnHost(
  command: HostCommand,
  paths: SessionHostPaths,
  token: string,
): Promise<void> {
  await new Promise<void>((resolveSpawn, rejectSpawn) => {
    const child = spawn(command.executable, [command.script], {
      cwd: command.cwd,
      detached: true,
      windowsHide: true,
      stdio: "ignore",
      env: {
        ...process.env,
        ...command.extraEnvironment,
        [SESSION_HOST_ENDPOINT_ENV]: paths.endpoint,
        [SESSION_HOST_TOKEN_ENV]: token,
        [SESSION_HOST_STATE_PATH_ENV]: paths.statePath,
        [SESSION_HOST_LOG_PATH_ENV]: paths.logPath,
      },
    });
    child.once("error", rejectSpawn);
    child.once("spawn", () => {
      child.removeListener("error", rejectSpawn);
      child.on("error", () => undefined);
      child.unref();
      resolveSpawn();
    });
  });
}

async function replaceIdleRuntime(
  client: SessionHostClient,
  endpoint: string,
): Promise<boolean> {
  if (client.runtimeVersion === SESSION_HOST_RUNTIME_VERSION) {
    return false;
  }
  const snapshot = await client.refreshSnapshot();
  if (
    snapshot.sessions.some(
      (session) =>
        session.status === "running" || session.status === "starting",
    )
  ) {
    return false;
  }
  const willShutdown = await client.shutdownIfIdle();
  if (!willShutdown) {
    return false;
  }
  client.close();
  await waitForHostExit(endpoint);
  return true;
}

/**
 * Connect to the per-user Session Host, starting a detached Host when needed.
 * A compatible older Host remains in use while it owns running sessions.
 */
export async function connectSessionHost(
  options: SessionHostLauncherOptions,
): Promise<{ client: SessionHostClient; paths: SessionHostPaths }> {
  const platform = options.platform ?? process.platform;
  const paths = resolveSessionHostPaths(options.userDataPath, platform);
  const token = await readOrCreateToken(paths);
  const existing = await connectOnce(paths.endpoint, token);
  if (existing && !(await replaceIdleRuntime(existing, paths.endpoint))) {
    return { client: existing, paths };
  }
  if (!existing && (await endpointReachable(paths.endpoint))) {
    throw new Error(
      "检测到无法认证或协议不兼容的 Session Host；为避免中断后台会话，客户端不会强制替换它。",
    );
  }

  if (platform !== "win32") {
    await rm(paths.endpoint, { force: true }).catch(() => undefined);
  }
  const command = options.isPackaged
    ? await stagePackagedRuntime(options, paths)
    : developmentCommand(options);
  await spawnHost(command, paths, token);
  try {
    const client = await connectWithRetry(paths.endpoint, token);
    return { client, paths };
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)} ` +
        `详细信息请查看 ${paths.logPath}`,
    );
  }
}
