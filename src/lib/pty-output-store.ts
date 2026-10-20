/**
 * Raw output of sign-in terminals, kept in memory so a terminal opened (or
 * re-opened) later can replay what the login program drew before and stay in sync.
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

/** Enough scrollback for a long session; a terminal program redraws its screen often, so old output is rarely needed. */
const DEFAULT_MAX_CHARS = 2_000_000;

interface Buffer {
  chunks: string[];
  size: number;
}

/**
 * Output is kept as the chunks it arrived in and trimmed by whole chunks, so
 * appending stays cheap at the limit and a replay starts where a chunk did
 * rather than in the middle of an escape sequence.
 */
export function createPtyOutputStore({ maxChars = DEFAULT_MAX_CHARS } = {}): PtyOutputStore {
  const buffers = new Map<string, Buffer>();
  const listeners = new Map<string, Set<(data: string) => void>>();

  return {
    append(sessionId, data) {
      const buffer = buffers.get(sessionId) ?? { chunks: [], size: 0 };
      const chunk = data.length > maxChars ? data.slice(data.length - maxChars) : data;
      buffer.chunks.push(chunk);
      buffer.size += chunk.length;
      while (buffer.size > maxChars && buffer.chunks.length > 1) {
        buffer.size -= buffer.chunks.shift()?.length ?? 0;
      }
      buffers.set(sessionId, buffer);
      listeners.get(sessionId)?.forEach((listener) => listener(data));
    },
    snapshot: (sessionId) => buffers.get(sessionId)?.chunks.join('') ?? '',
    has: (sessionId) => buffers.has(sessionId),
    subscribe(sessionId, listener) {
      const set = listeners.get(sessionId) ?? new Set();
      set.add(listener);
      listeners.set(sessionId, set);
      return () => {
        set.delete(listener);
      };
    },
    forget(sessionId) {
      buffers.delete(sessionId);
      listeners.delete(sessionId);
    },
  };
}
