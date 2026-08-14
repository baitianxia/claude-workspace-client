export interface TerminalShortcutEvent {
  type: string;
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

export type TerminalShortcutAction = "copy" | "paste" | "suppress" | null;

export function terminalShortcutAction(
  event: TerminalShortcutEvent,
  hasSelection: boolean,
): TerminalShortcutAction {
  const primaryModifier = (event.ctrlKey || event.metaKey) && !event.altKey;
  if (event.type !== "keydown" || !primaryModifier) {
    return null;
  }

  const key = event.key.toLocaleLowerCase("en-US");
  if (key === "c") {
    if (hasSelection) {
      return "copy";
    }
    // Ctrl+C without a selection remains available as the terminal interrupt.
    return event.shiftKey ? "suppress" : null;
  }
  if (key === "v") {
    return "paste";
  }
  return null;
}
