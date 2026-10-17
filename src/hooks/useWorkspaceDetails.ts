import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

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
    const load = () =>
      invoke<WorkspaceDetails>('workspace_details', { path })
        .then((value) => {
          if (!isCancelled && value) setDetails({ path, value });
        })
        // Only decoration: a folder the backend does not know yet (it was
        // just opened) or cannot read shows no line, and the next focus retries.
        .catch(() => {});
    load();
    window.addEventListener('focus', load);
    return () => {
      isCancelled = true;
      window.removeEventListener('focus', load);
    };
  }, [path]);

  // Never show one folder's branch under another's name while it loads.
  return details && details.path === path ? details.value : null;
}
