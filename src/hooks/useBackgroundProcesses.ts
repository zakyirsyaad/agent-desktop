import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useLatest } from './useLatest';
import type { BackgroundProcess } from '../lib/background-tasks';

export const BACKGROUND_POLL_MS = 5000;
export const BACKGROUND_POLL_OPEN_MS = 2000;

/**
 * Polls the shell processes agents started while any session is alive, faster
 * while the background tasks menu is open. A failed poll keeps the previous
 * list and is reported once, until a poll succeeds again.
 */
export function useBackgroundProcesses(
  hasLiveSessions: boolean,
  isMenuOpen: boolean,
  onError?: (message: string) => void,
): { processes: BackgroundProcess[]; reload: () => void } {
  const [processes, setProcesses] = useState<BackgroundProcess[]>([]);
  const [reloads, setReloads] = useState(0);
  const onErrorRef = useLatest(onError);

  useEffect(() => {
    if (!hasLiveSessions) {
      setProcesses((prev) => (prev.length === 0 ? prev : []));
      return;
    }
    let isCancelled = false;
    let hasReportedFailure = false;
    const poll = () => {
      invoke<BackgroundProcess[]>('background_processes')
        .then((list) => {
          if (isCancelled) return;
          hasReportedFailure = false;
          setProcesses(list);
        })
        .catch((error) => {
          if (isCancelled || hasReportedFailure) return;
          hasReportedFailure = true;
          onErrorRef.current?.(`Could not read background processes: ${String(error)}`);
        });
    };
    poll();
    const timer = setInterval(poll, isMenuOpen ? BACKGROUND_POLL_OPEN_MS : BACKGROUND_POLL_MS);
    return () => {
      isCancelled = true;
      clearInterval(timer);
    };
  }, [hasLiveSessions, isMenuOpen, reloads, onErrorRef]);

  const reload = useCallback(() => setReloads((n) => n + 1), []);

  return { processes, reload };
}
