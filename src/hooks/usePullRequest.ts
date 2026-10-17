import { useEffect, useState } from 'react';
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
 * The pull request for `branch` in the repository at `path`: read when they
 * change, when the window regains focus, when `refreshKey` changes (an
 * agent's turn ended: it may have pushed), and every minute. A failure (gh
 * not signed in, offline) shows no status and is reported once per branch.
 */
export function usePullRequest(
  path: string | undefined,
  branch: string | undefined,
  refreshKey: number,
  onError: (message: string) => void,
): PullRequestStatus | null {
  const [state, setState] = useState<{ key: string; pullRequest: PullRequestStatus | null } | null>(null);
  const onErrorRef = useLatest(onError);
  const key = path && branch ? `${path}\n${branch}` : null;

  useEffect(() => {
    if (!path || !branch || !key) return;
    let isCancelled = false;
    let hasReported = false;
    let latestRead = 0;
    const load = () => {
      const read = ++latestRead;
      invoke<PullRequestStatus | null>('session_pull_request', { path, branch })
        .then((pullRequest) => {
          if (!isCancelled && read === latestRead) setState({ key, pullRequest: pullRequest ?? null });
        })
        .catch((error) => {
          if (isCancelled || hasReported) return;
          hasReported = true;
          onErrorRef.current(`Could not read the pull request for ${branch}: ${String(error)}`);
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
  }, [path, branch, key, refreshKey, onErrorRef]);

  // Never show one branch's pull request under another while it loads.
  return state && state.key === key ? state.pullRequest : null;
}
