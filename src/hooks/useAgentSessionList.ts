import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentAuth } from './useAgentAuth';
import { useLatest } from './useLatest';
import { parseAuthRequired } from '../lib/acp-auth';
import { sessionsToOffer, type ListedSession, type ListedSessions } from '../lib/session-list';
import type { Session } from '../types';

/** What the draft's list of the agent's sessions shows. */
export type SessionListState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'loaded'; sessions: ListedSession[]; truncated: boolean; incomplete: boolean }
  | { kind: 'failed'; message: string };

export interface AgentSessionListDeps {
  /** The draft's agent; nothing is listed until one is picked. */
  profileId: string | undefined;
  /** The draft's folder; the agent lists only its sessions there. */
  cwd: string | undefined;
  /** The Zorvo sessions, so a session it already holds is not offered again. */
  sessions: readonly Session[];
  /** `acp_list_sessions`, as the backend validated it. */
  listSessions: (profileId: string, cwd: string) => Promise<ListedSessions>;
  /** The draft's sign-in panel: a list that needs a sign-in opens it instead of failing. */
  requestSignIn: AgentAuth['requestSignIn'];
}

function messageOf(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Whether two offered lists hold the same entries, in the same order. */
function sameSessions(a: readonly ListedSession[], b: readonly ListedSession[]): boolean {
  return a.length === b.length && a.every((entry, index) => entry === b[index]);
}

/**
 * Loads the agent's other sessions in the draft's folder, only when the user
 * asks, and keeps them apart from the ones Zorvo already holds. A late answer
 * for an agent or folder the draft has left is ignored, so it never shows
 * under the wrong draft. Memory only: changing the agent or folder starts over.
 */
export function useAgentSessionList({ profileId, cwd, sessions, listSessions, requestSignIn }: AgentSessionListDeps) {
  const [state, setState] = useState<SessionListState>({ kind: 'idle' });
  const [importError, setImportError] = useState<string | null>(null);
  // Only the latest load's answer lands; a new agent or folder invalidates the one in flight.
  const requestRef = useRef(0);
  // What the agent listed, before the sessions Zorvo already holds are dropped: re-filtered when `sessions` changes.
  const listedRef = useRef<{ profileId: string; cwd: string; listed: ListedSessions } | null>(null);
  const currentRef = useLatest({ profileId, cwd });
  const sessionsRef = useLatest(sessions);
  const listSessionsRef = useLatest(listSessions);
  const requestSignInRef = useLatest(requestSignIn);

  // A draft that changed its agent or folder starts over, and an answer for the old one is ignored.
  useEffect(() => {
    requestRef.current += 1;
    listedRef.current = null;
    setState({ kind: 'idle' });
    setImportError(null);
  }, [profileId, cwd]);

  // The agent's list minus what Zorvo holds: a session Zorvo gains drops its row.
  useEffect(() => {
    const listed = listedRef.current;
    if (!listed) return;
    setState((prev) => {
      if (prev.kind !== 'loaded') return prev;
      const offered = sessionsToOffer(listed.listed.sessions, sessions);
      return sameSessions(prev.sessions, offered) ? prev : { ...prev, sessions: offered };
    });
  }, [sessions]);

  const load = useCallback(() => {
    if (!profileId || !cwd) return;
    const request = ++requestRef.current;
    listedRef.current = null;
    setState({ kind: 'loading' });

    const isCurrent = () => {
      const now = currentRef.current;
      return request === requestRef.current && now.profileId === profileId && now.cwd === cwd;
    };

    listSessionsRef.current(profileId, cwd).then(
      (listed) => {
        if (!isCurrent()) return;
        listedRef.current = { profileId, cwd, listed };
        setState({
          kind: 'loaded',
          sessions: sessionsToOffer(listed.sessions, sessionsRef.current),
          truncated: listed.truncated,
          incomplete: listed.incomplete,
        });
      },
      (error: unknown) => {
        if (!isCurrent()) return;
        const methods = parseAuthRequired(error);
        if (methods) {
          requestSignInRef.current(profileId, cwd, methods);
          setState({ kind: 'idle' });
          return;
        }
        setState({ kind: 'failed', message: messageOf(error) });
      },
    );
  }, [profileId, cwd, currentRef, listSessionsRef, requestSignInRef, sessionsRef]);

  return { state, load, importError, setImportError };
}