import type { Dispatch, SetStateAction } from 'react';
import type { AcpEngine } from './session-engine/useAcpEngine';
import type { PtyEngine } from './session-engine/usePtyEngine';
import type { NavigationHistory } from './useNavigationHistory';
import { useLatest } from './useLatest';
import { closeTurn } from '../lib/acp-events';
import { isAcpSession, isListed, mostRecentSessionId, removeSessionFrom } from '../lib/session-helpers';
import { removeSessionWorktree } from '../lib/session-worktree';
import type { ChatMessage, PersistedState, Session } from '../types';

export interface SessionActionsDeps {
  sessions: Session[];
  setActiveSessionId: Dispatch<SetStateAction<string>>;
  patchSession: (sessionId: string, patch: Partial<Session>) => void;
  updateState: (updater: (prev: PersistedState) => PersistedState) => void;
  updateMessages: (sessionId: string, updater: (prev: ChatMessage[]) => ChatMessage[]) => void;
  removeTranscript: (sessionId: string) => void;
  navigation: Pick<NavigationHistory, 'remove'>;
  acp: Pick<AcpEngine, 'stop'>;
  pty: Pick<PtyEngine, 'stop' | 'forget'>;
  onNotice: (message: string) => void;
}

export interface SessionActions {
  deleteSession: (sessionId: string) => void;
  renameSession: (sessionId: string, name: string) => void;
  pinSession: (sessionId: string, isPinned: boolean) => void;
  archiveSession: (sessionId: string, isArchived: boolean) => Promise<void>;
}

/** What the sidebar's session rows can do to a session: delete, rename, pin and archive. */
export function useSessionActions(deps: SessionActionsDeps): SessionActions {
  const { sessions, setActiveSessionId, patchSession, acp, pty, onNotice } = deps;
  const sessionsRef = useLatest(sessions);
  const sessionById = (sessionId: string) => sessions.find((s) => s.id === sessionId);

  /** Ends a session's agent when it runs; resolves with whether it is stopped. */
  const stopAgent = (session: Session | undefined): Promise<boolean> => {
    if (session?.status !== 'running') return Promise.resolve(true);
    return isAcpSession(session) ? acp.stop(session.id) : pty.stop(session.id);
  };

  /**
   * After a session leaves the list, the most recent listed one is shown if it
   * was. Read from the latest sessions: an archive may have waited for its
   * agent while other sessions were archived or deleted.
   */
  const selectNextAfter = (sessionId: string) =>
    setActiveSessionId((current) =>
      current === sessionId
        ? mostRecentSessionId(sessionsRef.current.filter((s) => s.id !== sessionId && isListed(s)))
        : current,
    );

  const deleteSession = (sessionId: string) => {
    const session = sessionById(sessionId);
    const stopped = stopAgent(session);
    pty.forget(sessionId);
    deps.navigation.remove(sessionId);
    deps.updateState((prev) => removeSessionFrom(prev, sessionId));
    deps.removeTranscript(sessionId);
    if (session) {
      void removeSessionWorktree(session, sessions, stopped).then((kept) => kept && onNotice(kept));
    }
    selectNextAfter(sessionId);
  };

  const renameSession = (sessionId: string, name: string) => patchSession(sessionId, { name, namedByUser: true });

  const pinSession = (sessionId: string, isPinned: boolean) => patchSession(sessionId, { pinned: isPinned });

  /**
   * Archiving hides a session and ends its agent; its conversation and pin
   * stay, and an ACP session can be continued after unarchiving it. A session
   * whose agent cannot be stopped stays listed, so nothing runs out of sight.
   */
  const archiveSession = async (sessionId: string, isArchived: boolean) => {
    if (!isArchived) {
      patchSession(sessionId, { archivedAt: null });
      return;
    }
    const session = sessionById(sessionId);
    const isRunning = session?.status === 'running';
    if (!(await stopAgent(session))) {
      onNotice(`Did not archive "${session?.name ?? 'the session'}": its agent could not be stopped.`);
      return;
    }
    // A stopped agent ends no turn itself: requests it was waiting on are answered as closed.
    if (isRunning) deps.updateMessages(sessionId, closeTurn);
    const now = Date.now();
    patchSession(sessionId, { archivedAt: now, ...(isRunning ? { status: 'terminated', endedAt: now } : {}) });
    selectNextAfter(sessionId);
  };

  return { deleteSession, renameSession, pinSession, archiveSession };
}
