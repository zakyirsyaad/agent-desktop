import { invoke } from "@tauri-apps/api/core";

/** The latest sweep, settled whether it worked or not. Null when none was started. */
let latest: Promise<void> | null = null;

/**
 * Ends the agents and shells a previous UI left running. The promise it
 * returns fails when the sweep fails, so the caller can say so; `orphanSweepDone`
 * does not.
 */
export function sweepOrphans(): Promise<void> {
  const sweep = invoke("end_orphaned_sessions").then(() => undefined);
  latest = sweep.catch(() => undefined);
  return sweep;
}

/**
 * Resolves once the latest sweep has settled, or at once when none was
 * started. A shell opened before the sweep ran would be ended by it.
 */
export function orphanSweepDone(): Promise<void> {
  return latest ?? Promise.resolve();
}

/** Forgets the sweep, for tests. */
export function resetOrphanSweep(): void {
  latest = null;
}
