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

  it("asks for listening ports only while the menu is open", async () => {
    const spy = stub(() => Promise.resolve([PROC]));
    const { rerender } = renderHook(({ isOpen }) => useBackgroundProcesses(true, isOpen), {
      initialProps: { isOpen: false },
    });
    await advance(0);
    expect(spy).toHaveBeenLastCalledWith("background_processes", { withPorts: false }, undefined);

    rerender({ isOpen: true });
    await advance(0);
    expect(spy).toHaveBeenLastCalledWith("background_processes", { withPorts: true }, undefined);
  });

  it("keeps the ports it last saw while polling without them", async () => {
    const withPort = { ...PROC, ports: [5173] };
    vi.spyOn(internals(), "invoke").mockImplementation((_cmd, args) =>
      Promise.resolve([(args as { withPorts: boolean }).withPorts ? withPort : PROC]),
    );
    const { result, rerender } = renderHook(({ isOpen }) => useBackgroundProcesses(true, isOpen), {
      initialProps: { isOpen: true },
    });
    await advance(0);
    expect(result.current.processes[0].ports).toEqual([5173]);

    rerender({ isOpen: false });
    await advance(0);

    expect(result.current.processes[0].ports).toEqual([5173]);
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

  it("switches from 5s to 2s polling when the menu opens", async () => {
    const spy = stub(() => Promise.resolve([]));
    const { rerender } = renderHook(({ open }) => useBackgroundProcesses(true, open), { initialProps: { open: false } });
    await advance(0);
    rerender({ open: true });
    await advance(0);
    const before = spy.mock.calls.length;
    await advance(2_000);
    expect(spy.mock.calls.length).toBe(before + 1);
  });

  it("skips a tick while a read is still running, then polls on the next one", async () => {
    const resolvers: ((v: unknown) => void)[] = [];
    const spy = stub(() => new Promise((r) => resolvers.push(r)));
    const { result } = renderHook(() => useBackgroundProcesses(true, false));
    await advance(0);
    await advance(5_000);
    expect(spy).toHaveBeenCalledTimes(1);
    await act(async () => { resolvers[0]([PROC]); });
    expect(result.current.processes).toEqual([PROC]);
    await advance(5_000);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("ignores a read that resolves after a newer one", async () => {
    const resolvers: ((v: unknown) => void)[] = [];
    stub(() => new Promise((r) => resolvers.push(r)));
    const { result } = renderHook(() => useBackgroundProcesses(true, false));
    await advance(0);
    // A reload starts a new read even while the first is still running.
    act(() => result.current.reload());
    await advance(0);
    const B = { ...PROC, pid: 2 };
    await act(async () => { resolvers[1]([B]); });
    await act(async () => { resolvers[0]([PROC]); });
    expect(result.current.processes).toEqual([B]);
  });

  it("treats a non-list result as a failed poll", async () => {
    let bad = false;
    stub(() => Promise.resolve(bad ? undefined : [PROC]));
    const onError = vi.fn();
    const { result } = renderHook(() => useBackgroundProcesses(true, false, onError));
    await advance(0);
    bad = true;
    await advance(5_000);
    expect(result.current.processes).toEqual([PROC]);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("keeps the failure report once across effect restarts", async () => {
    let fail = true;
    stub(() => (fail ? Promise.reject(new Error("x")) : Promise.resolve([])));
    const onError = vi.fn();
    const { rerender, result } = renderHook(({ open }) => useBackgroundProcesses(true, open, onError), { initialProps: { open: false } });
    await advance(0);
    rerender({ open: true });
    await advance(0);
    act(() => result.current.reload());
    await advance(0);
    expect(onError).toHaveBeenCalledTimes(1);
    fail = false;
    await advance(2_000);
    fail = true;
    await advance(2_000);
    expect(onError).toHaveBeenCalledTimes(2);
  });
});
