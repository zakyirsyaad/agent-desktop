import { useEffect, useRef } from 'react';
import type { Session } from '../types';

/**
 * Marks a session unread when its agent stops working while another session
 * is open, and clears the mark when the session is opened. "Stops working"
 * is an ACP turn ending.
 */
export function useUnreadMarks(
  sessions: readonly Session[],
  activeSessionId: string,
  isSessionBusy: (sessionId: string) => boolean,
  patchSession: (sessionId: string, patch: Partial<Session>) => void,
): void {
  const busyIds = sessions.filter((s) => isSessionBusy(s.id)).map((s) => s.id);
  const busyKey = busyIds.join('\n');
  const wasBusyRef = useRef<ReadonlySet<string>>(new Set());

  useEffect(() => {
    const isBusy = new Set(busyKey ? busyKey.split('\n') : []);
    for (const sessionId of wasBusyRef.current) {
      if (!isBusy.has(sessionId) && sessionId !== activeSessionId) patchSession(sessionId, { hasUnread: true });
    }
    wasBusyRef.current = isBusy;
    // Only a change in who is working counts, not which session is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busyKey]);

  const isActiveUnread = sessions.find((s) => s.id === activeSessionId)?.hasUnread === true;
  useEffect(() => {
    if (isActiveUnread) patchSession(activeSessionId, { hasUnread: false });
  }, [isActiveUnread, activeSessionId, patchSession]);
}
