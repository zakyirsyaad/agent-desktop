import type { ActionCard, ChatMessage, PersistedState, Session, Workspace } from '../types';
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

/** A session with the sessions forked from it, newest first. */
export interface SessionNode {
  session: Session;
  children: SessionNode[];
}

export interface SessionGroup {
  path: string;
  name: string;
  sessions: SessionNode[];
}

/** Last path segment, e.g. "/Users/a/project/" -> "project". */
export function folderNameOf(path: string): string {
  return path.split(/[\\/]+/).filter(Boolean).pop() ?? path;
}

const newestFirst = (a: Session, b: Session) => b.createdAt - a.createdAt;

/** Archived: hidden from the list, shown only in its Archived section. */
export function isArchived(session: Session): boolean {
  return Boolean(session.archivedAt);
}

/** Shown in the session list (pinned or in its workspace): not archived. */
export function isListed(session: Session): boolean {
  return !isArchived(session);
}

/** Shown in the Pinned section: pinned and not archived. An archived session keeps its pin for later. */
export function isShownPinned(session: Session): boolean {
  return Boolean(session.pinned) && !isArchived(session);
}

/** The workspace a session belongs to: the one its worktree was made from, or its folder. */
export function workspacePathOf(session: Session): string {
  return session.worktree?.repoPath ?? session.cwd;
}

/** One folder's sessions as a tree: a fork sits under its source when that is in the same folder. */
function forkTree(sessions: readonly Session[]): SessionNode[] {
  const ids = new Set(sessions.map((s) => s.id));
  const childrenOf = new Map<string, Session[]>();
  const roots: Session[] = [];
  for (const session of [...sessions].sort(newestFirst)) {
    const parent = session.forkedFrom;
    if (parent && parent !== session.id && ids.has(parent)) {
      childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), session]);
    } else {
      roots.push(session);
    }
  }
  const seen = new Set<string>();
  const toNode = (session: Session): SessionNode => {
    seen.add(session.id);
    const children = (childrenOf.get(session.id) ?? []).filter((c) => !seen.has(c.id));
    return { session, children: children.map(toNode) };
  };
  const tree = roots.map(toNode);
  // Sessions forked from each other in a loop (only a hand-edited file has
  // that) are reached from no root; each loop is listed from its newest one.
  for (const session of [...sessions].sort(newestFirst)) {
    if (!seen.has(session.id)) tree.push(toNode(session));
  }
  return tree;
}

/**
 * The sidebar's tree: every workspace in the given order, each with its
 * sessions newest first and forks nested under their source. Folders that
 * only sessions still point at (a folder removed from the recents) follow,
 * the one with the newest session first.
 */
export function groupSessionsByWorkspace(
  workspaces: readonly Workspace[],
  sessions: readonly Session[],
): SessionGroup[] {
  const byPath = new Map<string, Session[]>();
  const newestIn = new Map<string, number>();
  for (const session of sessions) {
    const path = workspacePathOf(session);
    const list = byPath.get(path);
    if (list) list.push(session);
    else byPath.set(path, [session]);
    newestIn.set(path, Math.max(newestIn.get(path) ?? -Infinity, session.createdAt));
  }
  const known = new Set(workspaces.map((ws) => ws.path));
  const others = [...byPath.keys()]
    .filter((path) => !known.has(path))
    .sort((a, b) => (newestIn.get(b) ?? 0) - (newestIn.get(a) ?? 0))
    .map((path) => ({ name: folderNameOf(path), path }));
  return [...workspaces, ...others].map(({ name, path }) => ({
    path,
    name,
    sessions: forkTree(byPath.get(path) ?? []),
  }));
}

/** A chat message the user typed, with the files they attached. */
export function userMessage(content: string, attachments: readonly string[] = []): ChatMessage {
  const message: ChatMessage = { id: createId('msg'), role: 'user', content, timestamp: Date.now() };
  return attachments.length > 0 ? { ...message, attachments: [...attachments] } : message;
}

/** Drops one message by id, e.g. a user message whose send failed. */
export function withoutMessage(messages: readonly ChatMessage[], messageId: string): ChatMessage[] {
  return messages.filter((m) => m.id !== messageId);
}

export function findCard(messages: readonly ChatMessage[] | undefined, cardId: string): ActionCard | undefined {
  return messages?.find((m) => m.actionCard?.id === cardId)?.actionCard;
}
