import { useCallback, useEffect, useRef, useState } from 'react';
import type { PersistedState } from '../types';
import { emptyPersistedState, loadAppState, saveAppState } from '../lib/persistence';
import { useLatest } from './useLatest';

/** Delay before writing state to disk, so bursts of updates cost one write. */
export const SAVE_DEBOUNCE_MS = 300;

export interface PersistedStateHandle {
  state: PersistedState;
  isLoaded: boolean;
  updateState: (updater: (prev: PersistedState) => PersistedState) => void;
  /** Writes the latest state now instead of after the debounce; resolves once it is on disk. */
  saveNow: () => Promise<void>;
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
      .then((loaded) => {
        if (isCancelled) return;
        lastSavedRef.current = loaded;
        canSaveRef.current = true;
        setState(loaded);
        setIsLoaded(true);
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
  const saveNow = useCallback((): Promise<void> => {
    const current = latestStateRef.current;
    if (!canSaveRef.current || current === lastSavedRef.current) return Promise.resolve();
    lastSavedRef.current = current;
    return saveAppState(current).catch((error) => {
      onErrorRef.current(`Failed to save sessions: ${String(error)}`);
    });
  }, [latestStateRef, onErrorRef]);

  useEffect(() => {
    const flush = () => void saveNow();
    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      window.removeEventListener('beforeunload', flush);
    };
  }, [saveNow]);

  // The ref moves on at once, so a `saveNow` right after an update already sees it.
  const updateState = useCallback(
    (updater: (prev: PersistedState) => PersistedState) => {
      const next = updater(latestStateRef.current);
      latestStateRef.current = next;
      setState(next);
    },
    [latestStateRef],
  );

  return { state, isLoaded, updateState, saveNow };
}
