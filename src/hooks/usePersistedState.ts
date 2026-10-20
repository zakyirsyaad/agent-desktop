import { useCallback, useEffect, useRef, useState } from 'react';
import type { PersistedState } from '../types';
import { deleteTranscript, dropTerminalSessions, emptyPersistedState, loadAppState, saveAppState } from '../lib/persistence';
import { useLatest } from './useLatest';

/** Delay before writing state to disk, so bursts of updates cost one write. */
export const SAVE_DEBOUNCE_MS = 300;

export interface PersistedStateHandle {
  state: PersistedState;
  isLoaded: boolean;
  updateState: (updater: (prev: PersistedState) => PersistedState) => void;
  /**
   * Writes the latest state now instead of after the debounce; resolves once it is on disk
   * and rejects when the write failed, so a caller can say so where the user acted.
   */
  saveNow: () => Promise<void>;
}

/**
 * Loads the app state once and saves every change with a debounce.
 *
 * Nothing is saved before the initial load finishes, so the empty pre-load
 * state can never overwrite what is on disk. If the load itself fails, saving
 * stays off for this run for the same reason.
 *
 * Every write takes the newest state when its turn comes, and writes run one at a time,
 * so an older state can never land on disk after a newer one.
 */
export function usePersistedState(onError: (message: string) => void): PersistedStateHandle {
  const [state, setState] = useState<PersistedState>(emptyPersistedState);
  const [isLoaded, setIsLoaded] = useState(false);
  const canSaveRef = useRef(false);
  const lastSavedRef = useRef<PersistedState | null>(null);
  /** The newest state, written only by the load and by `updateState`: the one source of truth. */
  const latestStateRef = useRef<PersistedState>(state);
  /** The write running or queued last; the next one starts only after it settles. */
  const writeQueueRef = useRef<Promise<void>>(Promise.resolve());
  const onErrorRef = useLatest(onError);

  useEffect(() => {
    let isCancelled = false;
    loadAppState()
      .then(({ state: loaded, isOutdated }) => {
        if (isCancelled) return;
        const { state: cleaned, droppedSessionIds } = dropTerminalSessions(loaded);
        // What differs from the file (an older version, dropped sessions) is written by the save effect.
        lastSavedRef.current = isOutdated ? null : loaded;
        latestStateRef.current = cleaned;
        canSaveRef.current = true;
        setState(cleaned);
        setIsLoaded(true);
        for (const sessionId of droppedSessionIds) {
          deleteTranscript(sessionId).catch((error) => {
            onErrorRef.current(`Could not delete a removed terminal session: ${String(error)}`);
          });
        }
      })
      .catch((error) => {
        if (isCancelled) return;
        onErrorRef.current(`Failed to load saved sessions, changes will not be saved: ${String(error)}`);
        setIsLoaded(true);
      });
    return () => {
      isCancelled = true;
    };
  }, [onErrorRef]);

  /** Queues a write of the newest state behind any write still running. Rejects when it failed. */
  const writeLatest = useCallback((): Promise<void> => {
    const write = async () => {
      const current = latestStateRef.current;
      if (!canSaveRef.current || current === lastSavedRef.current) return;
      await saveAppState(current);
      lastSavedRef.current = current;
    };
    const written = writeQueueRef.current.then(write);
    writeQueueRef.current = written.catch(() => {
      // The caller of this write hears of the failure; the next write still runs.
    });
    return written;
  }, []);

  const reportFailedWrite = useCallback(
    (error: unknown) => onErrorRef.current(`Failed to save sessions: ${String(error)}`),
    [onErrorRef],
  );

  useEffect(() => {
    if (!canSaveRef.current || state === lastSavedRef.current) return;
    const timer = setTimeout(() => writeLatest().catch(reportFailedWrite), SAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [state, writeLatest, reportFailedWrite]);

  // A change made just before the window closes, or read by the backend right after, must not wait for the debounce.
  const saveNow = writeLatest;

  useEffect(() => {
    const flush = () => void saveNow().catch(reportFailedWrite);
    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      window.removeEventListener('beforeunload', flush);
    };
  }, [saveNow, reportFailedWrite]);

  // Every update builds on the ref, so none is lost to a render that skipped it, and a `saveNow` right after sees it.
  const updateState = useCallback(
    (updater: (prev: PersistedState) => PersistedState) => {
      const next = updater(latestStateRef.current);
      latestStateRef.current = next;
      setState(next);
    },
    [],
  );

  return { state, isLoaded, updateState, saveNow };
}
