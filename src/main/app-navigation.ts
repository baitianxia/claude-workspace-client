import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** Absolute path of the packaged renderer page. */
export function appIndexPath(baseDirectory: string = __dirname): string {
  return join(baseDirectory, "../../renderer/index.html");
}

function withoutHashAndQuery(value: string): string | null {
  try {
    const url = new URL(value);
    url.hash = "";
    url.search = "";
    return url.href;
  } catch {
    return null;
  }
}

/**
 * Whether `url` is the app's own renderer page: the development server
 * (same origin) during development, otherwise exactly the packaged
 * index.html. Hash and query are ignored so in-page routing keeps working.
 */
export function isAppPageUrl(
  url: string,
  developmentUrl: string | undefined,
  indexPath: string = appIndexPath(),
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (developmentUrl) {
    try {
      return new URL(url).origin === new URL(developmentUrl).origin;
    } catch {
      return false;
    }
  }
  const normalize = (value: string | null) =>
    value === null ? null : platform === "win32" ? value.toLowerCase() : value;
  const target = normalize(withoutHashAndQuery(url));
  return (
    target !== null &&
    target === normalize(withoutHashAndQuery(pathToFileURL(indexPath).href))
  );
}
