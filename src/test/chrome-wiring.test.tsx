import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, act, fireEvent, within } from "@testing-library/react";
import { fakeTauriInvoke, type FakeTauriStore } from "./setup";
import App from "../App";

type TauriInternals = { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };

function tauriInternals(): TauriInternals {
  return (window as unknown as { __TAURI_INTERNALS__: TauriInternals }).__TAURI_INTERNALS__;
}

function fakeStore(): FakeTauriStore {
  return (window as unknown as { __FAKE_TAURI_STORE__: FakeTauriStore }).__FAKE_TAURI_STORE__;
}

function seedSessions() {
  fakeStore().state.sessions = [
    { id: "s-a", name: "Alpha work", profileId: "claude-code", cwd: "/Users/test/developer/zorvo", status: "terminated", createdAt: 1 },
    { id: "s-b", name: "Beta work", profileId: "claude-code", cwd: "/Users/test/developer/zorvo", status: "terminated", createdAt: 2 },
  ];
}

async function renderApp() {
  await act(async () => {
    render(<App />);
  });
}

async function click(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element);
  });
}

function header() {
  return within(screen.getAllByRole("banner")[0]);
}

describe("Window chrome wiring", () => {
  afterEach(() => vi.restoreAllMocks());

  it("goes back and forward through the sessions the user viewed", async () => {
    seedSessions();
    await renderApp();
    const sessions = within(screen.getByRole("complementary"));

    await click(sessions.getByText("Alpha work"));
    expect(header().getByText("Alpha work")).toBeDefined();

    await click(header().getByRole("button", { name: "Back" }));
    expect(header().getByText("Beta work")).toBeDefined();

    await click(header().getByRole("button", { name: "Forward" }));
    expect(header().getByText("Alpha work")).toBeDefined();
  });

  it("shows the folder and branch of the session itself, not of the last chosen workspace", async () => {
    seedSessions();
    await renderApp();

    expect(header().getByText("Beta work")).toBeDefined();
    expect(header().getByText("zorvo")).toBeDefined();
    expect(await header().findByLabelText("Branch main")).toBeDefined();
  });

  it("opens the files of the folder the top bar names, which is the open session's", async () => {
    seedSessions();
    const spy = vi.spyOn(tauriInternals(), "invoke");
    await renderApp();
    // Folding another folder's sessions does not move the session's folder.
    await click(within(screen.getByRole("complementary")).getByRole("button", { name: "titan-investment" }));

    await click(header().getByRole("button", { name: "Toggle files panel" }));

    expect(header().getByText("zorvo")).toBeDefined();
    expect(spy).toHaveBeenCalledWith(
      "list_directory",
      expect.objectContaining({ root: "/Users/test/developer/zorvo" }),
      undefined,
    );
  });

  it("keeps Files for a session whose folder has left the recents", async () => {
    fakeStore().state.sessions = [
      { id: "s-old", name: "Old work", profileId: "claude-code", cwd: "/Users/test/developer/old-project", status: "terminated", createdAt: 1 },
    ];
    const spy = vi.spyOn(tauriInternals(), "invoke");
    await renderApp();

    await click(header().getByRole("button", { name: "Toggle files panel" }));

    expect(spy).toHaveBeenCalledWith(
      "list_directory",
      expect.objectContaining({ root: "/Users/test/developer/old-project" }),
      undefined,
    );
    expect(screen.getByRole("complementary", { name: "Files panel" }).textContent).toContain("old-project");
  });

  it("shows the diff totals as a chip that opens the diff view in place of the Changes panel", async () => {
    seedSessions();
    const stat = (path: string, added: number, removed: number) => ({ path, oldPath: null, kind: "modified", added, removed, isBinary: false });
    vi.spyOn(tauriInternals(), "invoke").mockImplementation((cmd, args) => {
      if (cmd === "session_changes") return Promise.resolve([{ path: "src/app.ts", oldPath: null, kind: "modified" }]);
      if (cmd === "session_diff_stats") return Promise.resolve([stat("src/app.ts", 2800, 30), stat("b.ts", 47, 5)]);
      if (cmd === "session_diff_targets") return Promise.resolve({ base: null });
      return fakeTauriInvoke(cmd, args);
    });
    await renderApp();

    await click(await header().findByRole("button", { name: "Toggle changes panel" }));
    expect(screen.getByRole("complementary", { name: "Changes panel" })).toBeDefined();
    await click(header().getByRole("button", { name: /2,847 lines added, 35 removed/ }));

    expect(screen.getByRole("complementary", { name: "Diff view" })).toBeDefined();
    expect(screen.queryByRole("complementary", { name: "Changes panel" })).toBeNull();

    await click(within(screen.getByRole("complementary", { name: "Diff view" })).getByRole("button", { name: /close/i }));
    expect(screen.queryByRole("complementary", { name: "Diff view" })).toBeNull();
    expect(screen.queryByRole("complementary", { name: "Changes panel" })).toBeNull();
  });

  it("opens the diff view from the chip even when it is already open", async () => {
    seedSessions();
    vi.spyOn(tauriInternals(), "invoke").mockImplementation((cmd, args) => {
      if (cmd === "session_diff_stats") return Promise.resolve([{ path: "a.ts", oldPath: null, kind: "modified", added: 4, removed: 1, isBinary: false }]);
      if (cmd === "session_diff_targets") return Promise.resolve({ base: null });
      return fakeTauriInvoke(cmd, args);
    });
    await renderApp();

    const chip = await header().findByRole("button", { name: /4 lines added, 1 removed/ });
    await click(chip);
    const reads = () => (tauriInternals().invoke as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter(([cmd]) => cmd === "session_changes").length;
    const readsBefore = reads();
    await click(header().getByRole("button", { name: /4 lines added, 1 removed/ }));

    expect(screen.getByRole("complementary", { name: "Diff view" })).toBeDefined();
    // Asking for the diff again reads it afresh.
    expect(reads()).toBeGreaterThan(readsBefore);
  });

  it("hides the chat while the diff view is expanded, and opens it unexpanded next time", async () => {
    seedSessions();
    vi.spyOn(tauriInternals(), "invoke").mockImplementation((cmd, args) => {
      if (cmd === "session_diff_stats") return Promise.resolve([{ path: "a.ts", oldPath: null, kind: "modified", added: 4, removed: 1, isBinary: false }]);
      if (cmd === "session_diff_targets") return Promise.resolve({ base: null });
      return fakeTauriInvoke(cmd, args);
    });
    await renderApp();
    const chat = () => document.querySelector("article") as HTMLElement;

    await click(await header().findByRole("button", { name: /4 lines added, 1 removed/ }));
    const diffView = () => within(screen.getByRole("complementary", { name: "Diff view" }));
    await click(diffView().getByRole("button", { name: "Expand diff view" }));
    expect(chat().classList.contains("hidden")).toBe(true);

    await click(diffView().getByRole("button", { name: "Close diff view" }));
    expect(chat().classList.contains("hidden")).toBe(false);
    await click(header().getByRole("button", { name: /4 lines added, 1 removed/ }));
    expect(diffView().getByRole("button", { name: "Expand diff view" })).toBeDefined();
    expect(chat().classList.contains("hidden")).toBe(false);
  });

  it("shows the changes toggle without a count, and the session's changes in a panel that takes turns with Files", async () => {
    seedSessions();
    vi.spyOn(tauriInternals(), "invoke").mockImplementation((cmd, args) =>
      cmd === "session_changes"
        ? Promise.resolve([
            { path: "src/app.ts", oldPath: null, kind: "modified" },
            { path: "notes.md", oldPath: null, kind: "untracked" },
          ])
        : fakeTauriInvoke(cmd, args)
    );
    await renderApp();

    const toggle = await header().findByRole("button", { name: "Toggle changes panel" });
    expect(toggle.textContent).toBe("");
    const reads = () => (tauriInternals().invoke as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter(([cmd]) => cmd === "session_changes").length;
    const readsBefore = reads();
    await click(toggle);
    // Opening the panel reads the list afresh, not the one from before.
    expect(reads()).toBeGreaterThan(readsBefore);
    const panel = within(screen.getByRole("complementary", { name: "Changes panel" }));
    expect(panel.getByText("app.ts")).toBeDefined();

    await click(header().getByRole("button", { name: "Toggle files panel" }));
    expect(screen.queryByRole("complementary", { name: "Changes panel" })).toBeNull();
    expect(screen.getByRole("complementary", { name: "Files panel" })).toBeDefined();
  });

  it("lists the user's pull requests in the changes panel, read only while it is open, and opens one", async () => {
    seedSessions();
    const spy = vi.spyOn(tauriInternals(), "invoke").mockImplementation((cmd, args) => {
      if (cmd === "session_changes") return Promise.resolve([]);
      if (cmd === "repo_pull_requests") {
        return Promise.resolve([
          { number: 14, title: "Show PR status", url: "https://github.com/o/zorvo/pull/14", state: "merged", isDraft: false },
        ]);
      }
      if (cmd === "open_external_url") return Promise.resolve(undefined);
      return fakeTauriInvoke(cmd, args);
    });
    await renderApp();
    expect(spy.mock.calls.some(([cmd]) => cmd === "repo_pull_requests")).toBe(false);

    await click(await header().findByRole("button", { name: "Toggle changes panel" }));
    const panel = within(screen.getByRole("complementary", { name: "Changes panel" }));
    const list = within(await panel.findByRole("list", { name: "Pull requests" }));
    expect(spy).toHaveBeenCalledWith("repo_pull_requests", { path: "/Users/test/developer/zorvo" }, undefined);
    expect(list.getByText("zorvo #14")).toBeDefined();
    await click(list.getByRole("button", { name: /Show PR status/ }));

    expect(spy).toHaveBeenCalledWith(
      "open_external_url",
      { url: "https://github.com/o/zorvo/pull/14" },
      undefined,
    );
  });

  it("offers no changes panel for a folder that is not a git repository", async () => {
    seedSessions();
    const spy = vi.spyOn(tauriInternals(), "invoke").mockImplementation((cmd, args) =>
      cmd === "workspace_details" ? Promise.resolve({ location: "~/developer", branch: null }) : fakeTauriInvoke(cmd, args)
    );
    await renderApp();

    expect(header().queryByRole("button", { name: "Toggle changes panel" })).toBeNull();
    expect(spy.mock.calls.some(([cmd]) => cmd === "session_changes")).toBe(false);
  });

  it("shows the pull request for the session's branch and opens it", async () => {
    seedSessions();
    const spy = vi.spyOn(tauriInternals(), "invoke").mockImplementation((cmd, args) =>
      cmd === "session_pull_request"
        ? Promise.resolve({
            branch: "main",
            number: 7,
            title: "Changes panel",
            url: "https://github.com/o/r/pull/7",
            state: "open",
            isDraft: false,
            checks: { passing: 3, failing: 0, pending: 0 },
          })
        : fakeTauriInvoke(cmd, args)
    );
    await renderApp();

    const chip = await header().findByRole("button", { name: "Pull request #7, open, checks passing" });
    expect(spy).toHaveBeenCalledWith(
      "session_pull_request",
      { path: "/Users/test/developer/zorvo" },
      undefined,
    );
    await click(chip);

    expect(spy).toHaveBeenCalledWith("open_external_url", { url: "https://github.com/o/r/pull/7" }, undefined);
  });

  it("goes back from a new session to the session viewed last", async () => {
    seedSessions();
    await renderApp();
    const sessions = within(screen.getByRole("complementary"));
    await click(sessions.getByText("Alpha work"));

    await click(screen.getByRole("button", { name: "+ New session" }));
    expect(screen.getByRole("heading", { name: "New session" })).toBeDefined();
    await click(header().getByRole("button", { name: "Back" }));

    expect(header().getByText("Alpha work")).toBeDefined();
  });

  it("opens the workspace's files from the folder button, reveals it in Finder, and pops the session out", async () => {
    seedSessions();
    const spy = vi.spyOn(tauriInternals(), "invoke");
    await renderApp();

    await click(header().getByRole("button", { name: "Toggle files panel" }));
    const panel = within(screen.getByRole("complementary", { name: "Files panel" }));
    expect(spy).toHaveBeenCalledWith(
      "list_directory",
      expect.objectContaining({ root: "/Users/test/developer/zorvo" }),
      undefined,
    );
    await click(panel.getByRole("button", { name: "Reveal in Finder" }));
    expect(spy).toHaveBeenCalledWith("reveal_in_finder", { path: "/Users/test/developer/zorvo" }, undefined);

    await click(header().getByRole("button", { name: "Toggle files panel" }));
    expect(screen.queryByRole("complementary", { name: "Files panel" })).toBeNull();

    await click(header().getByRole("button", { name: "Popout window" }));
    expect(spy).toHaveBeenCalledWith("open_session_window", { sessionId: "s-b" }, undefined);
  });

  it("adds a file from the files panel to the prompt", async () => {
    vi.spyOn(tauriInternals(), "invoke").mockImplementation((cmd, args) =>
      cmd === "list_directory"
        ? Promise.resolve([{ name: "README.md", relativePath: "README.md", isDir: false }])
        : fakeTauriInvoke(cmd, args)
    );
    await renderApp();

    await click(header().getByRole("button", { name: "Toggle files panel" }));
    await click(await screen.findByRole("button", { name: "Add README.md to prompt" }));

    const prompt = screen.getByRole("textbox", { name: "Prompt" }) as HTMLTextAreaElement;
    expect(prompt.value).toContain("/Users/test/developer/ai-perpetual-trading/README.md");
  });

  it("shows the user's git identity and app version, and opens settings from the profile", async () => {
    await renderApp();
    const sidebar = within(screen.getByRole("complementary"));

    expect(sidebar.getByText("Test User")).toBeDefined();
    expect(sidebar.getByText(/0\.1\.0/)).toBeDefined();
    await click(sidebar.getByRole("button", { name: /^Settings/ }));
    expect(screen.getByRole("dialog")).toBeDefined();
  });
});
