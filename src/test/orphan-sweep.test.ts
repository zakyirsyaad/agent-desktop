import { describe, it, expect, vi, afterEach } from "vitest";
import { orphanSweepDone, resetOrphanSweep, sweepOrphans, SWEEP_WAIT_LIMIT_MS } from "../lib/orphan-sweep";

type TauriInternals = { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };

function internals(): TauriInternals {
  return (window as unknown as { __TAURI_INTERNALS__: TauriInternals }).__TAURI_INTERNALS__;
}

/** Makes `end_orphaned_sessions` wait for the returned controls. */
function holdSweep() {
  const sweeps: { resolve: () => void; reject: (error: unknown) => void }[] = [];
  vi.spyOn(internals(), "invoke").mockImplementation((cmd) => {
    if (cmd !== "end_orphaned_sessions") return Promise.resolve(undefined);
    return new Promise((resolve, reject) => sweeps.push({ resolve: () => resolve(0), reject }));
  });
  return sweeps;
}

/** Whether `promise` settled within a bounded number of microtask turns (no timers: a pending sweep never settles). */
async function settles(promise: Promise<unknown>): Promise<boolean> {
  let settled = false;
  void promise.then(() => (settled = true));
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
  return settled;
}

afterEach(() => {
  vi.restoreAllMocks();
  resetOrphanSweep();
});

describe("orphan sweep", () => {
  it("waits for a pending sweep", async () => {
    const sweeps = holdSweep();
    void sweepOrphans();
    const done = orphanSweepDone();

    expect(await settles(done)).toBe(false);
    sweeps[0].resolve();
    expect(await settles(done)).toBe(true);
  });

  it("is done when the sweep fails, and still reports the failure to its caller", async () => {
    const sweeps = holdSweep();
    const caller = sweepOrphans();
    const failure = expect(caller).rejects.toBe("ps failed");
    const done = orphanSweepDone();

    sweeps[0].reject("ps failed");

    await failure;
    expect(await settles(done)).toBe(true);
  });

  it("is done at once when no sweep was started", async () => {
    expect(await settles(orphanSweepDone())).toBe(true);
  });

  it("stops waiting for a sweep that never ends, so nothing hangs forever", async () => {
    // A wedged ps or kill must not freeze every session start, terminal and sign-in.
    vi.useFakeTimers();
    try {
      holdSweep();
      void sweepOrphans();
      const done = orphanSweepDone();

      vi.advanceTimersByTime(SWEEP_WAIT_LIMIT_MS - 1);
      expect(await settles(done)).toBe(false);
      vi.advanceTimersByTime(1);
      expect(await settles(done)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for every sweep still running, not only the newest", async () => {
    // StrictMode runs App's mount effect twice: the first sweep can still be
    // ending sessions after the second one is done.
    const sweeps = holdSweep();
    void sweepOrphans();
    void sweepOrphans();
    const done = orphanSweepDone();

    sweeps[1].resolve();
    expect(await settles(done)).toBe(false);
    sweeps[0].resolve();
    expect(await settles(done)).toBe(true);
  });

  it("waits for the latest of two sweeps", async () => {
    const sweeps = holdSweep();
    void sweepOrphans();
    void sweepOrphans();
    const done = orphanSweepDone();

    sweeps[0].resolve();
    expect(await settles(done)).toBe(false);
    sweeps[1].resolve();
    expect(await settles(done)).toBe(true);
  });
});
