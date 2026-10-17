import type { ActionCard, ChatMessage, PersistedState, Session } from '../types';
import { createId } from './ids';

/** Id of the most recently created session, or "" when there is none. */
export function mostRecentSessionId(sessions: readonly Session[]): string {
  return sessions.reduce<Session | null>(
    (latest, s) => (latest === null || s.createdAt > latest.createdAt ? s : latest),
    null,
  )?.id ?? '';
}

const SESSION_NUMBER = /^Session #(\d+)/;

/** "Session #N" with N above every number in use, so a name never repeats after a delete. */
export function nextSessionName(sessions: readonly Pick<Session, 'name'>[]): string {
  const highest = sessions.reduce((max, s) => Math.max(max, Number(SESSION_NUMBER.exec(s.name)?.[1] ?? 0)), 0);
  return `Session #${highest + 1}`;
}

const MAX_TITLE_LENGTH = 48;
const AUTO_NAME = /^Session #\d+$/;

/** True for a numbered placeholder name, which the first message replaces. */
export function isAutoName(name: string): boolean {
  return AUTO_NAME.test(name);
}

/** A session title from the user's prompt: its first line, cut at a word boundary. */
export function titleFromPrompt(prompt: string): string {
  const firstLine = prompt.trim().split('\n')[0].replace(/\s+/g, ' ').trim();
  if (!firstLine) return 'New session';
  if (firstLine.length <= MAX_TITLE_LENGTH) return firstLine;
  const cut = firstLine.slice(0, MAX_TITLE_LENGTH + 1);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > 0 ? cut.slice(0, lastSpace) : firstLine.slice(0, MAX_TITLE_LENGTH)).trimEnd()}…`;
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

/** A chat message the user typed. */
export function userMessage(content: string): ChatMessage {
  return { id: createId('msg'), role: 'user', content, timestamp: Date.now() };
}

/** Drops one message by id, e.g. a user message whose send failed. */
export function withoutMessage(messages: readonly ChatMessage[], messageId: string): ChatMessage[] {
  return messages.filter((m) => m.id !== messageId);
}

export function findCard(messages: readonly ChatMessage[] | undefined, cardId: string): ActionCard | undefined {
  return messages?.find((m) => m.actionCard?.id === cardId)?.actionCard;
}
