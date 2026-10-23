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

interface SetupOptions {
  needsApproval?: (sessionId: string) => boolean;
  stopAgent?: (sessionId: string) => void | Promise<void>;
}

function setup(sessions: readonly Session[], options: SetupOptions = {}) {
  const onError = vi.fn();
  const onOpenSession = vi.fn();
  const stopAgent = vi.fn(options.stopAgent ?? (() => undefined));
  const hook = renderHook(
    ({ list }) =>
      useBackgroundTasks({
        sessions: list,
        transcripts: {},
        isBusy: () => false,
        busySince: () => undefined,
        needsApproval: options.needsApproval ?? (() => false),
        onOpenSession,
        stopAgent,
        onError,
      }),
    { initialProps: { list: sessions } },
  );
  return { ...hook, onError, onOpenSession, stopAgent };
}

describe("useBackgroundTasks", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("stops each kind with its own command", async () => {
    const spy = vi.spyOn(internals(), "invoke").mockResolvedValue([]);
    const { result, stopAgent } = setup([SESSION]);
    await advance(0);
    const results: boolean[] = [];
    await act(async () => { results.push(await result.current.stop(task({ kind: "agent" }))); });
    await act(async () => { await result.current.stop(task({ kind: "shell", pid: 7 })); });
    expect(results).toEqual([true]);
    expect(stopAgent).toHaveBeenCalledWith("s1");
    expect(spy).not.toHaveBeenCalledWith("acp_cancel", expect.anything(), undefined);
    expect(spy).toHaveBeenCalledWith("stop_background_process", { pid: 7 }, undefined);
  });

  it("stops an agent waiting for approval through the app's interrupt, not a bare cancel", async () => {
    const spy = vi.spyOn(internals(), "invoke").mockResolvedValue([]);
    const { result, stopAgent } = setup([SESSION], { needsApproval: () => true });
    await advance(0);
    let isStopped: boolean | undefined;
    await act(async () => { isStopped = await result.current.stop(task({ kind: "agent", status: "Needs approval" })); });
    expect(isStopped).toBe(true);
    expect(stopAgent).toHaveBeenCalledTimes(1);
    expect(stopAgent).toHaveBeenCalledWith("s1");
    expect(spy.mock.calls.map(([cmd]) => cmd)).not.toContain("acp_cancel");
  });

  it("reports an agent stop that fails", async () => {
    vi.spyOn(internals(), "invoke").mockResolvedValue([]);
    const { result, onError } = setup([SESSION], { stopAgent: () => Promise.reject("gone") });
    let isStopped: boolean | undefined;
    await act(async () => { isStopped = await result.current.stop(task({ kind: "agent", name: "Alpha" })); });
    expect(isStopped).toBe(false);
    expect(onError).toHaveBeenCalledWith("Could not stop Alpha: gone");
  });

  it("reports a failed stop", async () => {
    vi.spyOn(internals(), "invoke").mockImplementation((cmd) =>
      cmd === "stop_background_process" ? Promise.reject("boom") : Promise.resolve([]),
    );
    const { result, onError } = setup([SESSION]);
    let isStopped: boolean | undefined;
    await act(async () => { isStopped = await result.current.stop(task({ kind: "shell", pid: 7, name: "Alpha" })); });
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
