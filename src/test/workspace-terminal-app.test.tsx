import "@testing-library/jest-dom/vitest";
import { StrictMode, useState } from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, act, fireEvent, within } from "@testing-library/react";
import { fakeTauriInvoke, type FakeTauriStore } from "./setup";
import type { TerminalViewProps } from "../components/TerminalView";

type Listener = (event: { payload: unknown }) => void;
const listeners = new Map<string, Listener>();

vi.mock("@tauri-apps/api/event", () => ({
  listen: (event: string, cb: Listener) => {
    listeners.set(event, cb);
    return Promise.resolve(() => listeners.delete(event));
  },
  emit: () => Promise.resolve(),
  emitTo: () => Promise.resolve(),
}));

// The xterm view needs a real canvas; the drawer only has to mount one per live tab.
// Each mount records the autoFocus it started with: the real view reads it only then.
const mounts: { sessionId: string; autoFocus?: boolean }[] = [];

vi.mock("../components/TerminalView", () => ({
  TerminalView: function FakeTerminalView(props: TerminalViewProps) {
    useState(() => {
      mounts.push({ sessionId: props.sessionId, autoFocus: props.autoFocus });
      return null;
    });
    return <div data-testid={`view-${props.sessionId}`} aria-label={props.label} />;
  },
}));

import App from "../App";
import { PopoutApp } from "../components/PopoutApp";

type TauriInternals = { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
type Spy = { mock: { calls: unknown[][] } };

const REPO = "/Users/test/developer/zorvo";
const OTHER = "/Users/test/developer/titan-investment";
const WORKTREE = { repoPath: REPO, path: "/data/worktrees/zorvo/fix", branch: "agent/fix" };

function tauriInternals(): TauriInternals {
  return (window as unknown as { __TAURI_INTERNALS__: TauriInternals }).__TAURI_INTERNALS__;
}

function fakeStore(): FakeTauriStore {
  return (window as unknown as { __FAKE_TAURI_STORE__: FakeTauriStore }).__FAKE_TAURI_STORE__;
}

function seedSession(id: string, name: string, cwd: string, createdAt: number, extra: object = {}) {
  return { id, name, profileId: "claude-code", cwd, status: "terminated", createdAt, transport: "acp", ...extra };
}

function callsTo(spy: Spy, cmd: string) {
  return (spy.mock.calls as [string, Record<string, unknown> | undefined][]).filter(([name]) => name === cmd);
}

/** Calls to the commands named, in the order they were made. */
function order(spy: Spy, ...cmds: string[]) {
  return (spy.mock.calls as [string][]).map(([name]) => name).filter((name) => cmds.includes(name));
}

let nextShell = 1;

async function renderApp(
  options: {
    strict?: boolean;
    removeWorktree?: () => Promise<unknown>;
    openGate?: Promise<void>;
    /** Called for each open; true makes that open fail. */
    openFails?: () => boolean;
  } = {},
): Promise<Spy> {
  nextShell = 1;
  const spy = vi.spyOn(tauriInternals(), "invoke").mockImplementation((cmd, args) => {
    if (cmd === "workspace_terminal_open") {
      if (options.openFails?.()) return Promise.reject("The folder is gone");
      const id = `shell-${nextShell++}`;
      return (options.openGate ?? Promise.resolve()).then(() => ({ id, folder: String(args?.path) }));
    }
    if (cmd === "workspace_terminal_close") return Promise.resolve(undefined);
    if (cmd === "remove_session_worktree" && options.removeWorktree) return options.removeWorktree();
    return fakeTauriInvoke(cmd, args);
  });
  await act(async () => {
    render(options.strict ? <StrictMode><App /></StrictMode> : <App />);
  });
  return spy;
}

async function click(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element);
  });
}

const terminalButton = () => screen.getByRole("button", { name: "Terminal" });
const sidebar = () => within(screen.getByRole("complementary"));

async function openSession(name: string) {
  await click(sidebar().getByText(name));
}

async function deleteSession(name: string) {
  const row = () => sidebar().getByText(name).closest("li") as HTMLElement;
  await click(within(row()).getByRole("button", { name: "Delete session" }));
  await click(within(row()).getByRole("button", { name: "Confirm delete" }));
}

