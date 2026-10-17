/**
 * Format file paths dropped onto a terminal the way native terminals do, so
 * Claude Code receives them as one argument each (and recognises dropped
 * images by their path).
 *
 * - Windows: wrap a path in double quotes when it contains whitespace or a
 *   character that cmd/PowerShell treat specially. Windows paths cannot
 *   contain a double quote, so no escaping is needed inside the quotes.
 * - Elsewhere: wrap in single quotes when needed, escaping embedded quotes.
 *
 * Paths are separated by spaces and followed by one trailing space so the
 * user can keep typing.
 */
export function formatDroppedPaths(
  paths: readonly string[],
  windows: boolean,
): string {
  const usable = paths.filter((path) => path.length > 0 && !/[\r\n\0]/u.test(path));
  if (usable.length === 0) {
    return "";
  }
  return `${usable.map((path) => quoteDroppedPath(path, windows)).join(" ")} `;
}

export function quoteDroppedPath(path: string, windows: boolean): string {
  if (windows) {
    return /[\s&()[\]{}^=;!'+,`~%$@#]/u.test(path) ? `"${path}"` : path;
  }
  return /[^\w@%+=:,./-]/u.test(path) ? `'${path.replaceAll("'", `'\\''`)}'` : path;
}
