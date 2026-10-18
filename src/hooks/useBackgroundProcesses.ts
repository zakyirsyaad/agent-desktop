import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useLatest } from './useLatest';
import type { BackgroundProcess } from '../lib/background-tasks';

export const BACKGROUND_POLL_MS = 5000;
export const BACKGROUND_POLL_OPEN_MS = 2000;

/** `list` with each process's ports taken from `known` where it is listed. */
function withKnownPorts(list: BackgroundProcess[], known: readonly BackgroundProcess[]): BackgroundProcess[] {
  const ports = new Map(known.map((process) => [process.pid, process.ports]));
  return list.map((process) => ({ ...process, ports: ports.get(process.pid) ?? process.ports }));
}

/**
 * Polls the shell processes agents started while any session is alive, faster
 * while the background tasks menu is open. A tick is skipped while a read is
 * still running, so a scan slower than the interval is not superseded before
 * it answers; `reload` still starts a new read at once. A failed poll keeps
 * the previous list and is reported once, until a poll succeeds again.
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
    let isReading = false;
    const poll = () => {
      latestReadRef.current += 1;
      const readId = latestReadRef.current;
      isReading = true;
      // Ports are only shown in the open menu, and finding them is the slow part.
      invoke<BackgroundProcess[]>('background_processes', { withPorts: isMenuOpen })
        .then((list) => {
          if (isCancelled || readId !== latestReadRef.current) return;
          if (!Array.isArray(list)) throw new Error('expected a list of processes');
          hasReportedFailureRef.current = false;
          const readAt = Date.now();
          // Without ports, keep the ones last seen, so opening the menu shows them at once.
          setRead((prev) => ({ processes: isMenuOpen ? list : withKnownPorts(list, prev.processes), readAt }));
        })
        .catch((error) => {
          if (isCancelled || readId !== latestReadRef.current || hasReportedFailureRef.current) return;
          hasReportedFailureRef.current = true;
          onErrorRef.current?.(`Could not read background processes: ${String(error)}`);
        })
        .finally(() => {
          isReading = false;
        });
    };
    const tick = () => {
      if (!isReading) poll();
    };
    poll();
    const timer = setInterval(tick, isMenuOpen ? BACKGROUND_POLL_OPEN_MS : BACKGROUND_POLL_MS);
    return () => {
      isCancelled = true;
      clearInterval(timer);
    };
  }, [hasLiveSessions, isMenuOpen, reloads, onErrorRef]);

  const reload = useCallback(() => setReloads((n) => n + 1), []);

  return { processes: read.processes, readAt: read.readAt, reload };
}
