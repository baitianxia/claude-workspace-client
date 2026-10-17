import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { isAppPageUrl } from "../src/main/app-navigation";

const indexPath = join("/opt", "Claude Workspace", "resources", "renderer", "index.html");
const indexUrl = pathToFileURL(indexPath).href;

describe("isAppPageUrl", () => {
  it("allows the packaged page, ignoring hash and query", () => {
    expect(isAppPageUrl(indexUrl, undefined, indexPath, "linux")).toBe(true);
    expect(isAppPageUrl(`${indexUrl}#/settings`, undefined, indexPath, "linux")).toBe(true);
    expect(isAppPageUrl(`${indexUrl}?preview`, undefined, indexPath, "linux")).toBe(true);
  });

  it("rejects other local files such as a dropped document", () => {
    expect(
      isAppPageUrl(pathToFileURL("/home/me/report.pdf").href, undefined, indexPath, "linux"),
    ).toBe(false);
    expect(
      isAppPageUrl(
        pathToFileURL(join("/opt", "Claude Workspace", "resources", "renderer", "other.html")).href,
        undefined,
        indexPath,
        "linux",
      ),
    ).toBe(false);
    expect(isAppPageUrl("https://example.com/", undefined, indexPath, "linux")).toBe(false);
    expect(isAppPageUrl("not a url", undefined, indexPath, "linux")).toBe(false);
  });

  it("compares case-insensitively on Windows", () => {
    expect(isAppPageUrl(indexUrl.toUpperCase().replace("FILE:", "file:"), undefined, indexPath, "win32")).toBe(true);
    expect(isAppPageUrl(indexUrl.toUpperCase().replace("FILE:", "file:"), undefined, indexPath, "linux")).toBe(false);
  });

  it("allows only the development server origin during development", () => {
    const dev = "http://localhost:5173/";
    expect(isAppPageUrl("http://localhost:5173/?preview#x", dev, indexPath, "linux")).toBe(true);
    expect(isAppPageUrl(indexUrl, dev, indexPath, "linux")).toBe(false);
    expect(isAppPageUrl("http://localhost:5174/", dev, indexPath, "linux")).toBe(false);
  });
});
