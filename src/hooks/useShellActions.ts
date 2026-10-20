import { invoke } from "@tauri-apps/api/core";

export interface ShellActions {
  /** A workspace's files for @-mentions; a failure is reported and offers none. */
  loadWorkspaceFiles: (root: string) => Promise<string[]>;
  revealFolder: (path: string) => void;
  /** Opens a session in its own window. */
  popout: (sessionId: string) => void;
}

/** Backend calls that open something outside the main view; each failure goes to `onNotice`. */
export function useShellActions(onNotice: (message: string) => void): ShellActions {
  return {
    loadWorkspaceFiles: (root) =>
      invoke<string[]>("workspace_files", { root }).catch((error) => {
        onNotice(`Could not list the files to mention: ${String(error)}`);
        return [];
      }),
    revealFolder: (path) => {
      invoke("reveal_in_finder", { path }).catch((error) => {
        onNotice(`Could not open the folder: ${String(error)}`);
      });
    },
    popout: (sessionId) => {
      invoke("open_session_window", { sessionId }).catch((error) => {
        onNotice(`Could not open a new window: ${String(error)}`);
      });
    },
  };
}
