import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { fakeTauriInvoke } from "./setup";
import type { PersistedState } from "../types";
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

  it("keeps both updates made either side of a re-render", async () => {
    const { hook } = await loaded();
    const mark = (key: string) => (prev: PersistedState) => ({
      ...prev,
      settings: { ...prev.settings, agentVersions: { ...prev.settings.agentVersions, [key]: "1" } },
    });

    act(() => hook.result.current.updateState(mark("a")));
    hook.rerender();
    act(() => hook.result.current.updateState(mark("b")));

    expect(hook.result.current.state.settings.agentVersions).toEqual({ a: "1", b: "1" });
  });

  it("builds an update issued right after the load resolves on the loaded state", async () => {
    let resolveLoad: (value: unknown) => void = () => {};
    vi.spyOn(tauriInternals(), "invoke").mockImplementation((cmd, args) =>
      cmd === "load_app_state" ? new Promise((resolve) => (resolveLoad = resolve)) : fakeTauriInvoke(cmd, args),
    );
    const hook = renderHook(() => usePersistedState(() => {}));
    const loadedState = structuredClone(
      (window as unknown as { __FAKE_TAURI_STORE__: { state: PersistedState } }).__FAKE_TAURI_STORE__.state,
    );

    await act(async () => {
      resolveLoad(loadedState);
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
      hook.result.current.updateState((prev) => ({ ...prev }));
    });

    expect(hook.result.current.state.recentFolders).toEqual(loadedState.recentFolders);
    expect(hook.result.current.state.recentFolders.length).toBeGreaterThan(0);
  });

  const mark = (key: string) => (prev: PersistedState) => ({
    ...prev,
    settings: { ...prev.settings, agentVersions: { ...prev.settings.agentVersions, [key]: "1" } },
  });
  const savedVersions = (call: unknown[]) =>
    (call[1] as { state: { settings: { agentVersions?: Record<string, string> } } }).state.settings.agentVersions;

  it("never writes an older state after saveNow, when the debounce fires before the render", async () => {
    const { hook, spy } = await loaded();
    act(() => hook.result.current.updateState(mark("a")));

    act(() => {
      hook.result.current.updateState(mark("b"));
      void hook.result.current.saveNow();
      vi.advanceTimersByTime(SAVE_DEBOUNCE_MS);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS * 2);
    });

    // An older state written after saveNow's would be on disk when a catalog action reads it.
    expect(savesOf(spy).map(savedVersions)).toEqual([{ a: "1", b: "1" }]);
  });

  it("never runs two writes at once", async () => {
    let inFlight = 0;
    let mostInFlight = 0;
    const pending: Array<() => void> = [];
    vi.spyOn(tauriInternals(), "invoke").mockImplementation((cmd, args) => {
      if (cmd !== "save_app_state") return fakeTauriInvoke(cmd, args);
      inFlight += 1;
      mostInFlight = Math.max(mostInFlight, inFlight);
      return new Promise<void>((resolve) =>
        pending.push(() => {
          inFlight -= 1;
          resolve();
        }),
      );
    });
    const hook = renderHook(() => usePersistedState(() => {}));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    let first: Promise<void> = Promise.resolve();
    let second: Promise<void> = Promise.resolve();
    await act(async () => {
      hook.result.current.updateState(mark("a"));
      first = hook.result.current.saveNow();
      await vi.advanceTimersByTimeAsync(0);
      hook.result.current.updateState(mark("b"));
      second = hook.result.current.saveNow();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(pending).toHaveLength(1);

    await act(async () => {
      pending.shift()?.();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(pending).toHaveLength(1);
    await act(async () => {
      pending.shift()?.();
      await Promise.all([first, second]);
    });

    expect(mostInFlight).toBe(1);
  });

  it("rejects saveNow when the write failed, and writes the state again next time", async () => {
    const spy = vi.spyOn(tauriInternals(), "invoke").mockImplementation((cmd, args) =>
      cmd === "save_app_state" ? Promise.reject("disk full") : fakeTauriInvoke(cmd, args),
    );
    const hook = renderHook(() => usePersistedState(() => {}));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    act(() => hook.result.current.updateState(mark("a")));
    await act(async () => {
      await expect(hook.result.current.saveNow()).rejects.toBe("disk full");
    });
    await act(async () => {
      await expect(hook.result.current.saveNow()).rejects.toBe("disk full");
    });

    expect(savesOf(spy)).toHaveLength(2);
  });

  it("reports a failed debounced write", async () => {
    vi.spyOn(tauriInternals(), "invoke").mockImplementation((cmd, args) =>
      cmd === "save_app_state" ? Promise.reject("disk full") : fakeTauriInvoke(cmd, args),
    );
    const onError = vi.fn();
    const hook = renderHook(() => usePersistedState(onError));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    act(() => hook.result.current.updateState(mark("a")));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
    });

    expect(onError).toHaveBeenCalledWith("Failed to save sessions: disk full");
  });
});
