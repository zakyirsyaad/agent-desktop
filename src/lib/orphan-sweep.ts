import { invoke } from "@tauri-apps/api/core";

/**
 * Ends the agents and shells a previous UI left running. The backend lists
 * them when this call arrives and ends exactly those, so a session started
 * afterwards is never swept and nothing needs to wait for it. The promise
 * fails when the sweep could not be started, so the caller can say so.
 */
export function sweepOrphans(): Promise<void> {
  return invoke("end_orphaned_sessions").then(() => undefined);
}
