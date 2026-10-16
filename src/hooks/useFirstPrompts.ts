import { useCallback, useEffect, useRef } from 'react';
import type { Session } from '../types';
import type { AgentActivity } from './useAgentActivity';

export interface FirstPrompts {
  /** Sends `prompt` to the session once its agent has started and gone quiet. */
  queue: (sessionId: string, prompt: string) => void;
  /** Call for every output chunk, so a session that printed nothing yet is not prompted. */
  noteOutput: (sessionId: string) => void;
  cancel: (sessionId: string) => void;
}

/**
 * Delivers a first prompt to a freshly started agent. Typing into an agent TUI
 * while it is still booting can be lost, so the prompt waits until the agent
 * produced output and then stayed idle (see `useAgentActivity`).
 */
export function useFirstPrompts(
  activity: AgentActivity,
  sessions: readonly Session[],
  send: (sessionId: string, prompt: string) => void,
): FirstPrompts {
  const pendingRef = useRef(new Map<string, string>());
  const startedRef = useRef(new Set<string>());

  const queue = useCallback((sessionId: string, prompt: string) => {
    pendingRef.current.set(sessionId, prompt);
  }, []);
  const noteOutput = useCallback((sessionId: string) => {
    startedRef.current.add(sessionId);
  }, []);
  const cancel = useCallback((sessionId: string) => {
    pendingRef.current.delete(sessionId);
  }, []);

  // Runs after every render: activity re-renders on busy/idle transitions.
  useEffect(() => {
    pendingRef.current.forEach((prompt, sessionId) => {
      const status = sessions.find((s) => s.id === sessionId)?.status;
      if (status === 'terminated') {
        pendingRef.current.delete(sessionId);
        return;
      }
      const isReady =
        status === 'running' && startedRef.current.has(sessionId) && !activity.isBusy(sessionId);
      if (!isReady) return;
      pendingRef.current.delete(sessionId);
      send(sessionId, prompt);
    });
  });

  return { queue, noteOutput, cancel };
}
