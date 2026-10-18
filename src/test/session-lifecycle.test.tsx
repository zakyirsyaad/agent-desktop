import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, act, fireEvent, waitFor, within } from "@testing-library/react";
import { fakeTauriInvoke, type FakeTauriStore } from "./setup";

type Listener = (event: { payload: unknown }) => void;
const listeners = new Map<string, Listener>();

vi.mock("@tauri-apps/api/event", () => ({
  listen: (event: string, cb: Listener) => {
    listeners.set(event, cb);
    return Promise.resolve(() => listeners.delete(event));
  },
}));

import App from "../App";

type TauriInternals = { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };

function tauriInternals(): TauriInternals {
  return (window as unknown as { __TAURI_INTERNALS__: TauriInternals }).__TAURI_INTERNALS__;
}

function fakeStore(): FakeTauriStore {
  return (window as unknown as { __FAKE_TAURI_STORE__: FakeTauriStore }).__FAKE_TAURI_STORE__;
}

function seedSession(id: string, name: string, createdAt: number) {
  return {
    id,
    name,
    profileId: "claude-code",
    cwd: "/Users/test/developer/agent-desktop",
    status: "terminated",
    createdAt,
  };
}

async function renderApp() {
  await act(async () => {
    render(<App />);
  });
}

/** The message `startNewSession` starts a session with, which also names it. */
const FIRST_MESSAGE = "get started";

/** Starts a session the way the user does: New, then a first message. */
async function startNewSession(): Promise<string> {
  const spy = vi.spyOn(tauriInternals(), "invoke");
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "+ New session" }));
  });
  const composer = screen.getByRole("textbox", { name: "Prompt" });
  await act(async () => {
    fireEvent.change(composer, { target: { value: FIRST_MESSAGE } });
    fireEvent.keyDown(composer, { key: "Enter" });
  });
  const spawnCall = spy.mock.calls.find(([cmd]) => cmd === "spawn_session");
  return (spawnCall?.[1] as { sessionId: string }).sessionId;
}

function sidebar() {
  return within(screen.getByRole("complementary"));
}

function sessionRow(name: string): HTMLElement {
  return sidebar().getByText(name).closest("li") as HTMLElement;
}

