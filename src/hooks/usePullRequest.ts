import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

/** A branch's pull request and how its checks stand, as the backend reads it with the GitHub CLI. */
export interface PullRequestStatus {
  /** The branch it was looked up for. */
  branch: string;
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
 * Failed reads in a row before the last pull request is no longer shown: one
 * slow `gh` after the Mac wakes is a blip, a lasting failure (signed out,
 * offline) would otherwise leave old checks on screen as if current.
 */
export const MAX_FAILED_READS = 3;

/**
 * The pull request for the branch checked out at `path` (the backend reads
 * it each time, so a branch the agent just made counts at once): read when
 * the path changes, when the window regains focus, when `refreshKey` changes
 * (an agent's turn ended: it may have pushed), and every minute.
 *
 * Every read is a background refresh, so a failure (gh not signed in, offline,
 * a timeout after the Mac wakes) is not shown as a notice: the last known pull
 * request stays, and the next tick or focus tries again. After
 * `MAX_FAILED_READS` failures in a row it is no longer shown.
 */
export function usePullRequest(
  path: string | undefined,
  /** The branch the top bar shows: a pull request is shown only beside its own branch. */
  branch: string | undefined,
  refreshKey: number,
): PullRequestStatus | null {
  const [state, setState] = useState<{ path: string; pullRequest: PullRequestStatus | null } | null>(null);

  useEffect(() => {
    if (!path) return;
    let isCancelled = false;
    let latestRead = 0;
    let failedReads = 0;
    const load = () => {
      const read = ++latestRead;
      invoke<PullRequestStatus | null>('session_pull_request', { path })
        .then((pullRequest) => {
          if (isCancelled || read !== latestRead) return;
          failedReads = 0;
          setState({ path, pullRequest: pullRequest ?? null });
        })
        .catch(() => {
          // A background read never interrupts, and an older answer that
          // arrives after a newer read started counts for nothing.
          if (isCancelled || read !== latestRead) return;
          failedReads += 1;
          if (failedReads >= MAX_FAILED_READS) setState({ path, pullRequest: null });
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
    // A new branch is read at once, not at the next refresh.
  }, [path, branch, refreshKey]);

  // Never show one folder's or branch's pull request beside another's while it loads.
  const pullRequest = state && state.path === path ? state.pullRequest : null;
  return pullRequest && pullRequest.branch === branch ? pullRequest : null;
}
