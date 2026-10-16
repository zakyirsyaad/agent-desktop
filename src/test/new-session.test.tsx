import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
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

  it("spawns the agent in the workspace's absolute path, not its display name", async () => {
    const invokeSpy = vi.spyOn(tauriInternals(), "invoke");

    await act(async () => {
      render(<App />);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "+ New session" }));
    });

    const spawnCall = invokeSpy.mock.calls.find(([cmd]) => cmd === "spawn_session");
    expect(spawnCall).toBeDefined();
    const cwd = (spawnCall?.[1] as { cwd: string }).cwd;
    expect(cwd.startsWith("/")).toBe(true);
    expect(cwd.endsWith("/ai-perpetual-trading")).toBe(true);
  });

  it("spawns by agent profile and options, never by a raw command", async () => {
    const invokeSpy = vi.spyOn(tauriInternals(), "invoke");

    await act(async () => {
      render(<App />);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "+ New session" }));
    });

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
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "+ New session" }));
    });

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
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "+ New session" }));
    });

    expect(screen.getByRole("alert").textContent).toContain("Failed to start");
  });

  it("warns instead of spawning when no workspace folder was discovered", async () => {
    const invokeSpy = stubInvoke({ list_workspaces: () => Promise.resolve([]) });

    await act(async () => {
      render(<App />);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "+ New session" }));
    });

    expect(screen.getByRole("alert").textContent).toContain("No workspace folder found");
    expect(invokeSpy.mock.calls.find(([cmd]) => cmd === "spawn_session")).toBeUndefined();
  });
});
