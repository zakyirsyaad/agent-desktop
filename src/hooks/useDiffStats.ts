import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { DiffTargetId, DiffTargets, FileStat } from '../lib/diff-stats';
import { useLatest } from './useLatest';

const NO_TARGETS: DiffTargets = { base: null };

export interface DiffTargetsRead {
  targets: DiffTargets;
  /** True once the read has answered or failed; until then `targets` has no base yet. */
  isLoaded: boolean;
}

/**
 * What the diff can be measured against in `path`'s repository. A failed read
 * counts as loaded without a base (HEAD still works) and is reported once per folder.
 */
export function useDiffTargets(
  path: string | undefined,
  isEnabled: boolean,
  version: number,
  onError: (message: string) => void,
): DiffTargetsRead {
  const [state, setState] = useState<{ path: string; targets: DiffTargets } | null>(null);
  const onErrorRef = useLatest(onError);
  const reportedPath = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!path || !isEnabled) return;
    let isCancelled = false;
    invoke<DiffTargets>('session_diff_targets', { path })
      .then((targets) => {
        if (!isCancelled && targets) setState({ path, targets });
      })
      .catch((error) => {
        if (isCancelled) return;
        setState({ path, targets: NO_TARGETS });
        if (reportedPath.current === path) return;
        reportedPath.current = path;
        onErrorRef.current(`Could not read the diff targets in ${path}: ${String(error)}`);
      });
    return () => {
      isCancelled = true;
    };
  }, [path, isEnabled, version, onErrorRef]);

  const isCurrent = isEnabled && state !== null && state.path === path;
  return { targets: isCurrent ? state.targets : NO_TARGETS, isLoaded: isCurrent };
}

export interface DiffStats {
  /** The files with line counts, or null before the first answer for this folder and target. */
  stats: FileStat[] | null;
  /** Goes up with every answer, so open file diffs know to read again. */
  statsVersion: number;
  reload: () => void;
}

/**
 * Per-file line counts of the changes in `path`'s repository against `target`.
 * Read again when `version` (the change list) or `target` changes, and on `reload`.
 * Nothing is read while `isEnabled` is false (outside a repository, or until the
 * diff targets are known). A failure is reported once per folder.
 */
export function useDiffStats(
  path: string | undefined,
  isEnabled: boolean,
  target: DiffTargetId,
  version: number,
  onError: (message: string) => void,
): DiffStats {
  const [state, setState] = useState<{ key: string; stats: FileStat[]; version: number } | null>(null);
  const [reloads, setReloads] = useState(0);
  const onErrorRef = useLatest(onError);
  const reportedPath = useRef<string | undefined>(undefined);
  const reload = useCallback(() => setReloads((n) => n + 1), []);
  const key = `${path}\0${target}`;

  useEffect(() => {
    if (!path || !isEnabled) return;
    let isCancelled = false;
    invoke<FileStat[]>('session_diff_stats', { path, target })
      .then((stats) => {
        if (isCancelled || !Array.isArray(stats)) return;
        setState((prev) => ({ key, stats, version: (prev?.version ?? 0) + 1 }));
      })
      .catch((error) => {
        if (isCancelled || reportedPath.current === path) return;
        reportedPath.current = path;
        onErrorRef.current(`Could not read the diff in ${path}: ${String(error)}`);
      });
    return () => {
      isCancelled = true;
    };
  }, [path, isEnabled, target, key, version, reloads, onErrorRef]);

  // Never show another folder's or target's files while this one loads.
  const isCurrent = isEnabled && state !== null && state.key === key;
  return { stats: isCurrent ? state.stats : null, statsVersion: isCurrent ? state.version : 0, reload };
}
