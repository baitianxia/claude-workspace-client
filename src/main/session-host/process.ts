import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  SESSION_HOST_ENDPOINT_ENV,
  SESSION_HOST_LOG_PATH_ENV,
  SESSION_HOST_STATE_PATH_ENV,
  SESSION_HOST_TOKEN_ENV,
} from "./protocol";
import { SessionHostServer } from "./server";

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const logPath = process.env[SESSION_HOST_LOG_PATH_ENV];

async function log(message: string): Promise<void> {
  if (!logPath) {
    return;
  }
  await mkdir(dirname(logPath), { recursive: true });
  await appendFile(logPath, `${new Date().toISOString()} ${message}\n`, "utf8");
}

async function main(): Promise<void> {
  const server = new SessionHostServer({
    endpoint: requiredEnvironment(SESSION_HOST_ENDPOINT_ENV),
    token: requiredEnvironment(SESSION_HOST_TOKEN_ENV),
    statePath: requiredEnvironment(SESSION_HOST_STATE_PATH_ENV),
  });
  let stopping = false;
  const stop = async (reason: string) => {
    if (stopping) {
      return;
    }
    stopping = true;
    await log(`stopping: ${reason}`).catch(() => undefined);
    await server.stop().catch((error: unknown) =>
      log(
        `stop failed: ${error instanceof Error ? error.stack : String(error)}`,
      ),
    );
    process.exit(0);
  };
  server.on("idle", () => void stop("idle"));
  process.once("SIGINT", () => void stop("SIGINT"));
  process.once("SIGTERM", () => void stop("SIGTERM"));
  await server.start();
  await log(`started pid=${process.pid}`).catch(() => undefined);
}

void main().catch(async (error: unknown) => {
  const detail =
    error instanceof Error ? error.stack ?? error.message : String(error);
  await log(`fatal: ${detail}`).catch(() => undefined);
  process.exit(1);
});
