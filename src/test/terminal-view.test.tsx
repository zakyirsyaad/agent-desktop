import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";
import { createPtyOutputStore } from "../lib/pty-output-store";

const { FakeTerminal, terminals } = vi.hoisted(() => {
  const terminals: InstanceType<typeof FakeTerminal>[] = [];
  class FakeTerminal {
    written: string[] = [];
    dataListener: ((data: string) => void) | null = null;
    disposed = false;
    focused = false;
    cols = 100;
    rows = 30;
    constructor() {
      terminals.push(this);
    }
    loadAddon() {}
    open() {}
    focus() {
      this.focused = true;
    }
    write(data: string) {
      this.written.push(data);
    }
    onData(listener: (data: string) => void) {
      this.dataListener = listener;
      return { dispose: () => (this.dataListener = null) };
    }
    dispose() {
      this.disposed = true;
    }
  }
  return { FakeTerminal, terminals };
});

vi.mock("@xterm/xterm", () => ({ Terminal: FakeTerminal }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

import { TerminalView } from "../components/TerminalView";

describe("TerminalView", () => {
  beforeEach(() => {
    terminals.length = 0;
  });

  it("replays what the agent drew before, then follows new output", () => {
    const output = createPtyOutputStore();
    output.append("s-1", "\x1b[2Jwelcome");
    render(<TerminalView sessionId="s-1" output={output} isLive onInput={() => {}} onResize={() => {}} />);

    act(() => output.append("s-1", " > "));

    expect(terminals[0].written).toEqual(["\x1b[2Jwelcome", " > "]);
    expect(terminals[0].focused).toBe(true);
  });

  it("sends keystrokes and its size to a live session", () => {
    const output = createPtyOutputStore();
    const onInput = vi.fn();
    const onResize = vi.fn();
    render(<TerminalView sessionId="s-1" output={output} isLive onInput={onInput} onResize={onResize} />);

    terminals[0].dataListener?.("y\r");

    expect(onInput).toHaveBeenCalledWith("y\r");
    expect(onResize).toHaveBeenCalledWith(100, 30);
  });

  it("is read-only for an ended session", () => {
    const output = createPtyOutputStore();
    output.append("s-1", "bye");
    const onInput = vi.fn();
    render(<TerminalView sessionId="s-1" output={output} isLive={false} onInput={onInput} onResize={() => {}} />);

    expect(terminals[0].written).toEqual(["bye"]);
    expect(terminals[0].dataListener).toBeNull();
  });

  it("switches to another session's output and drops the old terminal", () => {
    const output = createPtyOutputStore();
    output.append("s-1", "one");
    output.append("s-2", "two");
    const { rerender } = render(
      <TerminalView sessionId="s-1" output={output} isLive onInput={() => {}} onResize={() => {}} />
    );

    rerender(<TerminalView sessionId="s-2" output={output} isLive onInput={() => {}} onResize={() => {}} />);
    act(() => output.append("s-1", "late"));

    expect(terminals[0].disposed).toBe(true);
    expect(terminals[1].written).toEqual(["two"]);
  });
});
