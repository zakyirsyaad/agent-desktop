import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { FileChange } from '../lib/git-changes';
import { useLatest } from './useLatest';

export interface SessionChanges {
  /** The uncommitted changes, or null before the first answer (or outside a repository). */
  changes: FileChange[] | null;
  reload: () => void;
}

/**
 * The uncommitted changes in the repository `path` is in, when `isRepository`.
 * They are read again when `refreshKey` changes (an agent's turn ended), when
 * the window regains focus, and on `reload`. A failure is reported once per folder.
 */
export function useSessionChanges(
  path: string | undefined,
  isRepository: boolean,
  refreshKey: number,
  onError: (message: string) => void,
): SessionChanges {
  const [state, setState] = useState<{ path: string; changes: FileChange[] } | null>(null);
  const [reloads, setReloads] = useState(0);
  const onErrorRef = useLatest(onError);
  const reload = useCallback(() => setReloads((n) => n + 1), []);

  useEffect(() => {
    if (!path || !isRepository) return;
    let isCancelled = false;
    let hasReported = false;
    const load = () =>
      invoke<FileChange[]>('session_changes', { path })
        .then((changes) => {
          if (!isCancelled && Array.isArray(changes)) setState({ path, changes });
        })
        .catch((error) => {
          if (isCancelled || hasReported) return;
          hasReported = true;
          onErrorRef.current(`Could not read the changes in ${path}: ${String(error)}`);
        });
    load();
    window.addEventListener('focus', load);
    return () => {
      isCancelled = true;
      window.removeEventListener('focus', load);
    };
  }, [path, isRepository, refreshKey, reloads, onErrorRef]);

  // Never show one folder's changes under another while it loads.
  return { changes: isRepository && state && state.path === path ? state.changes : null, reload };
}
