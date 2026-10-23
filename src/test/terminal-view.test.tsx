import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRef } from "react";
import { render, act, screen } from "@testing-library/react";
import type { ITerminalOptions } from "@xterm/xterm";
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
    options: ITerminalOptions;
    constructor(options: ITerminalOptions = {}) {
      this.options = options;
      terminals.push(this);
    }
    loadAddon() {}
    open() {}
    focus() {
      this.focused = true;
    }
    pendingWrites: (() => void)[] = [];
    /** Like xterm, parses asynchronously: the callback runs once the data is processed. */
    write(data: string, callback?: () => void) {
      this.written.push(data);
      if (callback) this.pendingWrites.push(callback);
    }
    flushWrites() {
      this.pendingWrites.splice(0).forEach((cb) => cb());
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

import { TerminalView, type TerminalViewHandle } from "../components/TerminalView";

describe("TerminalView", () => {
  beforeEach(() => {
    terminals.length = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
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

    act(() => terminals[0].flushWrites());
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

  it("does not answer terminal queries in the replayed output to the live agent", () => {
    const output = createPtyOutputStore();
    output.append("s-1", "\x1b[6n old cursor query");
    const onInput = vi.fn();
    render(<TerminalView sessionId="s-1" output={output} isLive onInput={onInput} onResize={() => {}} />);

    // While xterm still parses the replay, its answers must go nowhere.
    expect(terminals[0].dataListener).toBeNull();
    act(() => terminals[0].flushWrites());
    expect(terminals[0].dataListener).not.toBeNull();
  });

  it("takes focus on mount by default", () => {
    const focusSpy = vi.spyOn(FakeTerminal.prototype, "focus");
    render(<TerminalView sessionId="s-1" output={createPtyOutputStore()} isLive onInput={() => {}} onResize={() => {}} />);

    expect(focusSpy).toHaveBeenCalledTimes(1);
  });

  it("focuses a mounted terminal through its handle, without rebuilding it", () => {
    const handle = createRef<TerminalViewHandle>();
    render(
      <TerminalView ref={handle} sessionId="s-1" output={createPtyOutputStore()} isLive autoFocus={false} onInput={() => {}} onResize={() => {}} />,
    );
    expect(terminals[0].focused).toBe(false);

    act(() => handle.current?.focus());

    expect(terminals[0].focused).toBe(true);
    expect(terminals).toHaveLength(1);
  });

  it("keeps the terminal's dark fill on its own container", () => {
    render(<TerminalView sessionId="s-1" output={createPtyOutputStore()} isLive onInput={() => {}} onResize={() => {}} />);

    expect(screen.getByTestId("terminal-view").classList.contains("bg-terminal-bg")).toBe(true);
  });

  it("does not take focus when autoFocus is false", () => {
    const output = createPtyOutputStore();
    const focusSpy = vi.spyOn(FakeTerminal.prototype, "focus");
    const composerWithTerminal = (showTerminal: boolean) => (
      <>
        <textarea aria-label="Composer" />
        {showTerminal && (
          <TerminalView sessionId="s-1" output={output} isLive autoFocus={false} onInput={() => {}} onResize={() => {}} />
        )}
      </>
    );
    const { rerender } = render(composerWithTerminal(false));
    const composer = screen.getByLabelText("Composer");
    composer.focus();

    rerender(composerWithTerminal(true));

    expect(focusSpy).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(composer);
  });

  it("keeps the same terminal when autoFocus changes", () => {
    const output = createPtyOutputStore();
    const { rerender } = render(
      <TerminalView sessionId="s-1" output={output} isLive autoFocus onInput={() => {}} onResize={() => {}} />
    );

    rerender(
      <TerminalView sessionId="s-1" output={output} isLive autoFocus={false} onInput={() => {}} onResize={() => {}} />
    );

    expect(terminals).toHaveLength(1);
    expect(terminals[0].disposed).toBe(false);
  });

  it("keeps the terminal when the session ends, and stops sending input", () => {
    const output = createPtyOutputStore();
    output.append("s-1", "last output");
    const onInput = vi.fn();
    const view = (isLive: boolean) => (
      <TerminalView sessionId="s-1" output={output} isLive={isLive} onInput={onInput} onResize={() => {}} />
    );
    const { rerender } = render(view(true));
    act(() => terminals[0].flushWrites());
    expect(terminals[0].dataListener).not.toBeNull();

    rerender(view(false));

    expect(terminals).toHaveLength(1);
    expect(terminals[0].disposed).toBe(false);
    expect(terminals[0].dataListener).toBeNull();
    expect(onInput).not.toHaveBeenCalled();
  });

  it("takes input, its size and focus when a session becomes live, without rebuilding the terminal", () => {
    const output = createPtyOutputStore();
    const onInput = vi.fn();
    const onResize = vi.fn();
    const view = (isLive: boolean) => (
      <TerminalView sessionId="s-1" output={output} isLive={isLive} onInput={onInput} onResize={onResize} />
    );
    const { rerender } = render(view(false));
    act(() => terminals[0].flushWrites());
    expect(terminals[0].dataListener).toBeNull();
    expect(onResize).not.toHaveBeenCalled();
    expect(terminals[0].focused).toBe(false);

    rerender(view(true));
    terminals[0].dataListener?.("y");

    expect(terminals).toHaveLength(1);
    expect(onInput).toHaveBeenCalledWith("y");
    expect(onResize).toHaveBeenCalledWith(100, 30);
    expect(terminals[0].focused).toBe(true);
  });

  it("does not attach input when the replay finishes after the session ended", () => {
    const output = createPtyOutputStore();
    const view = (isLive: boolean) => (
      <TerminalView sessionId="s-1" output={output} isLive={isLive} onInput={() => {}} onResize={() => {}} />
    );
    const { rerender } = render(view(true));

    rerender(view(false));
    act(() => terminals[0].flushWrites());

    expect(terminals[0].dataListener).toBeNull();
  });

  it("labels the terminal with the given label, defaulting to Agent terminal", () => {
    const { unmount } = render(
      <TerminalView sessionId="s-1" output={createPtyOutputStore()} isLive onInput={() => {}} onResize={() => {}} />
    );
    expect(screen.getByLabelText("Agent terminal")).toBe(screen.getByTestId("terminal-view"));
    unmount();

    render(
      <TerminalView sessionId="s-1" output={createPtyOutputStore()} isLive label="Workspace shell" onInput={() => {}} onResize={() => {}} />
    );
    expect(screen.getByLabelText("Workspace shell")).toBe(screen.getByTestId("terminal-view"));
  });

  it("terminal uses the design system font and colors", () => {
    render(<TerminalView sessionId="s-1" output={createPtyOutputStore()} isLive onInput={() => {}} onResize={() => {}} />);

    const { fontFamily, theme } = terminals[0].options;
    expect(fontFamily?.startsWith('"Geist Mono Variable"')).toBe(true);
    expect(theme?.background).toBe("#0a0a0b");
    expect(theme?.foreground).toBe("#d4d4d8");
    expect(theme?.cursor).toBe("#fafafa");
    expect(theme?.selectionBackground).toBe("rgba(250, 250, 250, 0.2)");
    expect(theme?.red).toBe("#ef4444");
  });

  it("keeps a dark background in either theme", () => {
    render(<TerminalView sessionId="s-1" output={createPtyOutputStore()} isLive onInput={() => {}} onResize={() => {}} />);

    expect(screen.getByTestId("terminal-view").className).toContain("bg-terminal-bg");
  });
});

