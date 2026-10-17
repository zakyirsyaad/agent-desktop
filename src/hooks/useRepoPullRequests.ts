import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useLatest } from './useLatest';

/** One of the user's pull requests in a repository, as the backend lists it with the GitHub CLI. */
export interface PullRequestSummary {
  number: number;
  title: string;
  url: string;
  state: 'open' | 'merged' | 'closed' | string;
  isDraft: boolean;
}

/**
 * The pull requests the user opened in the repository at `path`, newest
 * first: read when the path changes and when `refreshKey` changes (an
 * agent's turn ended: it may have opened one). null while it loads, when
 * the folder is not on GitHub or gh is missing, and after a failure, which
 * is reported once per folder until a read succeeds again.
 */
export function useRepoPullRequests(
  path: string | undefined,
  refreshKey: number,
  onError: (message: string) => void,
): PullRequestSummary[] | null {
  const [state, setState] = useState<{ path: string; pullRequests: PullRequestSummary[] | null } | null>(null);
  const onErrorRef = useLatest(onError);
  const reportedRef = useRef(new Set<string>());

  useEffect(() => {
    if (!path) return;
    let isCancelled = false;
    invoke<PullRequestSummary[] | null>('repo_pull_requests', { path })
      .then((pullRequests) => {
        if (isCancelled) return;
        reportedRef.current.delete(path);
        setState({ path, pullRequests: pullRequests ?? null });
      })
      .catch((error) => {
        if (isCancelled) return;
        setState({ path, pullRequests: null });
        if (reportedRef.current.has(path)) return;
        reportedRef.current.add(path);
        onErrorRef.current(`Could not list the pull requests: ${String(error)}`);
      });
    return () => {
      isCancelled = true;
    };
  }, [path, refreshKey, onErrorRef]);

  // Never show one folder's list beside another while it loads.
  return state && state.path === path ? state.pullRequests : null;
}
