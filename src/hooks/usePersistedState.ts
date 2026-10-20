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
}

/**
 * Loads the app state once and saves every change with a debounce.
 *
 * Nothing is saved before the initial load finishes, so the empty pre-load
 * state can never overwrite what is on disk. If the load itself fails, saving
 * stays off for this run for the same reason.
 */
export function usePersistedState(onError: (message: string) => void): PersistedStateHandle {
  const [state, setState] = useState<PersistedState>(emptyPersistedState);
  const [isLoaded, setIsLoaded] = useState(false);
  const canSaveRef = useRef(false);
  const lastSavedRef = useRef<PersistedState | null>(null);
  const onErrorRef = useLatest(onError);

  useEffect(() => {
    let isCancelled = false;
    loadAppState()
      .then(({ state: loaded, isOutdated }) => {
        if (isCancelled) return;
        const { state: cleaned, droppedSessionIds } = dropTerminalSessions(loaded);
        // What differs from the file (an older version, dropped sessions) is written by the save effect.
        lastSavedRef.current = isOutdated ? null : loaded;
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

  useEffect(() => {
    if (!canSaveRef.current || state === lastSavedRef.current) return;
    const timer = setTimeout(() => {
      lastSavedRef.current = state;
      saveAppState(state).catch((error) => {
        onErrorRef.current(`Failed to save sessions: ${String(error)}`);
      });
    }, SAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [state, onErrorRef]);

  // A change made just before the window closes must not wait for the debounce.
  const latestStateRef = useLatest(state);
  useEffect(() => {
    const flush = () => {
      const current = latestStateRef.current;
      if (!canSaveRef.current || current === lastSavedRef.current) return;
      lastSavedRef.current = current;
      saveAppState(current).catch((error) => {
        onErrorRef.current(`Failed to save sessions: ${String(error)}`);
      });
    };
    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      window.removeEventListener('beforeunload', flush);
    };
  }, [latestStateRef, onErrorRef]);

  const updateState = useCallback(
    (updater: (prev: PersistedState) => PersistedState) => setState((prev) => updater(prev)),
    [],
  );

  return { state, isLoaded, updateState };
}