describe("Session lifecycle", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    listeners.clear();
  });

  it("restores saved sessions and loads a session's transcript when it is selected", async () => {
    fakeStore().state.sessions = [
      seedSession("s-old", "Refactor parser", 1000),
      seedSession("s-new", "Fix login", 2000),
    ];
    fakeStore().transcripts["s-old"] = [
      { id: "m-1", role: "user", content: "hello from disk", timestamp: 1 },
    ];

    await renderApp();

    expect(sidebar().getByText("Fix login")).toBeDefined();
    await act(async () => {
      fireEvent.click(sidebar().getByText("Refactor parser"));
    });
    expect(await screen.findByText("hello from disk")).toBeDefined();
  });

  it("ends agents a previous UI left running when it loads (e.g. after a webview reload)", async () => {
    const spy = vi.spyOn(tauriInternals(), "invoke");

    await renderApp();

    expect(spy.mock.calls.some(([cmd]) => cmd === "end_orphaned_sessions")).toBe(true);
  });

  it("persists a newly started session", async () => {
    await renderApp();
    await startNewSession();

    await waitFor(() => {
      const saved = fakeStore().state.sessions as { cwd: string }[];
      expect(saved).toHaveLength(1);
      expect(saved[0].cwd).toBe("/Users/test/developer/ai-perpetual-trading");
    });
  });

  it("offers Stop only while the agent works, and stops its turn with Ctrl+C", async () => {
    await renderApp();
    const sessionId = await startNewSession();
    const row = () => sessionRow(FIRST_MESSAGE);
    expect(within(row()).queryByRole("button", { name: "Stop session" })).toBeNull();
    expect(within(row()).queryByLabelText("Agent working")).toBeNull();

    await act(async () => {
      listeners.get("pty-output")?.({ payload: { session_id: sessionId, data: "Thinking...\r\n" } });
    });
    expect(within(row()).getByLabelText("Agent working")).toBeDefined();
    const spy = vi.spyOn(tauriInternals(), "invoke");
    await act(async () => {
      fireEvent.click(within(row()).getByRole("button", { name: "Stop session" }));
    });

    expect(spy).toHaveBeenCalledWith("send_input", { sessionId, data: "\x03" }, undefined);
  });

  it("marks a session ended when its agent process exits", async () => {
    await renderApp();
    const sessionId = await startNewSession();

    await act(async () => {
      listeners.get("pty-exit")?.({ payload: { session_id: sessionId, exit_code: 0 } });
    });

    await waitFor(() => {
      const [saved] = fakeStore().state.sessions as { status: string }[];
      expect(saved.status).toBe("terminated");
    });
    expect(within(sessionRow(FIRST_MESSAGE)).getByRole("button", { name: "Delete session" })).toBeDefined();
  });

  it("stops a live session's agent before deleting it", async () => {
    await renderApp();
    const sessionId = await startNewSession();
    const spy = vi.spyOn(tauriInternals(), "invoke");

    await act(async () => {
      fireEvent.click(within(sessionRow(FIRST_MESSAGE)).getByRole("button", { name: "Delete session" }));
    });
    await act(async () => {
      fireEvent.click(within(sessionRow(FIRST_MESSAGE)).getByRole("button", { name: "Confirm delete" }));
    });

    expect(spy).toHaveBeenCalledWith("terminate_session", { sessionId }, undefined);
    expect(sidebar().queryByText(FIRST_MESSAGE)).toBeNull();
  });

  it("does not bring back a deleted terminal session's transcript from its last output", async () => {
    await renderApp();
    const sessionId = await startNewSession();
    const spy = vi.spyOn(tauriInternals(), "invoke");

    await act(async () => {
      fireEvent.click(within(sessionRow(FIRST_MESSAGE)).getByRole("button", { name: "Delete session" }));
    });
    await act(async () => {
      fireEvent.click(within(sessionRow(FIRST_MESSAGE)).getByRole("button", { name: "Confirm delete" }));
    });
    await act(async () => {
      listeners.get("pty-output")?.({ payload: { session_id: sessionId, data: "Goodbye\r\n" } });
    });
    await new Promise((resolve) => setTimeout(resolve, 1200));

    expect(spy.mock.calls.filter(([cmd, args]) => cmd === "save_transcript" && (args as { sessionId?: string })?.sessionId === sessionId)).toHaveLength(0);
  });

  it("shows a terminal agent's real screen instead of a chat, and takes input there", async () => {
    await renderApp();
    await startNewSession();

    expect(screen.getByTestId("terminal-view")).toBeDefined();
    const composer = screen.getByRole("textbox", { name: "Prompt" });
    expect(composer.closest(".hidden")).not.toBeNull();
    expect(screen.queryByRole("heading", { name: "No session yet" })).toBeNull();
  });

  it("marks a terminal agent waiting on a y/n prompt as waiting for the user", async () => {
    await renderApp();
    const sessionId = await startNewSession();

    await act(async () => {
      listeners.get("pty-output")?.({ payload: { session_id: sessionId, data: "Allow this action? [y/n]: " } });
    });

    expect(within(sessionRow(FIRST_MESSAGE)).getByLabelText("Waiting for your answer")).toBeDefined();
  });

  it("asks to confirm before deleting a session and its history", async () => {
    fakeStore().state.sessions = [seedSession("s-old", "Refactor parser", 1000)];
    await renderApp();
    const spy = vi.spyOn(tauriInternals(), "invoke");

    await act(async () => {
      fireEvent.click(within(sessionRow("Refactor parser")).getByRole("button", { name: "Delete session" }));
    });

    expect(sidebar().getByText("Refactor parser")).toBeDefined();
    expect(spy.mock.calls.some(([cmd]) => cmd === "delete_transcript")).toBe(false);
    expect(within(sessionRow("Refactor parser")).getByRole("button", { name: "Confirm delete" })).toBeDefined();
  });

  it("deletes an ended session and its transcript", async () => {
    fakeStore().state.sessions = [seedSession("s-old", "Refactor parser", 1000)];
    fakeStore().transcripts["s-old"] = [];
    await renderApp();
    const spy = vi.spyOn(tauriInternals(), "invoke");

    await act(async () => {
      fireEvent.click(within(sessionRow("Refactor parser")).getByRole("button", { name: "Delete session" }));
    });
    await act(async () => {
      fireEvent.click(within(sessionRow("Refactor parser")).getByRole("button", { name: "Confirm delete" }));
    });

    expect(sidebar().queryByText("Refactor parser")).toBeNull();
    expect(spy).toHaveBeenCalledWith("delete_transcript", { sessionId: "s-old" }, undefined);
  });

  it("starts a new session from the composer when the active one has ended", async () => {
    fakeStore().state.sessions = [seedSession("s-old", "Refactor parser", 1000)];
    await renderApp();
    const spy = vi.spyOn(tauriInternals(), "invoke");

    const composer = screen.getByPlaceholderText(/start a new session/i) as HTMLTextAreaElement;
    expect(composer.disabled).toBe(false);
    await act(async () => {
      fireEvent.change(composer, { target: { value: "run the tests" } });
      fireEvent.keyDown(composer, { key: "Enter" });
    });

    expect(spy.mock.calls.some(([cmd]) => cmd === "spawn_session")).toBe(true);
    expect(sidebar().getByText("run the tests")).toBeDefined();
  });

  it("shows an alert and does not append the message when sending fails", async () => {
    await renderApp();
    await startNewSession();
    vi.spyOn(tauriInternals(), "invoke").mockImplementation((cmd, args) =>
      cmd === "send_input" ? Promise.reject("Session 's-x' not found") : fakeTauriInvoke(cmd, args)
    );

    const composer = screen.getByRole("textbox", { name: /prompt/i });
    await act(async () => {
      fireEvent.change(composer, { target: { value: "please run the tests" } });
      fireEvent.keyDown(composer, { key: "Enter" });
    });

    expect(screen.getByRole("alert").textContent).toContain("Failed to send input");
    expect(screen.queryByText("please run the tests")).toBeNull();
  });

  it("removes a deleted session's worktree, unless another session still runs in it", async () => {
    const worktree = { repoPath: "/Users/test/developer/agent-desktop", path: "/data/worktrees/agent-desktop/fix", branch: "agent/fix" };
    fakeStore().state.sessions = [
      { ...seedSession("s-src", "Fix login", 1000), cwd: worktree.path, worktree },
      { ...seedSession("s-fork", "Fix login (fork)", 2000), cwd: worktree.path, worktree, forkedFrom: "s-src" },
    ];
    await renderApp();
    const spy = vi.spyOn(tauriInternals(), "invoke");
    const remove = async (name: string) => {
      await act(async () => {
        fireEvent.click(within(sessionRow(name)).getByRole("button", { name: "Delete session" }));
      });
      await act(async () => {
        fireEvent.click(within(sessionRow(name)).getByRole("button", { name: "Confirm delete" }));
      });
    };
    const removals = () => spy.mock.calls.filter(([cmd]) => cmd === "remove_session_worktree");

    await remove("Fix login (fork)");
    expect(removals()).toHaveLength(0);

    await remove("Fix login");
    expect(removals().map(([, args]) => args)).toEqual([{ repoPath: worktree.repoPath, path: worktree.path }]);
  });

  it("says so when a deleted session's worktree is kept for its uncommitted changes", async () => {
    const worktree = { repoPath: "/Users/test/developer/agent-desktop", path: "/data/worktrees/agent-desktop/fix", branch: "agent/fix" };
    fakeStore().state.sessions = [{ ...seedSession("s-src", "Fix login", 1000), cwd: worktree.path, worktree }];
    await renderApp();
    vi.spyOn(tauriInternals(), "invoke").mockImplementation((cmd, args) =>
      cmd === "remove_session_worktree"
        ? Promise.reject("/data/worktrees/agent-desktop/fix has uncommitted changes, so it was kept")
        : fakeTauriInvoke(cmd, args)
    );

    await act(async () => {
      fireEvent.click(within(sessionRow("Fix login")).getByRole("button", { name: "Delete session" }));
    });
    await act(async () => {
      fireEvent.click(within(sessionRow("Fix login")).getByRole("button", { name: "Confirm delete" }));
    });

    expect((await screen.findByRole("alert")).textContent).toContain("uncommitted changes");
  });

  async function chooseFromMenu(sessionName: string, action: string) {
    await act(async () => {
      fireEvent.click(within(sessionRow(sessionName)).getByRole("button", { name: `More actions for ${sessionName}` }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: action }));
    });
  }

  it("archives a running session: stops its agent, keeps its conversation, and lists it under Archived", async () => {
    await renderApp();
    const sessionId = await startNewSession();
    const spy = vi.spyOn(tauriInternals(), "invoke");

    await chooseFromMenu(FIRST_MESSAGE, "Archive");

    expect(spy).toHaveBeenCalledWith("terminate_session", { sessionId }, undefined);
    expect(spy.mock.calls.some(([cmd]) => cmd === "delete_transcript")).toBe(false);
    await waitFor(() => {
      const [saved] = fakeStore().state.sessions as { archivedAt?: number; status: string }[];
      expect(saved.archivedAt).toEqual(expect.any(Number));
      expect(saved.status).toBe("terminated");
    });
    await act(async () => {
      fireEvent.click(sidebar().getByRole("button", { name: "Archived (1)" }));
    });
    expect(within(sidebar().getByRole("list", { name: "Archived sessions" })).getByText(FIRST_MESSAGE)).toBeDefined();
  });

  it("pins a session to the top of the sidebar", async () => {
    fakeStore().state.sessions = [seedSession("s-old", "Refactor parser", 1000), seedSession("s-new", "Fix login", 2000)];
    await renderApp();

    await chooseFromMenu("Refactor parser", "Pin");

    expect(within(sidebar().getByRole("list", { name: "Pinned sessions" })).getByText("Refactor parser")).toBeDefined();
    await waitFor(() =>
      expect((fakeStore().state.sessions as { id: string; pinned?: boolean }[]).find((s) => s.id === "s-old")?.pinned).toBe(true)
    );
  });

  it("keeps a numbered name the user chose when the first message is sent", async () => {
    fakeStore().state.sessions = [
      { ...seedSession("s-mine", "Session #42", 1000), status: "running", namedByUser: true },
      { ...seedSession("s-auto", "Session #7", 2000), status: "running" },
    ];
    await renderApp();
    const sendFrom = async (name: string, text: string) => {
      await act(async () => {
        fireEvent.click(sidebar().getByText(name));
      });
      const composer = screen.getByRole("textbox", { name: "Prompt" });
      await act(async () => {
        fireEvent.change(composer, { target: { value: text } });
        fireEvent.keyDown(composer, { key: "Enter" });
      });
    };

    await sendFrom("Session #42", "first question");
    await sendFrom("Session #7", "second question");

    expect(sidebar().getByText("Session #42")).toBeDefined();
    // A numbered name the app gave still takes its title from the first message.
    expect(await sidebar().findByText("second question")).toBeDefined();
  });

  it("keeps a session listed when its agent cannot be stopped for archiving", async () => {
    await renderApp();
    await startNewSession();
    vi.spyOn(tauriInternals(), "invoke").mockImplementation((cmd, args) =>
      cmd === "terminate_session" ? Promise.reject("no such session") : fakeTauriInvoke(cmd, args)
    );

    await chooseFromMenu(FIRST_MESSAGE, "Archive");

    expect(sidebar().queryByRole("button", { name: /^Archived/ })).toBeNull();
    expect(within(sidebar().getByRole("list", { name: /^Sessions in/ })).getByText(FIRST_MESSAGE)).toBeDefined();
    expect(screen.getAllByRole("alert").map((a) => a.textContent).join(" ")).toContain("could not be stopped");
    await waitFor(() => {
      const [saved] = fakeStore().state.sessions as { archivedAt?: number | null }[];
      expect(saved).toBeDefined();
      expect(saved.archivedAt ?? null).toBeNull();
    });
  });

  it("brings an unarchived session back where it was, pinned if it was pinned", async () => {
    fakeStore().state.sessions = [
      { ...seedSession("s-pin", "Release notes", 1000), pinned: true },
      seedSession("s-plain", "Fix login", 2000),
    ];
    await renderApp();

    await chooseFromMenu("Release notes", "Archive");
    await chooseFromMenu("Fix login", "Archive");
    await act(async () => {
      fireEvent.click(sidebar().getByRole("button", { name: "Archived (2)" }));
    });
    await chooseFromMenu("Release notes", "Unarchive");
    await chooseFromMenu("Fix login", "Unarchive");

    expect(within(sidebar().getByRole("list", { name: "Pinned sessions" })).getByText("Release notes")).toBeDefined();
    expect(within(sidebar().getByRole("list", { name: /^Sessions in/ })).getByText("Fix login")).toBeDefined();
    expect(sidebar().queryByRole("button", { name: /^Archived/ })).toBeNull();
  });

  it("after an archive that waited for its agent, shows a session that is still listed", async () => {
    fakeStore().state.sessions = [
      { ...seedSession("s-a", "Alpha", 3000), status: "running" },
      seedSession("s-b", "Beta", 2000),
      seedSession("s-c", "Gamma", 1000),
    ];
    await renderApp();
    let finishStopping: () => void = () => {};
    vi.spyOn(tauriInternals(), "invoke").mockImplementation((cmd, args) =>
      cmd === "terminate_session"
        ? new Promise((resolve) => {
            finishStopping = () => resolve(undefined);
          })
        : fakeTauriInvoke(cmd, args)
    );
    expect(screen.getByRole("banner").textContent).toContain("Alpha");

    await chooseFromMenu("Alpha", "Archive");
    await chooseFromMenu("Beta", "Archive");
    await act(async () => {
      finishStopping();
    });

    // Beta was archived while Alpha's agent stopped, so Gamma is the one left to show.
    expect(screen.getByRole("banner").textContent).toContain("Gamma");
  });
});
