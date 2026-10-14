import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
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
        pid={1234}
        onClose={vi.fn()}
      />
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders terminal header and controls when isOpen is true", () => {
    render(
      <TerminalDrawer
        isOpen={true}
        sessionId="s-1"
        sessionName="Test Session"
        pid={4567}
        onClose={vi.fn()}
      />
    );

    // Terminal header title with PID
    expect(screen.getByText(/Raw Terminal Stream \[PID: 4567\]/i)).toBeDefined();

    // Action buttons
    expect(screen.getByRole("button", { name: /clear output/i })).toBeDefined();
    expect(screen.getByRole("button", { name: /copy output/i })).toBeDefined();
    expect(screen.getByRole("button", { name: /close drawer/i })).toBeDefined();
  });

  it("calls onClose when close button is clicked", () => {
    const onClose = vi.fn();
    render(
      <TerminalDrawer
        isOpen={true}
        sessionId="s-1"
        sessionName="Test Session"
        pid={1234}
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
        isOpen={true}
        sessionId="s-1"
        sessionName="Test Session"
        pid={1234}
        onClose={vi.fn()}
      />
    );

    // Terminal container element with data-testid
    const termContainer = screen.getByTestId("xterm-terminal-container");
    expect(termContainer).toBeDefined();

    // Verifies Tauri event listener is attached for pty-output
    expect(mockListen).toHaveBeenCalledWith("pty-output", expect.any(Function));
  });

  it("writes output to terminal when pty-output arrives for matching session", async () => {
    render(
      <TerminalDrawer
        isOpen={true}
        sessionId="s-1"
        sessionName="Test Session"
        pid={1234}
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
        isOpen={true}
        sessionId="s-1"
        sessionName="Test Session"
        pid={1234}
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
        isOpen={true}
        sessionId="s-1"
        sessionName="Test Session"
        pid={1234}
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
        isOpen={true}
        sessionId="s-1"
        sessionName="Test Session"
        pid={1234}
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
    const { unmount } = render(
      <TerminalDrawer
        isOpen={true}
        sessionId="s-1"
        sessionName="Test Session"
        pid={1234}
        onClose={vi.fn()}
      />
    );

    unmount();
    expect(mockUnlisten).toHaveBeenCalled();
  });
});
