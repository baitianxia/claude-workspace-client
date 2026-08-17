import { describe, expect, it, vi } from "vitest";
import {
  consumeTerminalShortcut,
  terminalShortcutAction,
  type TerminalShortcutEvent,
} from "../src/shared/terminal-shortcuts";

function keyboardEvent(
  key: string,
  overrides: Partial<TerminalShortcutEvent> = {},
): TerminalShortcutEvent {
  return {
    type: "keydown",
    key,
    ctrlKey: true,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    preventDefault: () => undefined,
    ...overrides,
  };
}

describe("terminalShortcutAction", () => {
  it("copies selected text with Ctrl+C or Ctrl+Shift+C", () => {
    expect(terminalShortcutAction(keyboardEvent("c"), true)).toBe("copy");
    expect(
      terminalShortcutAction(keyboardEvent("C", { shiftKey: true }), true),
    ).toBe("copy");
  });

  it("keeps Ctrl+C as interrupt when there is no selection", () => {
    expect(terminalShortcutAction(keyboardEvent("c"), false)).toBeNull();
    expect(
      terminalShortcutAction(keyboardEvent("c", { shiftKey: true }), false),
    ).toBe("suppress");
  });

  it("pastes with Ctrl+V, Ctrl+Shift+V or Command+V", () => {
    expect(terminalShortcutAction(keyboardEvent("v"), false)).toBe("paste");
    expect(
      terminalShortcutAction(keyboardEvent("V", { shiftKey: true }), false),
    ).toBe("paste");
    expect(
      terminalShortcutAction(
        keyboardEvent("v", { ctrlKey: false, metaKey: true }),
        false,
      ),
    ).toBe("paste");
  });

  it("does not treat AltGr or unrelated keys as clipboard shortcuts", () => {
    expect(
      terminalShortcutAction(keyboardEvent("v", { altKey: true }), false),
    ).toBeNull();
    expect(terminalShortcutAction(keyboardEvent("x"), true)).toBeNull();
  });

  it("prevents the native clipboard path during consecutive copy-paste cycles", () => {
    const preventDefault = vi.fn();
    const actions = [
      consumeTerminalShortcut(
        keyboardEvent("c", { preventDefault }),
        true,
      ),
      consumeTerminalShortcut(
        keyboardEvent("v", { preventDefault }),
        false,
      ),
      consumeTerminalShortcut(
        keyboardEvent("c", { preventDefault }),
        true,
      ),
      consumeTerminalShortcut(
        keyboardEvent("v", { preventDefault }),
        false,
      ),
    ];

    expect(actions).toEqual(["copy", "paste", "copy", "paste"]);
    expect(preventDefault).toHaveBeenCalledTimes(4);
  });
});
