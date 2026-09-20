import { describe, expect, it } from "vitest";
import { describeWeComError } from "../src/main/wecom-error";

describe("describeWeComError", () => {
  it("preserves service rejection codes without exposing the rest of the frame", () => {
    const detail = describeWeComError({
      errcode: 40003,
      errmsg: "invalid userid",
      body: { secret: "must-not-appear" },
      headers: { req_id: "private-request" },
    });
    expect(detail).toBe("错误码 40003：invalid userid");
  });

  it("handles ordinary errors and unknown objects without serializing payloads", () => {
    expect(describeWeComError(new Error("connection\nlost"))).toBe("connection lost");
    expect(describeWeComError({ secret: "must-not-appear" })).toBe("未知企业微信错误");
  });
});
