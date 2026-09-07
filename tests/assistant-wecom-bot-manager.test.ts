import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  BaseMessage,
  SendMsgBody,
  WsFrame,
  WsFrameHeaders,
} from "@wecom/aibot-node-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { AssistantStore } from "../src/main/assistant-store";
import { AssistantWeComBotManager } from "../src/main/assistant-wecom-bot-manager";
import type { SecretProtector } from "../src/main/wecom-settings";
import type { WeComClient } from "../src/main/wecom-bridge";

const temporaryDirectories: string[] = [];

class FakeClient extends EventEmitter implements WeComClient {
  connected = false;
  disconnected = false;
  failReplies = false;
  failSends = false;
  readonly sent: Array<{ targetId: string; body: SendMsgBody }> = [];
  readonly replies: string[] = [];

  connect(): this {
    this.connected = true;
    return this;
  }

  disconnect(): void {
    this.disconnected = true;
  }

  async sendMessage(targetId: string, body: SendMsgBody): Promise<unknown> {
    if (this.failSends) {
      throw new Error("send failed");
    }
    this.sent.push({ targetId, body });
    return {};
  }

  async replyStream(
    _frame: WsFrameHeaders,
    _streamId: string,
    content: string,
  ): Promise<unknown> {
    if (this.failReplies) {
      throw new Error("reply failed");
    }
    this.replies.push(content);
    return {};
  }
}

const protector: SecretProtector = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(`protected:${value}`, "utf8"),
  decryptString: (value) =>
    value.toString("utf8").replace(/^protected:/u, ""),
};

function groupMessage(messageId: string): WsFrame<BaseMessage> {
  return {
    headers: { req_id: `request-${messageId}` },
    body: {
      msgid: messageId,
      aibotid: "automation-bot",
      chattype: "group",
      chatid: "group-one",
      from: { userid: "zhangsan" },
      msgtype: "text",
      text: { content: "分析这条消息" },
    },
  } as WsFrame<BaseMessage>;
}

