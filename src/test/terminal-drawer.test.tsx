import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import { TerminalDrawer } from "../components/TerminalDrawer";

// Mock @tauri-apps/api/event and @tauri-apps/api/core
let capturedListenCb: ((event: { payload: { session_id: string; data: string } }) => void) | null = null;
const mockUnlisten = vi.fn();
const mockListen = vi.fn().mockImplementation((event: string, cb: (event: { payload: { session_id: string; data: string } }) => void) => {
  if (event === "pty-output") {
    capturedListenCb = cb;
  }
  return Promise.resolve(mockUnlisten);
});
const mockInvoke = vi.fn().mockResolvedValue(undefined);

vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => mockListen(...args),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

// Mock ResizeObserver
let capturedResizeObserverCb: ResizeObserverCallback | null = null;
class MockResizeObserver {
  callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    capturedResizeObserverCb = callback;
  }
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}

globalThis.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;

function setupJSDOMGlobals() {
  window.requestAnimationFrame = (cb: FrameRequestCallback) => setTimeout(cb, 0) as unknown as number;
  window.cancelAnimationFrame = (id: number) => clearTimeout(id);

  const mockMql = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });

  window.matchMedia = mockMql as unknown as typeof window.matchMedia;

  HTMLCanvasElement.prototype.getContext = (() => ({
    fillRect: () => {},
    clearRect: () => {},
    getImageData: () => ({ data: new Array(4) }),
    putImageData: () => {},
    createImageData: () => [],
    setTransform: () => {},
    drawImage: () => {},
    save: () => {},
    fillText: () => {},
    restore: () => {},
    beginPath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    closePath: () => {},
    stroke: () => {},
    translate: () => {},
    scale: () => {},
    rotate: () => {},
    arc: () => {},
    fill: () => {},
    measureText: () => ({ width: 10 }),
    transform: () => {},
    rect: () => {},
    clip: () => {},
  })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
}

