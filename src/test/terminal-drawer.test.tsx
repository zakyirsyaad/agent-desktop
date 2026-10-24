import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useImperativeHandle, useState } from "react";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { createPtyOutputStore } from "../lib/pty-output-store";
import type { WorkspaceTerminals, WorkspaceTerminalTab } from "../hooks/useWorkspaceTerminals";
import type { TerminalViewProps } from "../components/TerminalView";

// Each mount records the autoFocus it started with: the real view reads it only then.
const { mounts, focusCalls } = vi.hoisted(() => ({
  mounts: [] as { sessionId: string; label?: string; autoFocus?: boolean }[],
  focusCalls: [] as string[],
}));

vi.mock("../components/TerminalView", () => ({
  TerminalView: function FakeTerminalView(props: TerminalViewProps) {
    useState(() => {
      mounts.push({ sessionId: props.sessionId, label: props.label, autoFocus: props.autoFocus });
      return null;
    });
    // A view that is already mounted is focused through its handle, not through autoFocus.
    useImperativeHandle(props.ref, () => ({ focus: () => focusCalls.push(props.sessionId) }));
    return <div data-testid={`view-${props.sessionId}`} aria-label={props.label} />;
  },
}));

import { TerminalDrawer } from "../components/terminal/TerminalDrawer";

function tab(id: string, folderPath: string, number: number, status: "live" | "exited" = "live"): WorkspaceTerminalTab {
  return { id, folderPath, number, status };
}

function fakeTerminals(tabs: WorkspaceTerminalTab[], overrides: Partial<WorkspaceTerminals> = {}): WorkspaceTerminals {
  return {
    output: createPtyOutputStore(),
    tabsFor: (folderPath) => tabs.filter((t) => t.folderPath === folderPath),
    open: vi.fn(async () => null),
    close: vi.fn(),
    closeFolder: vi.fn(),
    send: vi.fn(),
    resize: vi.fn(),
    ...overrides,
  };
}

const baseProps = {
  folderPath: "/work/zorvo",
  folderName: "zorvo",
  branch: "main",
  startingFor: null as string | null,
  onStartShell: vi.fn(async (_folderPath: string): Promise<string | null> => null),
  onHide: vi.fn(),
};

/** Tabs that change when a shell is opened or closed, like the real hook. */
function StatefulDrawer({ initial, extra = {} }: { initial: WorkspaceTerminalTab[]; extra?: object }) {
  const [tabs, setTabs] = useState(initial);
  const terminals = fakeTerminals(tabs, {
    close: vi.fn((id: string) => setTabs((current) => current.filter((t) => t.id !== id))),
  });
  return <TerminalDrawer {...baseProps} {...extra} terminals={terminals} />;
}

