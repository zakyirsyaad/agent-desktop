import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useBackgroundProcesses } from "../hooks/useBackgroundProcesses";

type TauriInternals = { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
const internals = () => (window as unknown as { __TAURI_INTERNALS__: TauriInternals }).__TAURI_INTERNALS__;

const PROC = { pid: 1, sessionId: "s", command: "x", elapsedSecs: 1, ports: [] };

function stub(impl: () => Promise<unknown>) {
  return vi.spyOn(internals(), "invoke").mockImplementation(() => impl());
}
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

describe("useBackgroundProcesses", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("does not poll when nothing is alive", async () => {
    const spy = stub(() => Promise.resolve([]));
    renderHook(() => useBackgroundProcesses(false, false));
    await advance(10_000);
    expect(spy).not.toHaveBeenCalled();
  });

  it("polls immediately, then every 5s", async () => {
    const spy = stub(() => Promise.resolve([PROC]));
    const { result } = renderHook(() => useBackgroundProcesses(true, false));
    await advance(0);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(result.current.processes).toEqual([PROC]);
    await advance(4_999);
    expect(spy).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("polls every 2s while the menu is open", async () => {
    const spy = stub(() => Promise.resolve([]));
    renderHook(() => useBackgroundProcesses(true, true));
    await advance(0);
    await advance(2_000);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("stops polling on unmount", async () => {
    const spy = stub(() => Promise.resolve([]));
    const { unmount } = renderHook(() => useBackgroundProcesses(true, false));
    await advance(0);
    unmount();
    await advance(20_000);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("reload polls again right away", async () => {
    const spy = stub(() => Promise.resolve([]));
    const { result } = renderHook(() => useBackgroundProcesses(true, false));
    await advance(0);
    act(() => result.current.reload());
    await advance(0);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("keeps the previous list and reports a failure once until a poll succeeds", async () => {
    let fail = false;
    stub(() => (fail ? Promise.reject(new Error("ps failed")) : Promise.resolve([PROC])));
    const onError = vi.fn();
    const { result } = renderHook(() => useBackgroundProcesses(true, false, onError));
    await advance(0);
    fail = true;
    await advance(5_000);
    await advance(5_000);
    expect(result.current.processes).toEqual([PROC]);
    expect(onError).toHaveBeenCalledTimes(1);
    fail = false;
    await advance(5_000);
    fail = true;
    await advance(5_000);
    expect(onError).toHaveBeenCalledTimes(2);
  });
});
