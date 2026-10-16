import type { ActionCard, ChatMessage, PersistedState, Session } from '../types';

/** Id of the most recently created session, or "" when there is none. */
export function mostRecentSessionId(sessions: readonly Session[]): string {
  return sessions.reduce<Session | null>(
    (latest, s) => (latest === null || s.createdAt > latest.createdAt ? s : latest),
    null,
  )?.id ?? '';
}

export function patchSessionIn(
  state: PersistedState,
  sessionId: string,
  patch: Partial<Session>,
): PersistedState {
  return {
    ...state,
    sessions: state.sessions.map((s) => (s.id === sessionId ? { ...s, ...patch } : s)),
  };
}

export function removeSessionFrom(state: PersistedState, sessionId: string): PersistedState {
  return { ...state, sessions: state.sessions.filter((s) => s.id !== sessionId) };
}

export interface SessionGroup {
  path: string;
  name: string;
  sessions: Session[];
}

/** Last path segment, e.g. "/Users/a/project/" -> "project". */
export function folderNameOf(path: string): string {
  return path.split(/[\\/]+/).filter(Boolean).pop() ?? path;
}

/**
 * Groups sessions by their folder, newest session first inside a group. The
 * active folder's group comes first, the rest by their most recent session.
 */
export function groupSessionsByFolder(
  sessions: readonly Session[],
  activePath: string | undefined,
): SessionGroup[] {
  const byPath = new Map<string, Session[]>();
  for (const session of sessions) {
    byPath.set(session.cwd, [...(byPath.get(session.cwd) ?? []), session]);
  }
  const newestFirst = (a: Session, b: Session) => b.createdAt - a.createdAt;
  const groups = [...byPath.entries()].map(([path, list]) => ({
    path,
    name: folderNameOf(path),
    sessions: [...list].sort(newestFirst),
  }));
  const rank = (g: SessionGroup) => (g.path === activePath ? Infinity : g.sessions[0].createdAt);
  return groups.sort((a, b) => rank(b) - rank(a));
}

/** Sets the status of one action card (or every card when no id is given). */
export function setCardStatus(
  messages: readonly ChatMessage[],
  cardId: string | undefined,
  status: ActionCard['status'],
): ChatMessage[] {
  return messages.map((msg) => {
    if (!msg.actionCard) return msg;
    if (cardId && msg.actionCard.id !== cardId) return msg;
    return { ...msg, actionCard: { ...msg.actionCard, status } };
  });
}
