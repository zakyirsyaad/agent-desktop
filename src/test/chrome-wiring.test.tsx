import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, act, fireEvent, within } from "@testing-library/react";
import type { FakeTauriStore } from "./setup";
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
    { id: "s-a", name: "Alpha work", profileId: "claude-code", cwd: "/Users/test/developer/agent-desktop", status: "terminated", createdAt: 1 },
    { id: "s-b", name: "Beta work", profileId: "claude-code", cwd: "/Users/test/developer/agent-desktop", status: "terminated", createdAt: 2 },
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
  return within(screen.getByRole("banner"));
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
      expect.objectContaining({ root: "/Users/test/developer/ai-perpetual-trading" }),
      undefined,
    );
    await click(panel.getByRole("button", { name: "Reveal in Finder" }));
    expect(spy).toHaveBeenCalledWith("reveal_in_finder", { path: "/Users/test/developer/ai-perpetual-trading" }, undefined);

    await click(header().getByRole("button", { name: "Toggle files panel" }));
    expect(screen.queryByRole("complementary", { name: "Files panel" })).toBeNull();

    await click(header().getByRole("button", { name: "Popout window" }));
    expect(spy).toHaveBeenCalledWith("open_session_window", { sessionId: "s-b" }, undefined);
  });

  it("adds a file from the files panel to the prompt", async () => {
    const original = tauriInternals().invoke;
    vi.spyOn(tauriInternals(), "invoke").mockImplementation((cmd, args) =>
      cmd === "list_directory"
        ? Promise.resolve([{ name: "README.md", relativePath: "README.md", isDir: false }])
        : original(cmd, args)
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
    await click(sidebar.getByRole("button", { name: "Settings" }));
    expect(screen.getByRole("dialog")).toBeDefined();
  });
});
