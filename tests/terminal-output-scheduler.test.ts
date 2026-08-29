import { describe, expect, it, vi } from "vitest";
import {
  TerminalOutputScheduler,
  type TerminalOutputTarget,
} from "../src/renderer/terminal-output-scheduler";

const BEGIN = "\u001b[?2026h";
const END = "\u001b[?2026l";

function controlledTarget() {
  const writes: string[] = [];
  const completions: Array<() => void> = [];
  const target: TerminalOutputTarget = {
    write(data, callback) {
      writes.push(data);
      completions.push(callback);
    },
  };
  return { completions, target, writes };
}

describe("TerminalOutputScheduler", () => {
  it("forwards ordinary output without a frame delay", () => {
    const { completions, target, writes } = controlledTarget();
    const scheduleFrame = vi.fn();
    const scheduler = new TerminalOutputScheduler(
      target,
      scheduleFrame,
      () => true,
    );

    scheduler.write("first");
    scheduler.write(" second");
    expect(writes).toEqual(["first"]);

    completions.shift()?.();
    expect(writes).toEqual(["first", " second"]);
    expect(scheduleFrame).not.toHaveBeenCalled();
  });

  it("paints a completed synchronized frame before starting the next one", () => {
    const { completions, target, writes } = controlledTarget();
    const frames: Array<() => void> = [];
    const scheduler = new TerminalOutputScheduler(
      target,
      (callback) => frames.push(callback),
      () => true,
    );

    scheduler.write(`${BEGIN}one${END}${BEGIN}two${END}`);
    expect(writes).toEqual([`${BEGIN}one${END}`]);

    completions.shift()?.();
    expect(writes).toHaveLength(1);
    expect(frames).toHaveLength(1);

    frames.shift()?.();
    expect(writes).toEqual([
      `${BEGIN}one${END}`,
      `${BEGIN}two${END}`,
    ]);
  });

  it("recognizes a close sequence split across PTY chunks", () => {
    const { completions, target, writes } = controlledTarget();
    const frames: Array<() => void> = [];
    const scheduler = new TerminalOutputScheduler(
      target,
      (callback) => frames.push(callback),
      () => true,
    );

    scheduler.write(`${BEGIN}frame\u001b[?20`);
    expect(writes).toEqual([`${BEGIN}frame`]);
    completions.shift()?.();

    scheduler.write(`26l${BEGIN}next`);
    expect(writes).toEqual([`${BEGIN}frame`, END]);
    completions.shift()?.();
    expect(frames).toHaveLength(1);

    frames.shift()?.();
    expect(writes).toEqual([`${BEGIN}frame`, END, `${BEGIN}next`]);
  });

  it("does not throttle synchronized output for a hidden terminal", () => {
    const { completions, target, writes } = controlledTarget();
    const scheduleFrame = vi.fn();
    const scheduler = new TerminalOutputScheduler(
      target,
      scheduleFrame,
      () => false,
    );
    const output = `${BEGIN}one${END}${BEGIN}two${END}`;

    scheduler.write(output);
    expect(writes).toEqual([output]);
    completions.shift()?.();
    expect(scheduleFrame).not.toHaveBeenCalled();
  });

  it("drops queued output after disposal", () => {
    const { completions, target, writes } = controlledTarget();
    const scheduler = new TerminalOutputScheduler(
      target,
      () => undefined,
      () => true,
    );

    scheduler.write("first");
    scheduler.write(" second");
    scheduler.dispose();
    completions.shift()?.();
    scheduler.write(" third");

    expect(writes).toEqual(["first"]);
  });
});