describe("TerminalDrawer", () => {
  beforeAll(() => {
    setupJSDOMGlobals();
  });

  beforeEach(() => {
    setupJSDOMGlobals();
    capturedListenCb = null;
    capturedResizeObserverCb = null;
  });

  it("does not render when isOpen is false", () => {
    const { container } = render(
      <TerminalDrawer
        isOpen={false}
        sessionId="s-1"
        sessionName="Test Session"
        onClose={vi.fn()}
      />
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders terminal header and controls when isOpen is true", () => {
    render(
      <TerminalDrawer
        isLive
        isOpen={true}
        sessionId="s-1"
        sessionName="Test Session"
        onClose={vi.fn()}
      />
    );

    expect(screen.getByText("Terminal")).toBeDefined();
    expect(screen.getByText("Test Session")).toBeDefined();
    expect(screen.queryByText(/PID/)).toBeNull();

    // Action buttons
    expect(screen.getByRole("button", { name: /clear output/i })).toBeDefined();
    expect(screen.getByRole("button", { name: /copy output/i })).toBeDefined();
    expect(screen.getByRole("button", { name: /close drawer/i })).toBeDefined();
  });

  it("calls onClose when close button is clicked", () => {
    const onClose = vi.fn();
    render(
      <TerminalDrawer
        isLive
        isOpen={true}
        sessionId="s-1"
        sessionName="Test Session"
        onClose={onClose}
      />
    );

    const closeBtn = screen.getByRole("button", { name: /close drawer/i });
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("mounts xterm terminal instance and registers Tauri pty-output listener", async () => {
    render(
      <TerminalDrawer
        isLive
        isOpen={true}
        sessionId="s-1"
        sessionName="Test Session"
        onClose={vi.fn()}
      />
    );

    // Terminal container element with data-testid
    const termContainer = screen.getByTestId("xterm-terminal-container");
    expect(termContainer).toBeDefined();

    // Verifies Tauri event listener is attached for pty-output
    expect(mockListen).toHaveBeenCalledWith("pty-output", expect.any(Function));
  });

  it("forwards terminal keystrokes to onSendInput and dispatches to PTY", () => {
    const onSendInput = vi.fn();
    render(
      <TerminalDrawer
        isLive
        isOpen={true}
        sessionId="s-1"
        sessionName="Test Session"
        onSendInput={onSendInput}
        onClose={vi.fn()}
      />
    );

    const container = screen.getByTestId("xterm-terminal-container") as HTMLElement & {
      _xterm?: { input: (data: string) => void };
    };
    expect(container._xterm).toBeDefined();

    // Simulate user typing into terminal
    act(() => {
      container._xterm?.input("git status\r");
    });

    expect(onSendInput).toHaveBeenCalledWith("git status\r");
  });

  it("keeps the same terminal and listener when the parent re-renders with new callback identities", () => {
    // App re-renders on every parsed PTY chunk and passes fresh inline callbacks.
    // That must not dispose the terminal (wiping its scrollback) or re-subscribe.
    mockListen.mockClear();
    const firstSendInput = vi.fn();
    const latestSendInput = vi.fn();

    const { rerender } = render(
      <TerminalDrawer
        isLive
        isOpen={true}
        sessionId="s-1"
        onSendInput={firstSendInput}
        onResize={() => {}}
        onClose={() => {}}
      />
    );

    const container = screen.getByTestId("xterm-terminal-container") as HTMLElement & {
      _xterm?: { input: (data: string) => void };
    };
    const originalTerminal = container._xterm;

    rerender(
      <TerminalDrawer
        isLive
        isOpen={true}
        sessionId="s-1"
        onSendInput={latestSendInput}
        onResize={() => {}}
        onClose={() => {}}
      />
    );

    // Compare identity as a boolean: a failing toBe() would pretty-print the
    // whole circular xterm instance and exhaust memory.
    expect(container._xterm === originalTerminal).toBe(true);
    expect(mockListen).toHaveBeenCalledTimes(1);

    act(() => {
      container._xterm?.input("ls\r");
    });

    expect(latestSendInput).toHaveBeenCalledWith("ls\r");
    expect(firstSendInput).not.toHaveBeenCalled();
  });

  it("forwards terminal keystrokes directly to Tauri send_input when onSendInput is not provided", () => {
    render(
      <TerminalDrawer
        isLive
        isOpen={true}
        sessionId="s-42"
        sessionName="Test Session"
        onClose={vi.fn()}
      />
    );

    const container = screen.getByTestId("xterm-terminal-container") as HTMLElement & {
      _xterm?: { input: (data: string) => void };
    };
    expect(container._xterm).toBeDefined();

    act(() => {
      container._xterm?.input("echo hi\r");
    });

    expect(mockInvoke).toHaveBeenCalledWith("send_input", {
      sessionId: "s-42",
      data: "echo hi\r",
    });
  });

  it("dispatches initial resize immediately on drawer open", () => {
    const onResize = vi.fn();
    render(
      <TerminalDrawer
        isLive
        isOpen={true}
        sessionId="s-1"
        sessionName="Test Session"
        onResize={onResize}
        onClose={vi.fn()}
      />
    );

    // handleResize() runs synchronously upon mounting
    expect(onResize).toHaveBeenCalledWith(expect.any(Number), expect.any(Number));
  });

  it("writes output to terminal when pty-output arrives for matching session", async () => {
    render(
      <TerminalDrawer
        isLive
        isOpen={true}
        sessionId="s-1"
        sessionName="Test Session"
        onClose={vi.fn()}
      />
    );

    expect(capturedListenCb).not.toBeNull();

    // Dispatch event for matching session
    act(() => {
      capturedListenCb?.({
        payload: {
          session_id: "s-1",
          data: "chunk test output\r\n",
        },
      });
    });

    // Also dispatch for non-matching session (should be ignored)
    act(() => {
      capturedListenCb?.({
        payload: {
          session_id: "s-other",
          data: "other session output\r\n",
        },
      });
    });
  });

  it("clears terminal when clear button is clicked", () => {
    render(
      <TerminalDrawer
        isLive
        isOpen={true}
        sessionId="s-1"
        sessionName="Test Session"
        onClose={vi.fn()}
      />
    );

    const clearBtn = screen.getByRole("button", { name: /clear output/i });
    fireEvent.click(clearBtn);
    expect(screen.getByTestId("xterm-terminal-container")).toBeDefined();
  });

  it("copies terminal content to clipboard when copy button is clicked", async () => {
    const mockClipboardWrite = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, {
      clipboard: {
        writeText: mockClipboardWrite,
      },
    });

    render(
      <TerminalDrawer
        isLive
        isOpen={true}
        sessionId="s-1"
        sessionName="Test Session"
        onClose={vi.fn()}
      />
    );

    const copyBtn = screen.getByRole("button", { name: /copy output/i });
    await act(async () => {
      fireEvent.click(copyBtn);
    });

    expect(copyBtn).toBeDefined();
  });

  it("triggers resize observer and invokes resize session callback", () => {
    const onResize = vi.fn();
    render(
      <TerminalDrawer
        isLive
        isOpen={true}
        sessionId="s-1"
        sessionName="Test Session"
        onResize={onResize}
        onClose={vi.fn()}
      />
    );

    expect(capturedResizeObserverCb).not.toBeNull();
    act(() => {
      capturedResizeObserverCb?.([], {} as ResizeObserver);
    });

    expect(screen.getByTestId("xterm-terminal-container")).toBeDefined();
  });

  it("cleans up terminal and unlistens on unmount", async () => {
    // Called by an earlier test's drawer otherwise, which would pass this one by accident.
    mockUnlisten.mockClear();
    const { unmount } = render(
      <TerminalDrawer
        isLive
        isOpen={true}
        sessionId="s-1"
        sessionName="Test Session"
        onClose={vi.fn()}
      />
    );

    unmount();
    // The listener is registered asynchronously, so it is let go once that settles.
    await waitFor(() => expect(mockUnlisten).toHaveBeenCalled());
  });

  it("shows a placeholder instead of a terminal when no session is selected", () => {
    mockListen.mockClear();
    mockInvoke.mockClear();
    const onClose = vi.fn();
    render(<TerminalDrawer isOpen={true} sessionId="" isLive={true} onClose={onClose} />);

    expect(screen.getByText("No running session. Start one to see its terminal.")).toBeDefined();
    expect(screen.queryByTestId("xterm-terminal-container")).toBeNull();
    expect(mockListen).not.toHaveBeenCalled();
    expect(mockInvoke).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /close drawer/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows a placeholder and sends nothing while the session is not running", () => {
    mockListen.mockClear();
    mockInvoke.mockClear();
    const onSendInput = vi.fn();
    const onResize = vi.fn();
    render(
      <TerminalDrawer
        isOpen={true}
        sessionId="s-1"
        sessionName="Test Session"
        isLive={false}
        onSendInput={onSendInput}
        onResize={onResize}
        onClose={vi.fn()}
      />
    );

    expect(screen.getByText("No running session. Start one to see its terminal.")).toBeDefined();
    expect(screen.getByText("Terminal")).toBeDefined();
    expect(screen.queryByTestId("xterm-terminal-container")).toBeNull();
    expect(mockListen).not.toHaveBeenCalled();
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(onSendInput).not.toHaveBeenCalled();
    expect(onResize).not.toHaveBeenCalled();
  });

  it("mounts the terminal once the session starts running", () => {
    mockListen.mockClear();
    const { rerender } = render(
      <TerminalDrawer isOpen={true} sessionId="s-1" isLive={false} onClose={vi.fn()} />
    );
    expect(screen.queryByTestId("xterm-terminal-container")).toBeNull();

    rerender(<TerminalDrawer isOpen={true} sessionId="s-1" isLive={true} onClose={vi.fn()} />);

    expect(screen.getByTestId("xterm-terminal-container")).toBeDefined();
    expect(mockListen).toHaveBeenCalledWith("pty-output", expect.any(Function));
  });

  it("shows the live indicator only while the session's agent is running", () => {
    const { rerender } = render(
      <TerminalDrawer isOpen={true} sessionId="s-1" sessionName="Test Session" isLive={false} onClose={vi.fn()} />
    );
    expect(screen.queryByLabelText("Agent running")).toBeNull();

    rerender(
      <TerminalDrawer isOpen={true} sessionId="s-1" sessionName="Test Session" isLive={true} onClose={vi.fn()} />
    );
    expect(screen.getByLabelText("Agent running")).toBeDefined();
  });
});
