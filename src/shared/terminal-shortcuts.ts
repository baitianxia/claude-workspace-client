export interface TerminalShortcutEvent {
  type: string;
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  preventDefault(): void;
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
  if (key === "k") {
    // Let the app-level Ctrl+K handler open the workspace switcher instead of
    // allowing xterm to consume the key and send it to Claude Code.
    return "suppress";
  }
  return null;
}

export function consumeTerminalShortcut(
  event: TerminalShortcutEvent,
  hasSelection: boolean,
): TerminalShortcutAction {
  const action = terminalShortcutAction(event, hasSelection);
  if (action !== null) {
    // Cancelling the keyboard default keeps browser and xterm handling from
    // creating a second path for a shortcut owned by the workspace UI.
    event.preventDefault();
  }
  return action;
}
