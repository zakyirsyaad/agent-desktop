import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { FileChange } from '../lib/git-changes';
import { useLatest } from './useLatest';

export interface SessionChanges {
  /** The uncommitted changes, or null before the first answer (or outside a repository). */
  changes: FileChange[] | null;
  /** Goes up with every list read, so what shows a file's diff knows to read it again. */
  version: number;
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
  const [state, setState] = useState<{ path: string; changes: FileChange[]; version: number } | null>(null);
  const [reloads, setReloads] = useState(0);
  const onErrorRef = useLatest(onError);
  const reload = useCallback(() => setReloads((n) => n + 1), []);

  useEffect(() => {
    if (!path || !isRepository) return;
    let isCancelled = false;
    let hasReported = false;
    // Reads can overlap (focus, a turn ending): only the latest one's answer is kept.
    let latestRead = 0;
    const load = () => {
      const read = ++latestRead;
      return invoke<FileChange[]>('session_changes', { path })
        .then((changes) => {
          if (isCancelled || read !== latestRead || !Array.isArray(changes)) return;
          setState((prev) => ({ path, changes, version: (prev?.version ?? 0) + 1 }));
        })
        .catch((error) => {
          if (isCancelled || hasReported) return;
          hasReported = true;
          onErrorRef.current(`Could not read the changes in ${path}: ${String(error)}`);
        });
    };
    load();
    window.addEventListener('focus', load);
    return () => {
      isCancelled = true;
      window.removeEventListener('focus', load);
    };
  }, [path, isRepository, refreshKey, reloads, onErrorRef]);

  // Never show one folder's changes under another while it loads.
  const isCurrent = isRepository && state !== null && state.path === path;
  return { changes: isCurrent ? state.changes : null, version: isCurrent ? state.version : 0, reload };
}
