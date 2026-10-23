import { invoke } from "@tauri-apps/api/core";

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
 * Resolves once every sweep started so far has settled, or at once when none
 * was started. A session or shell started before a sweep ran would be ended by it.
 */
export function orphanSweepDone(): Promise<void> {
  return latest ?? Promise.resolve();
}

/** Forgets the sweep, for tests. */
export function resetOrphanSweep(): void {
  latest = null;
}
