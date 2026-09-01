import type { UpdateWeComConfigRequest, WeComState } from "../shared/contracts";
import type { ProjectStore, StoredWeComSettings } from "./project-store";
import type { WeComRuntimeConfiguration } from "./wecom-bridge";

export interface SecretProtector {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

export interface WeComConfigurator {
  configure(configuration: WeComRuntimeConfiguration): WeComState;
}

function requireConfigText(
  value: unknown,
  label: string,
  maxLength: number,
  required: boolean,
): string {
  if (typeof value !== "string") {
    throw new Error(`${label} 必须是字符串。`);
  }
  const normalized = value.trim();
  if (
    (required && !normalized) ||
    [...normalized].length > maxLength ||
    /\p{Cc}/u.test(normalized)
  ) {
    throw new Error(`${label} 格式无效。`);
  }
  return normalized;
}

export class WeComSettingsService {
  constructor(
    private readonly projectStore: ProjectStore,
    private readonly bridge: WeComConfigurator,
    private readonly secretProtector: SecretProtector,
    private readonly isBotIdReserved: (botId: string) => boolean = () => false,
    private readonly onConfigurationChanged: () => void = () => undefined,
  ) {}

  initialize(): WeComState {
    const stored = this.projectStore.getWeComSettings();
    const state = this.bridge.configure(this.runtimeConfiguration(stored));
    this.onConfigurationChanged();
    return state;
  }

  async update(request: UpdateWeComConfigRequest): Promise<WeComState> {
    if (!request || typeof request !== "object") {
      throw new Error("企业微信配置请求无效。");
    }
    if (typeof request.enabled !== "boolean") {
      throw new Error("企业微信启用状态无效。");
    }

    const botId = requireConfigText(
      request.botId,
      "Bot ID",
      200,
      request.enabled,
    );
    const targetUserId = requireConfigText(
      request.targetUserId,
      "接收用户 userid",
      200,
      request.enabled,
    );
    if (botId && this.isBotIdReserved(botId)) {
      throw new Error(
        "这个 Bot ID 已用于企业微信业务入口，不能同时作为 Claude Code 管理机器人。",
      );
    }
    const submittedSecret =
      request.secret === undefined
        ? ""
        : requireConfigText(request.secret, "Secret", 1_000, false);
    const existing = this.projectStore.getWeComSettings();
    let encryptedSecret = existing?.encryptedSecret ?? "";

    if (existing && existing.botId !== botId && !submittedSecret) {
      // A Secret belongs to one bot and must never be silently reused for a
      // different Bot ID.
      encryptedSecret = "";
    }

    if (submittedSecret) {
      if (!this.secretProtector.isEncryptionAvailable()) {
        throw new Error(
          "当前系统安全存储不可用，不能安全保存企业微信 Secret。",
        );
      }
      encryptedSecret = this.secretProtector
        .encryptString(submittedSecret)
        .toString("base64");
    }
    if (request.enabled && !encryptedSecret) {
      throw new Error("启用企业微信远程回复前必须填写 Secret。");
    }

    const stored: StoredWeComSettings = {
      enabled: request.enabled,
      botId,
      targetUserId,
      encryptedSecret,
    };
    await this.projectStore.setWeComSettings(stored);
    const state = this.bridge.configure(this.runtimeConfiguration(stored));
    this.onConfigurationChanged();
    return state;
  }

  private runtimeConfiguration(
    stored: StoredWeComSettings | undefined,
  ): WeComRuntimeConfiguration {
    if (!stored) {
      return {
        enabled: false,
        botId: "",
        targetUserId: "",
        hasSecret: false,
      };
    }

    const base = {
      enabled: stored.enabled,
      botId: stored.botId,
      targetUserId: stored.targetUserId,
      hasSecret: Boolean(stored.encryptedSecret),
    };
    if (!stored.enabled) {
      return base;
    }
    if (!stored.encryptedSecret) {
      return {
        ...base,
        configurationError: "企业微信 Secret 尚未配置。",
      };
    }
    if (!this.secretProtector.isEncryptionAvailable()) {
      return {
        ...base,
        configurationError:
          "当前系统安全存储不可用，无法读取企业微信 Secret。",
      };
    }
    try {
      return {
        ...base,
        secret: this.secretProtector.decryptString(
          Buffer.from(stored.encryptedSecret, "base64"),
        ),
      };
    } catch {
      return {
        ...base,
        configurationError:
          "企业微信 Secret 无法解密，请在设置中重新填写。",
      };
    }
  }
}
