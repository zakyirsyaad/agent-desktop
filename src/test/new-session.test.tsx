import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, act, fireEvent, within } from "@testing-library/react";
import App from "../App";

type TauriInternals = { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };

function tauriInternals(): TauriInternals {
  return (window as unknown as { __TAURI_INTERNALS__: TauriInternals }).__TAURI_INTERNALS__;
}

describe("New session spawning", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Replaces the fake invoke for one command and delegates everything else to
   * the real test double from setup.ts.
   */
  function stubInvoke(
    overrides: Record<string, (args?: Record<string, unknown>) => Promise<unknown>>
  ) {
    const internals = tauriInternals();
    const originalInvoke = internals.invoke;
    return vi
      .spyOn(internals, "invoke")
      .mockImplementation((cmd: string, args?: Record<string, unknown>) => {
        const override = overrides[cmd];
        return override ? override(args) : originalInvoke(cmd, args);
      });
  }

  /** Opens a new session and sends its first message, which starts the agent. */
  async function startFromNew(text = "get started") {
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "+ New session" }));
    });
    await sendFirst(text);
  }

  async function sendFirst(text = "get started") {
    const prompt = screen.getByRole("textbox", { name: "Prompt" });
    await act(async () => {
      fireEvent.change(prompt, { target: { value: text } });
      fireEvent.keyDown(prompt, { key: "Enter" });
    });
  }

  it("spawns the agent in the workspace's absolute path, not its display name", async () => {
    const invokeSpy = vi.spyOn(tauriInternals(), "invoke");

    await act(async () => {
      render(<App />);
    });
    await startFromNew();

    const spawnCall = invokeSpy.mock.calls.find(([cmd]) => cmd === "spawn_session");
    expect(spawnCall).toBeDefined();
    const cwd = (spawnCall?.[1] as { cwd: string }).cwd;
    expect(cwd.startsWith("/")).toBe(true);
    expect(cwd.endsWith("/ai-perpetual-trading")).toBe(true);
  });

  it("does not start an agent until the new session's first message", async () => {
    const invokeSpy = vi.spyOn(tauriInternals(), "invoke");
    await act(async () => {
      render(<App />);
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "+ New session" }));
    });

    expect(invokeSpy.mock.calls.find(([cmd]) => cmd === "spawn_session")).toBeUndefined();
    expect(screen.getByRole("heading", { name: "New session" })).toBeDefined();
    const workspace = within(await screen.findByRole("group", { name: "Workspace" }));
    expect(workspace.getByText("~/developer", { exact: false })).toBeDefined();
    expect(await workspace.findByLabelText("Branch main")).toBeDefined();
  });

  it("starts a session in the workspace and with the agent picked from its + menu", async () => {
    const invokeSpy = vi.spyOn(tauriInternals(), "invoke");
    await act(async () => {
      render(<App />);
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "New session in titan-investment" }));
    });
    const menu = within(screen.getByRole("menu", { name: "Agent for the new session in titan-investment" }));
    expect(menu.getAllByRole("menuitem")[0].textContent).toContain("Default");
    await act(async () => {
      fireEvent.click(menu.getByRole("menuitem", { name: /Oh-My-Pi/ }));
    });
    expect(screen.getByRole("button", { name: "Agent: Oh-My-Pi" })).toBeDefined();
    await sendFirst();

    const args = invokeSpy.mock.calls.find(([cmd]) => cmd === "spawn_session")?.[1] as { cwd: string; profileId: string };
    expect(args).toMatchObject({ cwd: "/Users/test/developer/titan-investment", profileId: "omp" });
    expect(await screen.findByRole("list", { name: "Sessions in titan-investment" })).toBeDefined();
  });

  it("starts in the folder and with the agent picked in the composer", async () => {
    const invokeSpy = vi.spyOn(tauriInternals(), "invoke");
    await act(async () => {
      render(<App />);
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Folder: ai-perpetual-trading" }));
    });
    await act(async () => {
      fireEvent.change(screen.getByRole("textbox", { name: "Search folders" }), { target: { value: "agent" } });
    });
    const folders = within(screen.getByRole("listbox", { name: "Recent folders" }));
    expect(folders.getAllByRole("option").map((o) => o.textContent)).toEqual(["agent-desktop"]);
    await act(async () => {
      fireEvent.click(folders.getByRole("option", { name: "agent-desktop" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Agent: Claude Code" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("option", { name: "Oh-My-Pi" }));
    });
    await sendFirst();

    const args = invokeSpy.mock.calls.find(([cmd]) => cmd === "spawn_session")?.[1] as { cwd: string; profileId: string };
    expect(args).toMatchObject({ cwd: "/Users/test/developer/agent-desktop", profileId: "omp" });
    // The pickers only belong to a session that has not started.
    expect(screen.queryByRole("button", { name: /^Folder:/ })).toBeNull();
  });

  it("forgets an agent picked for a new session once the user opens another session", async () => {
    (window as unknown as { __FAKE_TAURI_STORE__: { state: { sessions: unknown[] } } }).__FAKE_TAURI_STORE__.state.sessions = [
      { id: "s-old", name: "Old work", profileId: "claude-code", cwd: "/Users/test/developer/agent-desktop", status: "terminated", createdAt: 1 },
    ];
    const invokeSpy = vi.spyOn(tauriInternals(), "invoke");
    await act(async () => {
      render(<App />);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "+ New session" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Agent: Claude Code" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("option", { name: "Oh-My-Pi" }));
    });

    await act(async () => {
      fireEvent.click(within(screen.getByRole("complementary")).getByText("Old work"));
    });
    await sendFirst();

    const args = invokeSpy.mock.calls.find(([cmd]) => cmd === "spawn_session")?.[1] as { profileId: string };
    expect(args.profileId).toBe("claude-code");
  });

  it("spawns by agent profile and options, never by a raw command", async () => {
    const invokeSpy = vi.spyOn(tauriInternals(), "invoke");

    await act(async () => {
      render(<App />);
    });
    await startFromNew();

    const args = invokeSpy.mock.calls.find(([cmd]) => cmd === "spawn_session")?.[1] as {
      profileId: string;
      command?: string;
      options: { permissionMode: string; agentSessionId?: string };
    };
    expect(args.profileId).toBe("claude-code");
    expect(args.command).toBeUndefined();
    expect(args.options.permissionMode).toBe("ask");
    // Claude Code takes --session-id, so the app assigns one up front for native forks later.
    expect(args.options.agentSessionId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("starts the next session with the model picked in the composer", async () => {
    const invokeSpy = vi.spyOn(tauriInternals(), "invoke");
    await act(async () => {
      render(<App />);
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^model:/i }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("option", { name: "opus" }));
    });
    await startFromNew();

    const args = invokeSpy.mock.calls.find(([cmd]) => cmd === "spawn_session")?.[1] as {
      options: { model?: string };
    };
    expect(args.options.model).toBe("opus");
  });

  it("surfaces an alert when the backend rejects the spawn cwd", async () => {
    stubInvoke({
      spawn_session: () =>
        Promise.reject(
          "Working directory '/Users/test/developer/ai-perpetual-trading' is not an existing directory"
        ),
    });

    await act(async () => {
      render(<App />);
    });
    await startFromNew();

    expect(screen.getByRole("alert").textContent).toContain("Failed to start");
  });

  it("warns instead of spawning when no project folder has been opened", async () => {
    (window as unknown as { __FAKE_TAURI_STORE__: { state: { recentFolders: unknown[] } } })
      .__FAKE_TAURI_STORE__.state.recentFolders = [];
    const invokeSpy = vi.spyOn(tauriInternals(), "invoke");

    await act(async () => {
      render(<App />);
    });
    await startFromNew();

    expect(screen.getByText("Open a project folder to start a session in it.")).toBeDefined();
    expect((screen.getByRole("textbox", { name: "Prompt" }) as HTMLTextAreaElement).disabled).toBe(true);
    expect(invokeSpy.mock.calls.find(([cmd]) => cmd === "spawn_session")).toBeUndefined();
  });
});