describe("Workspace terminal in the app", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    listeners.clear();
    mounts.length = 0;
  });

  it("the Terminal button opens a shell in the session's folder", async () => {
    fakeStore().state.sessions = [seedSession("s-a", "Fix login", REPO, 1000)];
    const spy = await renderApp({ strict: true });
    await openSession("Fix login");

    await click(terminalButton());

    expect(terminalButton()).toHaveAttribute("aria-pressed", "true");
    expect(callsTo(spy, "workspace_terminal_open")).toHaveLength(1);
    expect(callsTo(spy, "workspace_terminal_open")[0][1]).toEqual({ path: REPO });
    expect(screen.getByTestId("view-shell-1")).toBeInTheDocument();
  });

  it("opening the drawer again does not add a shell", async () => {
    fakeStore().state.sessions = [seedSession("s-a", "Fix login", REPO, 1000)];
    const spy = await renderApp({ strict: true });
    await openSession("Fix login");

    await click(terminalButton());
    await click(terminalButton());
    expect(terminalButton()).toHaveAttribute("aria-pressed", "false");
    await click(terminalButton());

    expect(terminalButton()).toHaveAttribute("aria-pressed", "true");
    expect(callsTo(spy, "workspace_terminal_open")).toHaveLength(1);
  });

  it("switching to a folder without terminals opens none", async () => {
    fakeStore().state.sessions = [
      seedSession("s-a", "Fix login", REPO, 1000),
      seedSession("s-b", "Add search", OTHER, 2000),
    ];
    const spy = await renderApp();
    await openSession("Fix login");
    await click(terminalButton());

    await openSession("Add search");

    expect(screen.getByText("No terminal in titan-investment.")).toBeInTheDocument();
    expect(callsTo(spy, "workspace_terminal_open")).toHaveLength(1);
  });

  it("a worktree session's terminal starts in its worktree", async () => {
    fakeStore().state.sessions = [
      seedSession("s-w", "Fix login", WORKTREE.path, 1000, { worktree: WORKTREE }),
    ];
    const spy = await renderApp();
    await openSession("Fix login");

    await click(terminalButton());

    expect(callsTo(spy, "workspace_terminal_open").map(([, args]) => args)).toEqual([{ path: WORKTREE.path }]);
  });

  it("switching sessions keeps the first folder's terminal", async () => {
    fakeStore().state.sessions = [
      seedSession("s-a", "Fix login", REPO, 1000),
      seedSession("s-b", "Add search", OTHER, 2000),
    ];
    const spy = await renderApp();
    await openSession("Fix login");
    await click(terminalButton());
    await act(async () => {
      listeners.get("workspace-terminal")?.({ payload: { terminalId: "shell-1", kind: "output", data: "hello\r\n" } });
    });

    await openSession("Add search");
    await openSession("Fix login");

    expect(callsTo(spy, "workspace_terminal_open")).toHaveLength(1);
    expect(screen.getByRole("tab", { name: /zorvo/ })).toBeInTheDocument();
    expect(screen.getByTestId("view-shell-1")).toBeInTheDocument();
    expect(callsTo(spy, "workspace_terminal_close")).toHaveLength(0);
  });

  it("has no Terminal button without a folder", async () => {
    fakeStore().state.recentFolders = [];
    await renderApp();

    expect(screen.queryByRole("button", { name: "Terminal" })).toBeNull();
  });

  it("deleting a worktree session closes its terminals once the worktree is removed", async () => {
    fakeStore().state.sessions = [
      seedSession("s-w", "Fix login", WORKTREE.path, 1000, { worktree: WORKTREE }),
      seedSession("s-x", "Same folder", WORKTREE.path, 500),
    ];
    const spy = await renderApp();
    await openSession("Fix login");
    await click(terminalButton());

    await deleteSession("Fix login");

    expect(order(spy, "remove_session_worktree", "workspace_terminal_close")).toEqual([
      "remove_session_worktree",
      "workspace_terminal_close",
    ]);
    expect(callsTo(spy, "workspace_terminal_close")[0][1]).toEqual({ id: "shell-1" });
    expect(screen.queryByTestId("view-shell-1")).toBeNull();
  });

  it("keeps the terminals of a worktree that could not be removed", async () => {
    fakeStore().state.sessions = [
      seedSession("s-w", "Fix login", WORKTREE.path, 1000, { worktree: WORKTREE }),
      seedSession("s-x", "Same folder", WORKTREE.path, 500),
    ];
    const spy = await renderApp({ removeWorktree: () => Promise.reject("it has uncommitted changes, so it was kept") });
    await openSession("Fix login");
    await click(terminalButton());

    await deleteSession("Fix login");

    expect(callsTo(spy, "remove_session_worktree")).toHaveLength(1);
    expect(callsTo(spy, "workspace_terminal_close")).toHaveLength(0);
    expect((await screen.findByRole("alert")).textContent).toContain("uncommitted changes");
    expect(screen.getByTestId("view-shell-1")).toBeInTheDocument();
  });

  it("also closes the terminals of the session's folder inside the removed worktree", async () => {
    const inside = `${WORKTREE.path}/packages/app`;
    fakeStore().state.sessions = [seedSession("s-w", "Fix login", inside, 1000, { worktree: WORKTREE })];
    const spy = await renderApp();
    await openSession("Fix login");
    await click(terminalButton());
    expect(callsTo(spy, "workspace_terminal_open")[0][1]).toEqual({ path: inside });

    await deleteSession("Fix login");

    expect(callsTo(spy, "workspace_terminal_close").map(([, args]) => args)).toEqual([{ id: "shell-1" }]);
  });

  it("does not start a second shell while the first is still starting", async () => {
    fakeStore().state.sessions = [seedSession("s-a", "Fix login", REPO, 1000)];
    let release = () => {};
    const openGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const spy = await renderApp({ strict: true, openGate });
    await openSession("Fix login");

    await click(terminalButton());
    await click(terminalButton());
    await click(terminalButton());
    await act(async () => {
      release();
    });

    expect(callsTo(spy, "workspace_terminal_open")).toHaveLength(1);
    expect(screen.getAllByRole("tab")).toHaveLength(1);
  });

  it("shows that the first shell is starting, offers no second one, and focuses it once it is there", async () => {
    fakeStore().state.sessions = [seedSession("s-a", "Fix login", REPO, 1000)];
    let release = () => {};
    const openGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const spy = await renderApp({ openGate });
    await openSession("Fix login");

    await click(terminalButton());

    expect(screen.getByText("Starting a shell…")).toBeInTheDocument();
    expect(screen.queryByText("No terminal in zorvo.")).toBeNull();
    expect(screen.queryByRole("button", { name: "New terminal" })).toBeNull();
    await act(async () => {
      release();
    });

    expect(callsTo(spy, "workspace_terminal_open")).toHaveLength(1);
    expect(screen.queryByText("Starting a shell…")).toBeNull();
    expect(mounts).toEqual([{ sessionId: "shell-1", autoFocus: true }]);
  });

  it("a first shell that could not start gives the empty state back, and New terminal tries again", async () => {
    fakeStore().state.sessions = [seedSession("s-a", "Fix login", REPO, 1000)];
    let attempts = 0;
    const spy = await renderApp({ openFails: () => attempts++ === 0 });
    await openSession("Fix login");

    await click(terminalButton());
    expect(screen.getByText("No terminal in zorvo.")).toBeInTheDocument();
    await click(screen.getByRole("button", { name: "New terminal" }));

    expect(callsTo(spy, "workspace_terminal_open")).toHaveLength(2);
    expect(screen.getByTestId("view-shell-1")).toBeInTheDocument();
  });

  it("a worktree another session still uses keeps its terminals", async () => {
    fakeStore().state.sessions = [
      seedSession("s-w", "Fix login", WORKTREE.path, 1000, { worktree: WORKTREE }),
      seedSession("s-f", "Fix login (fork)", WORKTREE.path, 2000, { worktree: WORKTREE, forkedFrom: "s-w" }),
    ];
    const spy = await renderApp();
    await openSession("Fix login");
    await click(terminalButton());

    await deleteSession("Fix login (fork)");

    expect(callsTo(spy, "workspace_terminal_close")).toHaveLength(0);
    expect(callsTo(spy, "remove_session_worktree")).toHaveLength(0);
  });

  it("a popout has no Terminal button", async () => {
    await act(async () => {
      render(<PopoutApp sessionId="s-1" />);
    });

    expect(screen.queryByRole("button", { name: "Terminal" })).toBeNull();
  });
});
