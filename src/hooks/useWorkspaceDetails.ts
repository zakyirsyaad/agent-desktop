import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useLatest } from './useLatest';

/** Where a workspace lives ("~/developer") and its git branch, when it is a repository. */
export interface WorkspaceDetails {
  location: string;
  branch: string | null;
}

/**
 * The folder line and branch shown for `path`. The branch is read again
 * whenever the window regains focus, since it changes in a terminal or an
 * agent's hands while the app is in the background. A folder that cannot be
 * read (it was moved or deleted) shows no line and is reported once.
 */
export function useWorkspaceDetails(
  path: string | undefined,
  onError: (message: string) => void,
): WorkspaceDetails | null {
  const [details, setDetails] = useState<{ path: string; value: WorkspaceDetails } | null>(null);
  const onErrorRef = useLatest(onError);

  useEffect(() => {
    if (!path) return;
    let isCancelled = false;
    let hasReported = false;
    const load = () =>
      invoke<WorkspaceDetails>('workspace_details', { path })
        .then((value) => {
          if (!isCancelled && value) setDetails({ path, value });
        })
        .catch((error) => {
          if (isCancelled || hasReported) return;
          hasReported = true;
          onErrorRef.current(`Could not read the folder ${path}: ${String(error)}`);
        });
    load();
    window.addEventListener('focus', load);
    return () => {
      isCancelled = true;
      window.removeEventListener('focus', load);
    };
  }, [path, onErrorRef]);

  // Never show one folder's branch under another's name while it loads.
  return details && details.path === path ? details.value : null;
}
