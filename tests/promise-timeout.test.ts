import { describe, expect, it } from "vitest";
import { withTimeout } from "../src/main/promise-timeout";

describe("withTimeout", () => {
  it("returns a completed operation", async () => {
    await expect(withTimeout(Promise.resolve("ok"), 100, "late")).resolves.toBe(
      "ok",
    );
  });

  it("turns a hung operation into an explicit timeout error", async () => {
    await expect(
      withTimeout(new Promise<never>(() => undefined), 1, "delivery timed out"),
    ).rejects.toThrow("delivery timed out");
  });
});
