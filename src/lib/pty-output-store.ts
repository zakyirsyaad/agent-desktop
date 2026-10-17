/**
 * Raw output of terminal sessions, kept in memory so a terminal opened (or
 * re-opened) later can replay what the agent drew before and stay in sync.
 *
 * Replay and subscription happen synchronously in one task, so a terminal
 * never misses or repeats a chunk between the two.
 */
export interface PtyOutputStore {
  append: (sessionId: string, data: string) => void;
  snapshot: (sessionId: string) => string;
  has: (sessionId: string) => boolean;
  subscribe: (sessionId: string, listener: (data: string) => void) => () => void;
  forget: (sessionId: string) => void;
}

/** Enough scrollback for a long session; a TUI redraws its screen often, so old output is rarely needed. */
const DEFAULT_MAX_CHARS = 2_000_000;

export function createPtyOutputStore({ maxChars = DEFAULT_MAX_CHARS } = {}): PtyOutputStore {
  const outputs = new Map<string, string>();
  const listeners = new Map<string, Set<(data: string) => void>>();

  return {
    append(sessionId, data) {
      const next = (outputs.get(sessionId) ?? '') + data;
      outputs.set(sessionId, next.length > maxChars ? next.slice(next.length - maxChars) : next);
      listeners.get(sessionId)?.forEach((listener) => listener(data));
    },
    snapshot: (sessionId) => outputs.get(sessionId) ?? '',
    has: (sessionId) => outputs.has(sessionId),
    subscribe(sessionId, listener) {
      const set = listeners.get(sessionId) ?? new Set();
      set.add(listener);
      listeners.set(sessionId, set);
      return () => {
        set.delete(listener);
      };
    },
    forget(sessionId) {
      outputs.delete(sessionId);
      listeners.delete(sessionId);
    },
  };
}
