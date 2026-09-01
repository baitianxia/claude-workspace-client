import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AssistantStore } from "../src/main/assistant-store";
import type {
  AssistantConversationRecord,
  AssistantProfileRecord,
  AssistantTurnRecord,
} from "../src/shared/contracts";

const temporaryDirectories: string[] = [];

function profile(): AssistantProfileRecord {
  return {
    id: "assistant-one",
    name: "小岚",
    enabled: true,
    projectId: "project-one",
    instructions: "先给结论。",
    ownerWeComUserId: "zhangsan",
    wecomBotProfileId: "bot-one",
    timeoutMinutes: 20,
    maxTurns: 20,
    createdAt: 1,
    updatedAt: 1,
  };
}

function conversation(): AssistantConversationRecord {
  return {
    id: "assistant-one",
    assistantId: "assistant-one",
    kind: "owner",
    claudeSessionId: "550e8400-e29b-41d4-a716-446655440000",
    createdAt: 1,
    updatedAt: 1,
  };
}

function turn(): AssistantTurnRecord {
  return {
    id: "turn-one",
    assistantId: "assistant-one",
    conversationId: "assistant-one",
    source: "desktop",
    request: "继续处理",
    status: "running",
    createdAt: 2,
    startedAt: 3,
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("AssistantStore", () => {
  it("persists profiles and safely fails interrupted turns on recovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "assistant-store-"));
    temporaryDirectories.push(root);
    const storePath = join(root, "assistant.json");
    const first = new AssistantStore(storePath);
    await first.initialize();
    await first.putProfile(profile());
    await first.putConversation(conversation());
    await first.appendTurn(turn());

    const restored = new AssistantStore(storePath);
    await restored.initialize();
    expect(await restored.recoverInterruptedTurns(100)).toBe(1);
    expect(restored.listTurns()).toEqual([
      expect.objectContaining({
        id: "turn-one",
        status: "failed",
        finishedAt: 100,
      }),
    ]);
    expect(restored.getConversation("assistant-one")?.claudeSessionId).toBe(
      "550e8400-e29b-41d4-a716-446655440000",
    );
    expect(restored.getConversation("assistant-one")?.lastMessageAt).toBe(2);
    expect(restored.findProfileByWeComBot("bot-one")?.name).toBe("小岚");
  });

  it("resets only the selected owner conversation", async () => {
    const root = await mkdtemp(join(tmpdir(), "assistant-store-reset-"));
    temporaryDirectories.push(root);
    const store = new AssistantStore(join(root, "assistant.json"));
    await store.initialize();
    await store.putProfile(profile());
    await store.putConversation(conversation());
    await store.appendTurn({ ...turn(), status: "succeeded", response: "完成" });

    const reset = await store.resetConversation("assistant-one", 200);

    expect(reset.claudeSessionId).toBeUndefined();
    expect(reset.lastMessageAt).toBe(2);
    expect(store.listTurnsForConversation("assistant-one")).toEqual([]);
  });

  it("persists a terminal turn and its resumable session in one store snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "assistant-store-complete-"));
    temporaryDirectories.push(root);
    const storePath = join(root, "assistant.json");
    const store = new AssistantStore(storePath);
    await store.initialize();
    await store.putProfile(profile());
    await store.putConversation(conversation());
    await store.appendTurn(turn());

    const nextSession = "550e8400-e29b-41d4-a716-446655440001";
    await store.completeTurn(
      {
        ...turn(),
        status: "succeeded",
        response: "完成",
        finishedAt: 10,
      },
      nextSession,
      10,
    );

    const persisted = JSON.parse(await readFile(storePath, "utf8")) as {
      conversations: AssistantConversationRecord[];
      turns: AssistantTurnRecord[];
    };
    expect(persisted.turns[0]).toMatchObject({ status: "succeeded" });
    expect(persisted.conversations[0]).toMatchObject({
      claudeSessionId: nextSession,
    });
  });

  it("keeps the last saved session when a failed turn has no new session id", async () => {
    const root = await mkdtemp(join(tmpdir(), "assistant-store-failed-"));
    temporaryDirectories.push(root);
    const store = new AssistantStore(join(root, "assistant.json"));
    await store.initialize();
    await store.putProfile(profile());
    await store.putConversation(conversation());
    await store.appendTurn(turn());

    await store.completeTurn(
      {
        ...turn(),
        status: "failed",
        error: "工具执行失败",
        finishedAt: 10,
      },
      undefined,
      10,
    );

    expect(store.getConversation("assistant-one")?.claudeSessionId).toBe(
      "550e8400-e29b-41d4-a716-446655440000",
    );
  });

  it("imports only legacy WeCom entries once and leaves legacy tasks untouched", async () => {
    const root = await mkdtemp(join(tmpdir(), "assistant-store-import-"));
    temporaryDirectories.push(root);
    const storePath = join(root, "assistant.json");
    const legacyPath = join(root, "automation.json");
    await writeFile(
      legacyPath,
      JSON.stringify({
        version: 4,
        jobs: [{ id: "legacy-job", prompt: "不得迁移" }],
        runs: [{ id: "legacy-run", status: "succeeded" }],
        wecomBots: [
          {
            id: "legacy-bot",
            name: "旧助理入口",
            enabled: true,
            botId: "legacy-aibot",
            encryptedSecret: "encrypted-secret",
            createdAt: 1,
            updatedAt: 2,
          },
        ],
      }),
      "utf8",
    );

    const store = new AssistantStore(storePath, legacyPath);
    await store.initialize();

    expect(store.listStoredWeComBots()).toEqual([
      expect.objectContaining({
        id: "legacy-bot",
        botId: "legacy-aibot",
        encryptedSecret: "encrypted-secret",
      }),
    ]);
    const persisted = await readFile(storePath, "utf8");
    expect(persisted).toContain('"legacyWeComBotsImported": true');
    expect(persisted).not.toContain("legacy-job");
    expect(await readFile(legacyPath, "utf8")).toContain("legacy-job");
  });

  it("rejects persisted non-owner conversations as corrupt data", async () => {
    const root = await mkdtemp(join(tmpdir(), "assistant-store-owner-only-"));
    temporaryDirectories.push(root);
    const storePath = join(root, "assistant.json");
    await writeFile(
      storePath,
      JSON.stringify({
        version: 1,
        profiles: [profile()],
        conversations: [
          {
            ...conversation(),
            id: "direct-user",
            kind: "direct",
            externalId: "someone-else",
          },
        ],
        turns: [],
      }),
      "utf8",
    );

    const store = new AssistantStore(storePath);
    await store.initialize();

    expect(store.listProfiles()).toEqual([]);
    expect((await readdir(root)).some((name) => name.includes(".corrupt-"))).toBe(
      true,
    );
  });
});
