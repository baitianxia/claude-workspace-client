import { describe, expect, it } from "vitest";
import {
  sendAssistantWeComMessage,
  type AssistantWeComToolGateway,
} from "../src/main/assistant-wecom-tools";
import type { AssistantProfileRecord } from "../src/shared/contracts";

const profile: AssistantProfileRecord = {
  id: "assistant-one",
  name: "小岚",
  enabled: true,
  projectPath: "/tmp/assistant",
  instructions: "",
  ownerWeComUserId: "zhangsan",
  wecomBotProfileId: "bot-one",
  timeoutMinutes: 20,
  maxTurns: 20,
  createdAt: 1,
  updatedAt: 1,
};

class FakeGateway implements AssistantWeComToolGateway {
  readonly sent: Array<{
    botProfileId: string;
    targetId: string;
    content: string;
  }> = [];

  async sendMarkdown(
    botProfileId: string,
    targetId: string,
    content: string,
  ): Promise<void> {
    this.sent.push({ botProfileId, targetId, content });
  }
}

describe("assistant WeCom tools", () => {
  it("uses the assistant's bound bot for both user and group targets", async () => {
    const gateway = new FakeGateway();
    const result = await sendAssistantWeComMessage(
      profile.id,
      () => profile,
      gateway,
      "wrhR_group-chat-id",
      "质量分通报",
    );

    expect(result).toContain("wrhR_group-chat-id");
    expect(gateway.sent).toEqual([
      {
        botProfileId: "bot-one",
        targetId: "wrhR_group-chat-id",
        content: "质量分通报",
      },
    ]);
  });

  it("refuses to fall back to another sender when no bot is bound", async () => {
    const gateway = new FakeGateway();
    await expect(
      sendAssistantWeComMessage(
        profile.id,
        () => ({ ...profile, wecomBotProfileId: undefined }),
        gateway,
        "zhangsan",
        "消息",
      ),
    ).rejects.toThrow("没有绑定企业微信智能机器人");
    expect(gateway.sent).toHaveLength(0);
  });
});
