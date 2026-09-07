import { describe, expect, it, vi } from "vitest";
import { terminateProcessTree } from "../src/main/process-tree";

describe("terminateProcessTree", () => {
  it("uses taskkill with descendant and force flags on Windows", async () => {
    const runTaskkill = vi.fn(async () => undefined);

    await terminateProcessTree(321, { platform: "win32", runTaskkill });

    expect(runTaskkill).toHaveBeenCalledExactlyOnceWith([
      "/PID",
      "321",
      "/T",
      "/F",
    ]);
  });

  it("does not invoke taskkill on other platforms or invalid PIDs", async () => {
    const runTaskkill = vi.fn(async () => undefined);

    await terminateProcessTree(321, { platform: "darwin", runTaskkill });
    await terminateProcessTree(0, { platform: "win32", runTaskkill });

    expect(runTaskkill).not.toHaveBeenCalled();
  });
});
