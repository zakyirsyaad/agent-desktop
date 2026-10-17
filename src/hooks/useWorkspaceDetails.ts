import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

/**
 * How long to wait before asking once more: a folder opened a moment ago may
 * not be registered with the backend yet, which then refuses it.
 */
const RETRY_DELAY_MS = 400;

/** Where a workspace lives ("~/developer") and its git branch, when it is a repository. */
export interface WorkspaceDetails {
  location: string;
  branch: string | null;
}

/**
 * The folder line and branch shown for `path`. The branch is read again
 * whenever the window regains focus, since it changes in a terminal or an
 * agent's hands while the app is in the background.
 */
export function useWorkspaceDetails(path: string | undefined): WorkspaceDetails | null {
  const [details, setDetails] = useState<{ path: string; value: WorkspaceDetails } | null>(null);

  useEffect(() => {
    if (!path) return;
    let isCancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const request = () =>
      invoke<WorkspaceDetails>('workspace_details', { path }).then((value) => {
        if (!isCancelled && value) setDetails({ path, value });
      });
    const load = () =>
      request().catch(() => {
        retryTimer = setTimeout(() => {
          // The line is only decoration, so a lasting failure leaves it out
          // and is logged for debugging rather than shown to the user.
          request().catch((error) => {
            if (!isCancelled) console.warn(`Could not read details of ${path}: ${String(error)}`);
          });
        }, RETRY_DELAY_MS);
      });
    load();
    window.addEventListener('focus', load);
    return () => {
      isCancelled = true;
      clearTimeout(retryTimer);
      window.removeEventListener('focus', load);
    };
  }, [path]);

  // Never show one folder's branch under another's name while it loads.
  return details && details.path === path ? details.value : null;
}
