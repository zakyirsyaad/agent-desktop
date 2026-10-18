import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useBackgroundTasks } from "../hooks/useBackgroundTasks";
import type { BackgroundTask } from "../lib/background-tasks";
import type { Session } from "../types";

type TauriInternals = { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
const internals = () => (window as unknown as { __TAURI_INTERNALS__: TauriInternals }).__TAURI_INTERNALS__;

const SESSION: Session = { id: "s1", name: "Alpha", profileId: "p", cwd: "/w", status: "running", createdAt: 500 };
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

function task(over: Partial<BackgroundTask>): BackgroundTask {
  return { id: "x", kind: "agent", name: "Alpha", status: "Working", startedAt: 0, sessionId: "s1", ...over };
}

function setup(sessions: readonly Session[], onError = vi.fn(), onOpenSession = vi.fn()) {
  const hook = renderHook(
    ({ list }) =>
      useBackgroundTasks({
        sessions: list,
        isAcp: () => false,
        isBusy: () => false,
        busySince: () => undefined,
        needsApproval: () => false,
        onOpenSession,
        onError,
      }),
    { initialProps: { list: sessions } },
  );
  return { ...hook, onError, onOpenSession };
}

describe("useBackgroundTasks", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("stops each kind with its own command", async () => {
    const spy = vi.spyOn(internals(), "invoke").mockResolvedValue([]);
    const { result } = setup([SESSION]);
    await advance(0);
    const results: boolean[] = [];
    await act(async () => { results.push(await result.current.stop(task({ kind: "agent" }))); });
    await act(async () => { await result.current.stop(task({ kind: "terminal" })); });
    await act(async () => { await result.current.stop(task({ kind: "process", pid: 7 })); });
    expect(results).toEqual([true]);
    expect(spy).toHaveBeenCalledWith("acp_cancel", { sessionId: "s1" }, undefined);
    expect(spy).toHaveBeenCalledWith("terminate_session", { sessionId: "s1" }, undefined);
    expect(spy).toHaveBeenCalledWith("stop_background_process", { pid: 7 }, undefined);
  });

  it("reports a failed stop", async () => {
    vi.spyOn(internals(), "invoke").mockImplementation((cmd) =>
      cmd === "terminate_session" ? Promise.reject("boom") : Promise.resolve([]),
    );
    const { result, onError } = setup([SESSION]);
    let isStopped: boolean | undefined;
    await act(async () => { isStopped = await result.current.stop(task({ kind: "terminal", name: "Alpha" })); });
    expect(isStopped).toBe(false);
    expect(onError).toHaveBeenCalledWith("Could not stop Alpha: boom");
  });

  it("opens the task's session", () => {
    vi.spyOn(internals(), "invoke").mockResolvedValue([]);
    const { result, onOpenSession } = setup([]);
    act(() => result.current.open(task({ sessionId: "s9" })));
    expect(onOpenSession).toHaveBeenCalledWith("s9");
  });

  it("does not poll when no session is running", async () => {
    const spy = vi.spyOn(internals(), "invoke").mockResolvedValue([]);
    setup([{ ...SESSION, status: "idle" }]);
    await advance(10_000);
    expect(spy).not.toHaveBeenCalled();
  });

  it("keeps a process's start time when tasks recompute later", async () => {
    vi.setSystemTime(100_000);
    vi.spyOn(internals(), "invoke").mockResolvedValue([
      { pid: 11, sessionId: "s1", command: "npm run dev", elapsedSecs: 30, ports: [] },
    ]);
    const { result, rerender } = setup([SESSION]);
    await advance(0);
    const first = result.current.tasks.find((t) => t.id === "process:11")?.startedAt;
    expect(first).toBe(70_000);
    vi.setSystemTime(103_000);
    rerender({ list: [{ ...SESSION }] });
    expect(result.current.tasks.find((t) => t.id === "process:11")?.startedAt).toBe(first);
  });
});
