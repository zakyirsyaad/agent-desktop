import { invoke } from "@tauri-apps/api/core";

/** How long a start waits for the sweep before going ahead anyway. */
export const SWEEP_WAIT_LIMIT_MS = 10_000;

/** Every sweep started so far, settled whether each worked or not. Null when none was started. */
let latest: Promise<void> | null = null;

/**
 * Ends the agents and shells a previous UI left running. The promise it
 * returns fails when the sweep fails, so the caller can say so; `orphanSweepDone`
 * does not.
 */
export function sweepOrphans(): Promise<void> {
  const sweep = invoke("end_orphaned_sessions").then(() => undefined);
  // An earlier sweep can still be ending sessions after this one is done
  // (StrictMode runs the mount effect twice), so the wait covers both.
  const earlier = latest ?? Promise.resolve();
  latest = Promise.all([earlier, sweep.catch(() => undefined)]).then(() => undefined);
  return sweep;
}

/**
 * Resolves once every sweep started so far has settled, at once when none was
 * started, or after `SWEEP_WAIT_LIMIT_MS` at the latest. A session or shell
 * started before a sweep ran would be ended by it.
 */
export function orphanSweepDone(): Promise<void> {
  const sweeps = latest;
  if (!sweeps) return Promise.resolve();
  // A sweep that never ends (a wedged ps or kill) must not freeze every start:
  // past the limit the wait gives up, and a start may then race the sweep.
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, SWEEP_WAIT_LIMIT_MS);
    void sweeps.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** Forgets the sweep, for tests. */
export function resetOrphanSweep(): void {
  latest = null;
}
