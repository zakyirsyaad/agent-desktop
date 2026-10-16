import { useCallback, useRef, useState } from "react";
import {
  canStepBack,
  canStepForward,
  createNavigationHistory,
  currentEntry,
  removeEntry,
  stepBack,
  stepForward,
  visitEntry,
  type NavigationHistoryState,
} from "../lib/navigation-history";

/** Back/forward navigation across the sessions the user has visited. */
export interface NavigationHistory {
  /** The session being viewed, or null when nothing is on screen. */
  current: string | null;
  /** Records a session as viewed, discarding any forward history. */
  visit: (id: string) => void;
  /** Steps to the older session and returns it, or null when there is none. */
  back: () => string | null;
  /** Steps to the newer session and returns it, or null when there is none. */
  forward: () => string | null;
  canGoBack: boolean;
  canGoForward: boolean;
  /** Drops a deleted session everywhere it appears in the history. */
  remove: (id: string) => void;
}

export function useNavigationHistory(initialId?: string): NavigationHistory {
  const [state, setState] = useState<NavigationHistoryState>(() =>
    createNavigationHistory(initialId)
  );

  // Mirror of the last committed state. React may defer a setState updater to
  // the next render, but back()/forward() have to return the session they just
  // stepped onto while the caller is still handling the click, so the step is
  // computed from this ref and then handed to React.
  const latest = useRef(state);

  const commit = useCallback((next: NavigationHistoryState) => {
    latest.current = next;
    setState(next);
  }, []);

  const visit = useCallback(
    (id: string) => {
      commit(visitEntry(latest.current, id));
    },
    [commit]
  );

  const back = useCallback(() => {
    const previous = latest.current;
    const next = stepBack(previous);
    commit(next);
    return next === previous ? null : currentEntry(next);
  }, [commit]);

  const forward = useCallback(() => {
    const previous = latest.current;
    const next = stepForward(previous);
    commit(next);
    return next === previous ? null : currentEntry(next);
  }, [commit]);

  const remove = useCallback(
    (id: string) => {
      commit(removeEntry(latest.current, id));
    },
    [commit]
  );

  return {
    current: currentEntry(state),
    visit,
    back,
    forward,
    canGoBack: canStepBack(state),
    canGoForward: canStepForward(state),
    remove,
  };
}
