import type { Session } from '../types';

/** One session an ACP agent listed, as the backend cleaned it. */
export interface ListedSession {
  acpSessionId: string;
  title?: string;
  updatedAt?: string;
}

/** What `acp_list_sessions` answers. */
export interface ListedSessions {
  sessions: ListedSession[];
  /** The page or session cap was reached. */
  truncated: boolean;
  /** A later page failed; the earlier ones are kept. */
  incomplete: boolean;
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === 'string';

/**
 * Validates the list an agent reported. The backend already cleans it; this is
 * the boundary the UI trusts, so it drops malformed entries rather than throw.
 */
export function toListedSessions(raw: unknown): ListedSessions {
  const answer = isObject(raw) ? raw : {};
  const sessions = Array.isArray(answer.sessions)
    ? answer.sessions.flatMap((entry): ListedSession[] => {
        if (!isObject(entry) || !isString(entry.acpSessionId) || entry.acpSessionId.trim() === '') return [];
        return [
          {
            acpSessionId: entry.acpSessionId,
            ...(isString(entry.title) && entry.title.trim() !== '' ? { title: entry.title } : {}),
            ...(isString(entry.updatedAt) && entry.updatedAt.trim() !== '' ? { updatedAt: entry.updatedAt } : {}),
          },
        ];
      })
    : [];
  return {
    sessions,
    truncated: typeof answer.truncated === 'boolean' ? answer.truncated : false,
    incomplete: typeof answer.incomplete === 'boolean' ? answer.incomplete : false,
  };
}

/**
 * The listed sessions worth offering: every one some Zorvo session does not
 * already hold (archived ones and other agents included), newest `updatedAt`
 * first, undated ones last in the agent's own order.
 */
export function sessionsToOffer(listed: readonly ListedSession[], sessions: readonly Session[]): ListedSession[] {
  const held = new Set(
    sessions.flatMap((session) =>
      isString(session.acpSessionId) && session.acpSessionId !== '' ? [session.acpSessionId] : [],
    ),
  );
  const available = listed.filter((entry) => !held.has(entry.acpSessionId));
  // A date the backend would not have kept counts as undated, so it falls in the agent's order.
  const dated: { entry: ListedSession; time: number }[] = [];
  const undated: ListedSession[] = [];
  for (const entry of available) {
    const time = entry.updatedAt === undefined ? Number.NaN : Date.parse(entry.updatedAt);
    if (Number.isNaN(time)) undated.push(entry);
    else dated.push({ entry, time });
  }
  // Array.prototype.sort is stable, so sessions with the same timestamp keep the agent's order.
  dated.sort((a, b) => b.time - a.time);
  return [...dated.map(({ entry }) => entry), ...undated];
}