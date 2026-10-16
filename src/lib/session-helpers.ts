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