function singleMessage(messageId: string): WsFrame<BaseMessage> {
  return {
    headers: { req_id: `request-${messageId}` },
    body: {
      msgid: messageId,
      aibotid: "automation-bot",
      chattype: "single",
      from: { userid: "zhangsan" },
      msgtype: "text",
      text: { content: "继续桌面上的对话" },
    },
  } as WsFrame<BaseMessage>;
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("Timed out waiting for assistant bot state.");
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("AssistantWeComBotManager", () => {
  it("keeps multiple enabled bots online and routes with the selected identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "assistant-wecom-bots-"));
    temporaryDirectories.push(root);
    const storePath = join(root, "assistant.json");
    const store = new AssistantStore(storePath);
    await store.initialize();
    const clients = new Map<string, FakeClient>();
    const manager = new AssistantWeComBotManager(
      store,
      protector,
      () => "claude-management-bot",
      ({ botId }) => {
        const client = new FakeClient();
        clients.set(botId, client);
        return client;
      },
    );
    await manager.initialize();

    const news = await manager.upsertBot({
      name: "资讯机器人",
      enabled: true,
      botId: "news-bot",
      secret: "news-secret",
    });
    const operations = await manager.upsertBot({
      name: "运营机器人",
      enabled: true,
      botId: "operations-bot",
      secret: "operations-secret",
    });

    expect(clients.get("news-bot")?.connected).toBe(true);
    expect(clients.get("operations-bot")?.connected).toBe(true);
    clients.get("news-bot")?.emit("authenticated");
    clients.get("operations-bot")?.emit("authenticated");
    expect(manager.listBots()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: news.id, status: "connected" }),
        expect.objectContaining({ id: operations.id, status: "connected" }),
      ]),
    );

    await manager.sendMarkdown(news.id, "group-one", "# 今日资讯");
    expect(clients.get("news-bot")?.sent).toHaveLength(1);
    expect(clients.get("operations-bot")?.sent).toHaveLength(0);

    const inbound: Array<{ botProfileId: string; chatType: string; chatId: string }> = [];
    manager.setMessageHandler(async (message) => {
      inbound.push({
        botProfileId: message.botProfileId,
        chatType: message.chatType,
        chatId: message.chatId,
      });
      return message.messageId === "message-ignored"
        ? {
            status: "rejected",
            message: "这条消息不是主人消息，已静默忽略。",
            silent: true,
          }
        : { status: "accepted", message: "已登记" };
    });
    clients.get("operations-bot")?.emit("message", groupMessage("message-one"));
    await waitFor(() => inbound.length === 1);
    clients.get("operations-bot")?.emit("message", singleMessage("message-two"));
    await waitFor(() => inbound.length === 2);
    expect(inbound).toEqual([
      { botProfileId: operations.id, chatType: "group", chatId: "group-one" },
      { botProfileId: operations.id, chatType: "single", chatId: "zhangsan" },
    ]);
    expect(clients.get("operations-bot")?.replies).toContain("已登记");

    const replyCount = clients.get("operations-bot")?.replies.length;
    clients
      .get("operations-bot")
      ?.emit("message", singleMessage("message-ignored"));
    await waitFor(() => inbound.length === 3);
    expect(clients.get("operations-bot")?.replies).toHaveLength(replyCount ?? 0);
    expect(manager.listBots().find((bot) => bot.id === operations.id)).toMatchObject({
      lastInboundStatus: "ignored",
    });

    const storedJson = await readFile(storePath, "utf8");
    expect(storedJson).not.toContain("news-secret");
    expect(storedJson).not.toContain("operations-secret");
    await expect(
      manager.upsertBot({
        id: news.id,
        name: news.name,
        enabled: true,
        botId: "replacement-bot",
      }),
    ).rejects.toThrow("Bot ID 不能修改");
    manager.dispose();
  });

  it("rejects a Bot ID reserved for Claude Code management", async () => {
    const root = await mkdtemp(join(tmpdir(), "assistant-wecom-bots-"));
    temporaryDirectories.push(root);
    const store = new AssistantStore(join(root, "assistant.json"));
    await store.initialize();
    const manager = new AssistantWeComBotManager(
      store,
      protector,
      () => "claude-management-bot",
      () => new FakeClient(),
    );
    await manager.initialize();

    await expect(
      manager.upsertBot({
        name: "冲突机器人",
        enabled: true,
        botId: "claude-management-bot",
        secret: "secret",
      }),
    ).rejects.toThrow("Claude Code 终端控制机器人");
    manager.dispose();
  });

  it("records silent route diagnostics without replying to unauthorized messages", async () => {
    const root = await mkdtemp(join(tmpdir(), "assistant-wecom-bots-silent-"));
    temporaryDirectories.push(root);
    const store = new AssistantStore(join(root, "assistant.json"));
    await store.initialize();
    const client = new FakeClient();
    const manager = new AssistantWeComBotManager(
      store,
      protector,
      () => "claude-management-bot",
      () => client,
    );
    await manager.initialize();
    const bot = await manager.upsertBot({
      name: "助理",
      enabled: true,
      botId: "assistant-bot",
      secret: "secret",
    });
    client.emit("authenticated");
    manager.setMessageHandler(async () => ({
      status: "rejected",
      message: "发送者不是主人，已静默忽略。",
      silent: true,
    }));
    client.emit("message", singleMessage("silent-message"));
    await waitFor(
      () => manager.listBots().find((entry) => entry.id === bot.id)?.lastInboundStatus === "ignored",
    );
    expect(client.replies).toHaveLength(0);
    expect(manager.listBots().find((entry) => entry.id === bot.id)?.lastInboundDetail).toContain("静默");
    manager.dispose();
  });

  it("accepts SDK typed message events and does not process their generic duplicate twice", async () => {
    const root = await mkdtemp(join(tmpdir(), "assistant-wecom-bots-typed-"));
    temporaryDirectories.push(root);
    const store = new AssistantStore(join(root, "assistant.json"));
    await store.initialize();
    const client = new FakeClient();
    const manager = new AssistantWeComBotManager(
      store,
      protector,
      () => "claude-management-bot",
      () => client,
    );
    await manager.initialize();
    const bot = await manager.upsertBot({
      name: "助理",
      enabled: true,
      botId: "assistant-typed-bot",
      secret: "secret",
    });
    client.emit("authenticated");
    const inbound: string[] = [];
    manager.setMessageHandler(async (message) => {
      inbound.push(message.messageId);
      return { status: "accepted", message: "已收到" };
    });
    const frame = singleMessage("typed-message");
    client.emit("message.text", frame);
    client.emit("message", frame);
    await waitFor(() => inbound.length === 1);
    expect(inbound).toEqual(["typed-message"]);
    expect(client.replies).toEqual(["已收到"]);
    expect(manager.listBots().find((entry) => entry.id === bot.id)).toMatchObject({
      lastInboundStatus: "routed",
    });
    manager.dispose();
  });

  it("leaves a message retryable when the route is temporarily unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "assistant-wecom-bots-retry-"));
    temporaryDirectories.push(root);
    const store = new AssistantStore(join(root, "assistant.json"));
    await store.initialize();
    const client = new FakeClient();
    const manager = new AssistantWeComBotManager(
      store,
      protector,
      () => "claude-management-bot",
      () => client,
    );
    await manager.initialize();
    await manager.upsertBot({
      name: "助理",
      enabled: true,
      botId: "assistant-retry-bot",
      secret: "secret",
    });
    client.emit("authenticated");

    // The first delivery can race service startup. It must not permanently
    // consume the msgid before a later WeCom retry reaches the route.
    const frame = singleMessage("retry-message");
    client.emit("message", frame);
    await waitFor(() =>
      manager.listBots().some((entry) =>
        entry.lastInboundDetail?.includes("本地重试"),
      ),
    );

    const inbound: string[] = [];
    manager.setMessageHandler(async (message) => {
      inbound.push(message.messageId);
      return { status: "accepted", message: "已重新接收" };
    });
    client.emit("message", singleMessage("retry-message"));
    await waitFor(() => inbound.length === 1);
    expect(client.replies).toContain("已重新接收");
    manager.dispose();
  });

  it("retries a temporarily unavailable route locally without a second WeCom delivery", async () => {
    const root = await mkdtemp(join(tmpdir(), "assistant-wecom-bots-local-retry-"));
    temporaryDirectories.push(root);
    const store = new AssistantStore(join(root, "assistant.json"));
    await store.initialize();
    const client = new FakeClient();
    const manager = new AssistantWeComBotManager(
      store,
      protector,
      () => "claude-management-bot",
      () => client,
    );
    await manager.initialize();
    await manager.upsertBot({
      name: "助理",
      enabled: true,
      botId: "assistant-local-retry-bot",
      secret: "secret",
    });
    client.emit("authenticated");

    const inbound: string[] = [];
    client.emit("message", singleMessage("local-retry-message"));
    await waitFor(() =>
      manager.listBots().some((entry) =>
        entry.lastInboundDetail?.includes("本地重试"),
      ),
    );
    manager.setMessageHandler(async (message) => {
      inbound.push(message.messageId);
      return { status: "accepted", message: "本地重试后已接收" };
    });

    await waitFor(() => inbound.length === 1);
    expect(inbound).toEqual(["local-retry-message"]);
    expect(client.replies).toContain("本地重试后已接收");
    manager.dispose();
  });

  it("allows a same-msgid retry when both acknowledgement paths fail", async () => {
    const root = await mkdtemp(join(tmpdir(), "assistant-wecom-bots-ack-retry-"));
    temporaryDirectories.push(root);
    const store = new AssistantStore(join(root, "assistant.json"));
    await store.initialize();
    const client = new FakeClient();
    const manager = new AssistantWeComBotManager(
      store,
      protector,
      () => "claude-management-bot",
      () => client,
    );
    await manager.initialize();
    await manager.upsertBot({
      name: "助理",
      enabled: true,
      botId: "assistant-ack-retry-bot",
      secret: "secret",
    });
    client.emit("authenticated");
    let attempts = 0;
    manager.setMessageHandler(async () => {
      attempts += 1;
      return { status: "accepted", message: `第 ${attempts} 次` };
    });

    client.failReplies = true;
    client.failSends = true;
    client.emit("message", singleMessage("ack-retry-message"));
    await waitFor(() =>
      manager.listBots().some((entry) => entry.lastInboundStatus === "failed"),
    );
    client.failReplies = false;
    client.failSends = false;
    client.emit("message", singleMessage("ack-retry-message"));
    await waitFor(() => client.replies.includes("第 1 次"));
    expect(attempts).toBe(1);
    expect(client.replies).toContain("第 1 次");
    manager.dispose();
  });
});
