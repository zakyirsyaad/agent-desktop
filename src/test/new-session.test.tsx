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
});
