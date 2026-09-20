/** The SDK rejects nonzero acknowledgements with a frame, not an Error. */
export function describeWeComError(error: unknown): string {
  let description: string;
  if (error instanceof Error) {
    description = error.message;
  } else if (error && typeof error === "object") {
    const frame = error as { errcode?: unknown; errmsg?: unknown; message?: unknown };
    const code = typeof frame.errcode === "number" ? frame.errcode : undefined;
    const message =
      typeof frame.errmsg === "string"
        ? frame.errmsg
        : typeof frame.message === "string"
          ? frame.message
          : "";
    // Never stringify an entire SDK frame: it may contain message bodies or
    // authentication data unrelated to this diagnostic.
    description = code === undefined
      ? message || "未知企业微信错误"
      : `错误码 ${code}${message ? `：${message}` : ""}`;
  } else {
    description = String(error);
  }
  return description.replace(/\p{Cc}/gu, " ").slice(0, 2_000);
}
