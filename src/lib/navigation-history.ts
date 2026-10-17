/**
 * Session back/forward history, reduced to plain data.
 *
 * Keeping the rules here instead of inside the hook means the cursor arithmetic
 * — which is easy to get subtly wrong when a session is deleted mid-history —
 * can be unit-tested without rendering React.
 *
 * Every function returns a new state and never mutates the one it was given.
 */

/** A snapshot of the history: the visited ids in order, plus a cursor into them. */
export interface NavigationHistoryState {
  readonly entries: readonly string[];
  /** Index into `entries` of the session being viewed, or -1 when empty. */
  readonly index: number;
}

/** Shared empty state. Frozen so a stray mutation fails loudly in development. */
const EMPTY_HISTORY: NavigationHistoryState = Object.freeze({
  entries: Object.freeze([]) as readonly string[],
  index: -1,
});

/** Builds the starting history, optionally already sitting on `initialId`. */
export function createNavigationHistory(
  initialId?: string
): NavigationHistoryState {
  return initialId ? visitEntry(EMPTY_HISTORY, initialId) : EMPTY_HISTORY;
}

/** The id currently being viewed, or null when there is nothing to view. */
export function currentEntry(state: NavigationHistoryState): string | null {
  if (state.index < 0) return null;
  return state.entries[state.index] ?? null;
}

/** Whether an older session exists to go back to. */
export function canStepBack(state: NavigationHistoryState): boolean {
  return state.index > 0;
}

/** Whether a newer session exists to go forward to. */
export function canStepForward(state: NavigationHistoryState): boolean {
  return state.index >= 0 && state.index < state.entries.length - 1;
}

/**
 * Records `id` as the session being viewed.
 *
 * Anything after the cursor is dropped, because stepping back and then opening
 * a different session starts a new branch — the abandoned forward entries no
 * longer describe a path the user can return along. Re-visiting the session
 * already on screen changes nothing at all.
 */
export function visitEntry(
  state: NavigationHistoryState,
  id: string
): NavigationHistoryState {
  if (currentEntry(state) === id) return state;

  const entries = [...state.entries.slice(0, state.index + 1), id];
  return { entries, index: entries.length - 1 };
}

/** Moves the cursor one session older, or returns the same state at the start. */
export function stepBack(state: NavigationHistoryState): NavigationHistoryState {
  if (!canStepBack(state)) return state;
  return { entries: state.entries, index: state.index - 1 };
}

/** Moves the cursor one session newer, or returns the same state at the end. */
export function stepForward(
  state: NavigationHistoryState
): NavigationHistoryState {
  if (!canStepForward(state)) return state;
  return { entries: state.entries, index: state.index + 1 };
}

/**
 * Drops every occurrence of a deleted session and keeps the cursor valid.
 *
 * Deleting the session on screen steps back onto the nearest surviving
 * predecessor; deleting one the user is not looking at leaves the visible
 * session alone and only shifts its index. Emptying the history yields a state
 * with no current session rather than an out-of-range cursor.
 */
export function removeEntry(
  state: NavigationHistoryState,
  id: string
): NavigationHistoryState {
  if (!state.entries.includes(id)) return state;

  const entries = state.entries.filter((entry) => entry !== id);
  if (entries.length === 0) return EMPTY_HISTORY;

  const cursor = Math.max(state.index, 0);
  const removedCurrent = state.entries[state.index] === id;
  // Survivors before the cursor decide where it lands: on the same session when
  // that one survived, otherwise on the last survivor before it.
  const keptBefore = state.entries
    .slice(0, cursor)
    .filter((entry) => entry !== id).length;
  const desired = removedCurrent ? keptBefore - 1 : keptBefore;
  const index = Math.min(Math.max(desired, 0), entries.length - 1);

  return { entries, index };
}
