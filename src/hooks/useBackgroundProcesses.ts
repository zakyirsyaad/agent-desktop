import { useCallback, useEffect, useRef, useState } from 'react';
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
): { processes: BackgroundProcess[]; readAt: number; reload: () => void } {
  const [read, setRead] = useState<{ processes: BackgroundProcess[]; readAt: number }>({ processes: [], readAt: 0 });
  const latestReadRef = useRef(0);
  const hasReportedFailureRef = useRef(false);
  const [reloads, setReloads] = useState(0);
  const onErrorRef = useLatest(onError);

  useEffect(() => {
    if (!hasLiveSessions) {
      setRead((prev) => (prev.processes.length === 0 ? prev : { processes: [], readAt: Date.now() }));
      return;
    }
    let isCancelled = false;
    const poll = () => {
      latestReadRef.current += 1;
      const readId = latestReadRef.current;
      invoke<BackgroundProcess[]>('background_processes')
        .then((list) => {
          if (isCancelled || readId !== latestReadRef.current) return;
          hasReportedFailureRef.current = false;
          setRead({ processes: list, readAt: Date.now() });
        })
        .catch((error) => {
          if (isCancelled || readId !== latestReadRef.current || hasReportedFailureRef.current) return;
          hasReportedFailureRef.current = true;
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

  return { processes: read.processes, readAt: read.readAt, reload };
}
