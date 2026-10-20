import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { fakeTauriInvoke } from "./setup";
import { SAVE_DEBOUNCE_MS, usePersistedState } from "../hooks/usePersistedState";

type TauriInternals = { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };

function tauriInternals(): TauriInternals {
  return (window as unknown as { __TAURI_INTERNALS__: TauriInternals }).__TAURI_INTERNALS__;
}

function savesOf(spy: { mock: { calls: unknown[][] } }) {
  return spy.mock.calls.filter(([cmd]) => cmd === "save_app_state");
}

describe("usePersistedState saveNow", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function loaded() {
    const spy = vi.spyOn(tauriInternals(), "invoke").mockImplementation((cmd, args) => fakeTauriInvoke(cmd, args));
    const hook = renderHook(() => usePersistedState(() => {}));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(hook.result.current.isLoaded).toBe(true);
    return { hook, spy };
  }

  it("writes at once, and the debounce does not write the same state again", async () => {
    const { hook, spy } = await loaded();

    await act(async () => {
      hook.result.current.updateState((prev) => ({ ...prev, settings: { ...prev.settings, agentVersions: { a: "1.1.0" } } }));
      await hook.result.current.saveNow();
    });

    expect(savesOf(spy)).toHaveLength(1);
    const saved = savesOf(spy)[0][1] as { state: { settings: { agentVersions?: Record<string, string> } } };
    expect(saved.state.settings.agentVersions).toEqual({ a: "1.1.0" });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS * 2);
    });
    expect(savesOf(spy)).toHaveLength(1);
  });

  it("does nothing when there is nothing new to write", async () => {
    const { hook, spy } = await loaded();
    await act(async () => {
      await hook.result.current.saveNow();
    });
    expect(savesOf(spy)).toHaveLength(0);
  });

  it("does nothing before the initial load", async () => {
    const spy = vi.spyOn(tauriInternals(), "invoke").mockImplementation((cmd, args) =>
      cmd === "load_app_state" ? new Promise(() => {}) : fakeTauriInvoke(cmd, args),
    );
    const hook = renderHook(() => usePersistedState(() => {}));
    await act(async () => {
      hook.result.current.updateState((prev) => ({ ...prev }));
      await hook.result.current.saveNow();
    });
    expect(savesOf(spy)).toHaveLength(0);
  });
});
