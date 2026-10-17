import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useLatest } from './useLatest';

/** A branch's pull request and how its checks stand, as the backend reads it with the GitHub CLI. */
export interface PullRequestStatus {
  number: number;
  title: string;
  url: string;
  state: 'open' | 'merged' | 'closed' | string;
  isDraft: boolean;
  checks: { passing: number; failing: number; pending: number };
}

/** How often an open session's pull request is read again while the window shows it. */
const REFRESH_INTERVAL_MS = 60_000;

/**
 * The pull request for the branch checked out at `path` (the backend reads
 * it each time, so a branch the agent just made counts at once): read when
 * the path changes, when the window regains focus, when `refreshKey` changes
 * (an agent's turn ended: it may have pushed), and every minute. A failure
 * (gh not signed in, offline) shows no status and is reported once per folder
 * until a read succeeds again.
 */
export function usePullRequest(
  path: string | undefined,
  refreshKey: number,
  onError: (message: string) => void,
): PullRequestStatus | null {
  const [state, setState] = useState<{ path: string; pullRequest: PullRequestStatus | null } | null>(null);
  const onErrorRef = useLatest(onError);
  // Kept across refreshes, so a lasting failure is not reported again after every turn.
  const reportedRef = useRef(new Set<string>());

  useEffect(() => {
    if (!path) return;
    let isCancelled = false;
    let latestRead = 0;
    const load = () => {
      const read = ++latestRead;
      invoke<PullRequestStatus | null>('session_pull_request', { path })
        .then((pullRequest) => {
          if (isCancelled || read !== latestRead) return;
          reportedRef.current.delete(path);
          setState({ path, pullRequest: pullRequest ?? null });
        })
        .catch((error) => {
          if (isCancelled || read !== latestRead) return;
          // An unknown status is not shown as the last one seen.
          setState({ path, pullRequest: null });
          if (reportedRef.current.has(path)) return;
          reportedRef.current.add(path);
          onErrorRef.current(`Could not read the pull request: ${String(error)}`);
        });
    };
    load();
    window.addEventListener('focus', load);
    const timer = setInterval(load, REFRESH_INTERVAL_MS);
    return () => {
      isCancelled = true;
      window.removeEventListener('focus', load);
      clearInterval(timer);
    };
  }, [path, refreshKey, onErrorRef]);

  // Never show one folder's pull request under another while it loads.
  return state && state.path === path ? state.pullRequest : null;
}
