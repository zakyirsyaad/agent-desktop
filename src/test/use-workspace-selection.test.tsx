import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useWorkspaceSelection } from "../hooks/useWorkspaceSelection";
import type { PersistedState } from "../types";

type TauriInternals = { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };

function tauriInternals(): TauriInternals {
  return (window as unknown as { __TAURI_INTERNALS__: TauriInternals }).__TAURI_INTERNALS__;
}

const STATE: PersistedState = {
  version: 1,
  settings: { appearance: "system", defaultAgentId: null, onboardingCompleted: true },
  recentFolders: [
    { name: "api", path: "/w/api", lastOpenedAt: 2 },
    { name: "web", path: "/w/web", lastOpenedAt: 1 },
  ],
  sessions: [],
};

describe("useWorkspaceSelection", () => {
  afterEach(() => vi.restoreAllMocks());

  it("keeps a folder chosen while an earlier one was still being registered", async () => {
    let finishRegistering: () => void = () => {};
    vi.spyOn(tauriInternals(), "invoke").mockImplementation((cmd) =>
      cmd === "remember_workspace"
        ? new Promise((resolve) => {
            finishRegistering = () => resolve(undefined);
          })
        : Promise.resolve(undefined),
    );
    const { result } = renderHook(() => useWorkspaceSelection(STATE, true, () => {}, () => {}));

    act(() => result.current.rememberFolder({ name: "new", path: "/w/new" }));
    act(() => result.current.selectWorkspace("/w/web"));
    await act(async () => {
      finishRegistering();
    });

    expect(result.current.activeWorkspacePath).toBe("/w/web");
  });

  it("makes a newly opened folder active once it is registered", async () => {
    const { result } = renderHook(() => useWorkspaceSelection(STATE, true, () => {}, () => {}));

    await act(async () => {
      result.current.rememberFolder({ name: "new", path: "/w/new" });
    });

    expect(result.current.activeWorkspacePath).toBe("/w/new");
  });
});
