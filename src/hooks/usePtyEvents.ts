import { useEffect } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { PtyExitPayload, PtyOutputPayload } from '../types';
import { useLatest } from './useLatest';

export interface PtyEventHandlers {
  onOutput: (sessionId: string, data: string) => void;
  onExit: (sessionId: string, exitCode: number) => void;
}

/**
 * Subscribes once to the backend PTY events for the lifetime of the component.
 *
 * Handlers are read through a ref, so re-renders never unsubscribe and
 * resubscribe: `listen` is async, and every resubscription opened a gap in
 * which output events were dropped.
 */
export function usePtyEvents(handlers: PtyEventHandlers): void {
  const handlersRef = useLatest(handlers);

  useEffect(() => {
    let isCancelled = false;
    const unlisteners: UnlistenFn[] = [];
    const keep = (unlisten: UnlistenFn) => {
      if (isCancelled) unlisten();
      else unlisteners.push(unlisten);
    };

    listen<PtyOutputPayload>('pty-output', ({ payload }) => {
      if (payload?.session_id && payload.data) {
        handlersRef.current.onOutput(payload.session_id, payload.data);
      }
    })
      .then(keep)
      .catch(() => {});

    listen<PtyExitPayload>('pty-exit', ({ payload }) => {
      if (payload?.session_id) {
        handlersRef.current.onExit(payload.session_id, payload.exit_code);
      }
    })
      .then(keep)
      .catch(() => {});

    return () => {
      isCancelled = true;
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, [handlersRef]);
}
