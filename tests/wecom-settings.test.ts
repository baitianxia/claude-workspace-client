import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectStore } from "../src/main/project-store";
import type { WeComRuntimeConfiguration } from "../src/main/wecom-bridge";
import {
  WeComSettingsService,
  type SecretProtector,
  type WeComConfigurator,
} from "../src/main/wecom-settings";
import type { WeComState } from "../src/shared/contracts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

function fakeState(configuration: WeComRuntimeConfiguration): WeComState {
  const configured = Boolean(
    configuration.botId &&
      configuration.targetUserId &&
      configuration.hasSecret,
  );
  return {
    enabled: configuration.enabled,
    configured,
    hasSecret: configuration.hasSecret,
    botId: configuration.botId,
    targetUserId: configuration.targetUserId,
    status: configuration.enabled && configured ? "connecting" : "disabled",
  };
}

function fakeConfigurator() {
  const configurations: WeComRuntimeConfiguration[] = [];
  const configurator: WeComConfigurator = {
    configure: (configuration) => {
      configurations.push({ ...configuration });
      return fakeState(configuration);
    },
  };
  return { configurator, configurations };
}

const protector: SecretProtector = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(`protected:${value}`, "utf8"),
  decryptString: (value) =>
    value.toString("utf8").replace(/^protected:/u, ""),
};

describe("WeComSettingsService", () => {
  it("persists only an encrypted Secret and restores it for the runtime", async () => {
    const root = await mkdtemp(join(tmpdir(), "claude-workspace-wecom-"));
    temporaryDirectories.push(root);
    const storePath = join(root, "workspace.json");
    const store = new ProjectStore(storePath);
    await store.initialize();
    const first = fakeConfigurator();
    const service = new WeComSettingsService(
      store,
      first.configurator,
      protector,
    );

    const state = await service.update({
      enabled: true,
      botId: "bot-id",
      targetUserId: "zhangsan",
      secret: "plain-secret",
    });

    expect(state).toMatchObject({
      enabled: true,
      configured: true,
      hasSecret: true,
      botId: "bot-id",
      targetUserId: "zhangsan",
    });
    const storedJson = await readFile(storePath, "utf8");
    expect(storedJson).not.toContain("plain-secret");
    expect(storedJson).toContain(
      Buffer.from("protected:plain-secret").toString("base64"),
    );

    const reloaded = new ProjectStore(storePath);
    await reloaded.initialize();
    const second = fakeConfigurator();
    new WeComSettingsService(
      reloaded,
      second.configurator,
      protector,
    ).initialize();
    expect(second.configurations).toEqual([
      expect.objectContaining({
        enabled: true,
        botId: "bot-id",
        targetUserId: "zhangsan",
        secret: "plain-secret",
        hasSecret: true,
      }),
    ]);
  });

  it("keeps the encrypted Secret when other settings are updated", async () => {
    const root = await mkdtemp(join(tmpdir(), "claude-workspace-wecom-"));
    temporaryDirectories.push(root);
    const store = new ProjectStore(join(root, "workspace.json"));
    await store.initialize();
    const fake = fakeConfigurator();
    const service = new WeComSettingsService(
      store,
      fake.configurator,
      protector,
    );
    await service.update({
      enabled: true,
      botId: "bot-id",
      targetUserId: "zhangsan",
      secret: "secret",
    });

    await store.setClaudeExecutable("C:\\Tools\\claude.exe");
    await service.update({
      enabled: false,
      botId: "bot-id",
      targetUserId: "lisi",
    });

    expect(store.getClaudeExecutable()).toBe("C:\\Tools\\claude.exe");
    expect(store.getWeComSettings()).toMatchObject({
      enabled: false,
      targetUserId: "lisi",
      encryptedSecret: Buffer.from("protected:secret").toString("base64"),
    });
  });

  it("does not reuse a saved Secret after the Bot ID changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "claude-workspace-wecom-"));
    temporaryDirectories.push(root);
    const store = new ProjectStore(join(root, "workspace.json"));
    await store.initialize();
    const fake = fakeConfigurator();
    const service = new WeComSettingsService(
      store,
      fake.configurator,
      protector,
    );
    await service.update({
      enabled: true,
      botId: "first-bot",
      targetUserId: "zhangsan",
      secret: "first-secret",
    });

    await expect(
      service.update({
        enabled: true,
        botId: "second-bot",
        targetUserId: "zhangsan",
      }),
    ).rejects.toThrow("必须填写 Secret");
    expect(store.getWeComSettings()).toMatchObject({
      botId: "first-bot",
      encryptedSecret: Buffer.from("protected:first-secret").toString("base64"),
    });
  });

  it("refuses to save a new Secret without operating-system encryption", async () => {
    const root = await mkdtemp(join(tmpdir(), "claude-workspace-wecom-"));
    temporaryDirectories.push(root);
    const store = new ProjectStore(join(root, "workspace.json"));
    await store.initialize();
    const fake = fakeConfigurator();
    const unavailable: SecretProtector = {
      isEncryptionAvailable: () => false,
      encryptString: vi.fn(() => Buffer.alloc(0)),
      decryptString: vi.fn(() => ""),
    };
    const service = new WeComSettingsService(
      store,
      fake.configurator,
      unavailable,
    );

    await expect(
      service.update({
        enabled: true,
        botId: "bot-id",
        targetUserId: "zhangsan",
        secret: "must-not-persist",
      }),
    ).rejects.toThrow("系统安全存储不可用");
    expect(store.getWeComSettings()).toBeUndefined();
  });

  it("keeps the Claude Code management Bot ID separate from automation bots", async () => {
    const root = await mkdtemp(join(tmpdir(), "claude-workspace-wecom-"));
    temporaryDirectories.push(root);
    const store = new ProjectStore(join(root, "workspace.json"));
    await store.initialize();
    const fake = fakeConfigurator();
    const service = new WeComSettingsService(
      store,
      fake.configurator,
      protector,
      (botId) => botId === "automation-bot",
    );

    await expect(
      service.update({
        enabled: true,
        botId: "automation-bot",
        targetUserId: "zhangsan",
        secret: "secret",
      }),
    ).rejects.toThrow("企业微信智能机器人");
    expect(store.getWeComSettings()).toBeUndefined();
  });
});