describe("TerminalDrawer", () => {
  const originalHeight = window.innerHeight;

  beforeEach(() => {
    mounts.length = 0;
    focusCalls.length = 0;
    baseProps.onHide.mockClear();
    baseProps.onStartShell.mockClear();
  });

  afterEach(() => {
    Object.defineProperty(window, "innerHeight", { configurable: true, value: originalHeight });
  });

  it("shows an empty state for a folder without terminals", () => {
    const terminals = fakeTerminals([]);
    render(<TerminalDrawer {...baseProps} terminals={terminals} />);

    expect(screen.getByText("No terminal in zorvo.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New terminal" })).toBeInTheDocument();
    expect(terminals.open).not.toHaveBeenCalled();
  });

  it("starts the folder's first shell through the caller's guard", async () => {
    const terminals = fakeTerminals([]);
    render(<TerminalDrawer {...baseProps} terminals={terminals} />);

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "New terminal" })); });

    expect(baseProps.onStartShell).toHaveBeenCalledWith("/work/zorvo");
    expect(terminals.open).not.toHaveBeenCalled();
  });

  it("shows that a shell is starting instead of the empty state, then focuses the first tab", () => {
    let tabs: WorkspaceTerminalTab[] = [];
    const terminals = fakeTerminals([], { tabsFor: (folderPath) => tabs.filter((t) => t.folderPath === folderPath) });
    const { rerender } = render(<TerminalDrawer {...baseProps} startingFor="/work/zorvo" terminals={terminals} />);

    expect(screen.getByText("Starting a shell…")).toBeInTheDocument();
    expect(screen.queryByText("No terminal in zorvo.")).toBeNull();
    expect(screen.queryByRole("button", { name: "New terminal" })).toBeNull();

    tabs = [tab("shell-1", "/work/zorvo", 1)];
    rerender(<TerminalDrawer {...baseProps} startingFor="/work/zorvo" terminals={{ ...terminals }} />);
    rerender(<TerminalDrawer {...baseProps} startingFor={null} terminals={{ ...terminals }} />);

    expect(screen.queryByText("Starting a shell…")).toBeNull();
    expect(mounts).toEqual([expect.objectContaining({ sessionId: "shell-1", autoFocus: true })]);
  });

  it("does not focus a first shell that appears after you left its folder", () => {
    let tabs: WorkspaceTerminalTab[] = [tab("shell-2", "/work/other", 1)];
    const terminals = fakeTerminals([], { tabsFor: (folderPath) => tabs.filter((t) => t.folderPath === folderPath) });
    const { rerender } = render(<TerminalDrawer {...baseProps} startingFor="/work/zorvo" terminals={terminals} />);
    rerender(<TerminalDrawer {...baseProps} folderPath="/work/other" folderName="other" startingFor="/work/zorvo" terminals={terminals} />);
    mounts.length = 0;

    tabs = [...tabs, tab("shell-1", "/work/zorvo", 1)];
    rerender(<TerminalDrawer {...baseProps} startingFor={null} terminals={{ ...terminals }} />);

    expect(mounts.at(-1)).toMatchObject({ sessionId: "shell-1", autoFocus: false });
  });

  it("the drawer's section keeps the terminal's dark fill to the terminal", () => {
    render(<TerminalDrawer {...baseProps} terminals={fakeTerminals([tab("shell-1", "/work/zorvo", 1, "exited")])} />);

    expect(screen.getByRole("region", { name: "Terminal" })).not.toHaveClass("bg-terminal-bg");
    expect(screen.getByRole("tablist").parentElement).not.toHaveClass("bg-terminal-bg");
    expect(screen.getByText("The shell exited.").parentElement).not.toHaveClass("bg-terminal-bg");
  });

  it("puts the terminal straight into the panel's flex column, so its height comes from the drawer and not from its output", () => {
    render(<TerminalDrawer {...baseProps} terminals={fakeTerminals([tab("shell-1", "/work/zorvo", 1)])} />);

    const panel = screen.getByRole("tabpanel");
    expect(screen.getByTestId("view-shell-1").parentElement).toBe(panel);
    expect(panel).toHaveClass("flex", "flex-col");
  });

  it("Hide terminal does not use the close icon", () => {
    render(<TerminalDrawer {...baseProps} terminals={fakeTerminals([tab("shell-1", "/work/zorvo", 1)])} />);

    const hide = screen.getByRole("button", { name: "Hide terminal" });
    expect(hide.querySelector("svg")).toHaveClass("lucide-chevron-down");
    expect(screen.getByRole("button", { name: "Close zorvo · main" }).querySelector("svg")).toHaveClass("lucide-x");
  });

  it("picking the tab that is already in front focuses its shell", async () => {
    render(<TerminalDrawer {...baseProps} terminals={fakeTerminals([tab("shell-1", "/work/zorvo", 1)])} />);

    await act(async () => { fireEvent.click(screen.getByRole("tab", { name: "zorvo · main" })); });

    expect(focusCalls).toEqual(["shell-1"]);
    expect(mounts).toHaveLength(1);
  });

  it("closing the tab in front focuses the shell that takes its place", async () => {
    render(<StatefulDrawer initial={[tab("shell-1", "/work/zorvo", 1), tab("shell-2", "/work/zorvo", 2)]} />);
    mounts.length = 0;

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Close zorvo · main 2" })); });

    expect(mounts).toEqual([expect.objectContaining({ sessionId: "shell-1", autoFocus: true })]);
  });

  it("closing a tab behind the one in front puts focus on the tab strip", async () => {
    render(<StatefulDrawer initial={[tab("shell-1", "/work/zorvo", 1), tab("shell-2", "/work/zorvo", 2)]} />);

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Close zorvo · main" })); });

    expect(screen.getByRole("tab", { name: "zorvo · main 2" })).toHaveFocus();
  });

  it("closing the last tab puts focus on New terminal", async () => {
    render(<StatefulDrawer initial={[tab("shell-1", "/work/zorvo", 1)]} />);

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Close zorvo · main" })); });

    expect(screen.getByRole("button", { name: "New terminal" })).toHaveFocus();
  });

  it("shows the folder's tabs and switches between them", async () => {
    const terminals = fakeTerminals([tab("shell-1", "/work/zorvo", 1), tab("shell-2", "/work/zorvo", 2)]);
    render(<TerminalDrawer {...baseProps} terminals={terminals} />);

    const first = screen.getByRole("tab", { name: "zorvo · main" });
    const second = screen.getByRole("tab", { name: "zorvo · main 2" });
    // The newest tab is the one in front until you pick another.
    expect(second).toHaveAttribute("aria-selected", "true");
    expect(first).toHaveAttribute("aria-selected", "false");

    await act(async () => { fireEvent.click(first); });
    expect(first).toHaveAttribute("aria-selected", "true");
    expect(screen.getByLabelText("zorvo · main")).toBeInTheDocument();
    expect(screen.queryByTestId("view-shell-2")).not.toBeInTheDocument();

    await act(async () => { fireEvent.click(second); });
    expect(second).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("view-shell-2")).toHaveAttribute("aria-label", "zorvo · main 2");
  });

  it("New terminal adds a tab, and its view takes focus", async () => {
    let tabs = [tab("shell-1", "/work/zorvo", 1)];
    const terminals = fakeTerminals([], {
      tabsFor: (folderPath) => tabs.filter((t) => t.folderPath === folderPath),
      open: vi.fn(async (folderPath: string) => {
        tabs = [...tabs, tab("shell-2", folderPath, 2)];
        return "shell-2";
      }),
    });
    const { rerender } = render(<TerminalDrawer {...baseProps} terminals={terminals} />);
    mounts.length = 0;

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "New terminal" })); });
    rerender(<TerminalDrawer {...baseProps} terminals={{ ...terminals }} />);

    expect(terminals.open).toHaveBeenCalledWith("/work/zorvo");
    expect(screen.getByRole("tab", { name: "zorvo · main 2" })).toHaveAttribute("aria-selected", "true");
    expect(mounts.at(-1)).toMatchObject({ sessionId: "shell-2", autoFocus: true });
  });

  it("takes focus when the drawer opens on a folder that has a terminal", () => {
    const terminals = fakeTerminals([tab("shell-1", "/work/zorvo", 1)]);
    render(<TerminalDrawer {...baseProps} terminals={terminals} />);

    expect(mounts).toEqual([expect.objectContaining({ sessionId: "shell-1", autoFocus: true })]);
  });

  it("a session switch does not take focus", () => {
    const terminals = fakeTerminals([tab("shell-1", "/work/zorvo", 1), tab("shell-2", "/work/other", 1)]);
    const { rerender } = render(<TerminalDrawer {...baseProps} terminals={terminals} />);

    rerender(
      <TerminalDrawer {...baseProps} folderPath="/work/other" folderName="other" branch="dev" terminals={terminals} />,
    );

    expect(mounts.at(-1)).toMatchObject({ sessionId: "shell-2", label: "other · dev", autoFocus: false });
  });

  it("does not take focus again when you return to a folder after the first mount", () => {
    const terminals = fakeTerminals([tab("shell-1", "/work/zorvo", 1), tab("shell-2", "/work/other", 1)]);
    const { rerender } = render(<TerminalDrawer {...baseProps} terminals={terminals} />);
    rerender(<TerminalDrawer {...baseProps} folderPath="/work/other" folderName="other" terminals={terminals} />);
    rerender(<TerminalDrawer {...baseProps} terminals={terminals} />);

    expect(mounts.at(-1)).toMatchObject({ sessionId: "shell-1", autoFocus: false });
  });

  it("Close <label> ends that shell", async () => {
    const terminals = fakeTerminals([tab("shell-1", "/work/zorvo", 1), tab("shell-2", "/work/zorvo", 2)]);
    render(<TerminalDrawer {...baseProps} terminals={terminals} />);

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Close zorvo · main 2" })); });

    expect(terminals.close).toHaveBeenCalledWith("shell-2");
  });

  it("an exited shell offers a new one", async () => {
    const terminals = fakeTerminals([tab("shell-1", "/work/zorvo", 1, "exited")]);
    render(<TerminalDrawer {...baseProps} terminals={terminals} />);

    expect(screen.getByText("The shell exited.")).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Start a new shell" })); });

    expect(baseProps.onStartShell).toHaveBeenCalledWith("/work/zorvo");
  });

  it("Escape in the terminal leaves the drawer open", () => {
    const terminals = fakeTerminals([tab("shell-1", "/work/zorvo", 1)]);
    render(<TerminalDrawer {...baseProps} terminals={terminals} />);

    fireEvent.keyDown(screen.getByTestId("view-shell-1"), { key: "Escape" });

    expect(screen.getByTestId("view-shell-1")).toBeInTheDocument();
    expect(baseProps.onHide).not.toHaveBeenCalled();
  });

  it("the resize handle moves with the arrow keys", () => {
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 1000 });
    const terminals = fakeTerminals([tab("shell-1", "/work/zorvo", 1)]);
    render(<TerminalDrawer {...baseProps} terminals={terminals} />);
    const handle = screen.getByRole("separator");
    expect(handle).toHaveAttribute("aria-valuenow", "280");

    fireEvent.keyDown(handle, { key: "ArrowUp" });
    expect(handle).toHaveAttribute("aria-valuenow", "304");

    for (let i = 0; i < 100; i++) fireEvent.keyDown(handle, { key: "ArrowUp" });
    expect(handle).toHaveAttribute("aria-valuenow", "700");

    for (let i = 0; i < 100; i++) fireEvent.keyDown(handle, { key: "ArrowDown" });
    expect(handle).toHaveAttribute("aria-valuenow", "120");
  });

  it("the resize handle follows a pointer drag", () => {
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 1000 });
    const terminals = fakeTerminals([tab("shell-1", "/work/zorvo", 1)]);
    render(<TerminalDrawer {...baseProps} terminals={terminals} />);
    const handle = screen.getByRole("separator");
    handle.setPointerCapture = vi.fn();
    handle.releasePointerCapture = vi.fn();

    act(() => {
      fireEvent.pointerDown(handle, { clientY: 600, pointerId: 1 });
      fireEvent.pointerMove(handle, { clientY: 500, pointerId: 1 });
    });
    expect(handle).toHaveAttribute("aria-valuenow", "380");

    act(() => {
      fireEvent.pointerUp(handle, { clientY: 500, pointerId: 1 });
      fireEvent.pointerMove(handle, { clientY: 100, pointerId: 1 });
    });
    expect(handle).toHaveAttribute("aria-valuenow", "380");
  });

  it("Hide terminal calls onHide", async () => {
    render(<TerminalDrawer {...baseProps} terminals={fakeTerminals([])} />);

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Hide terminal" })); });

    expect(baseProps.onHide).toHaveBeenCalledTimes(1);
  });
});
