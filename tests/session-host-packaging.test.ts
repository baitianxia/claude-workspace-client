import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("Session Host packaging", () => {
  it("bundles the Host runtime outside app.asar for every Windows artifact", async () => {
    const packageConfiguration = JSON.parse(
      await readFile(join(process.cwd(), "package.json"), "utf8"),
    ) as {
      scripts: Record<string, string>;
      build: {
        extraResources?: Array<{ from?: string; to?: string }>;
        nsis?: { include?: string };
      };
    };

    expect(packageConfiguration.build.extraResources).toContainEqual({
      from: "build/session-host-runtime",
      to: "session-host",
    });
    for (const script of ["pack:win", "dist:win:zip", "dist:win"]) {
      expect(packageConfiguration.scripts[script]).toContain(
        "prepare:session-host-runtime",
      );
    }
    expect(packageConfiguration.build.nsis?.include).toBe(
      "build/installer.nsh",
    );
  });

  it("makes the installer wait for the user's close decision", async () => {
    const installerInclude = await readFile(
      join(process.cwd(), "build", "installer.nsh"),
      "utf8",
    );

    expect(installerInclude).toContain("customCheckAppRunning");
    expect(installerInclude).toContain("仅退出客户端让会话继续运行");
    expect(installerInclude).toContain("IDRETRY session_host_retry");
    expect(installerInclude).not.toContain("KILL_PROCESS");
  });
});
