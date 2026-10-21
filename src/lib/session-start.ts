import { titleFromPrompt } from './session-helpers';
import { fileNameOf } from './attachments';
import type { ListedSession } from './session-list';
import type { FirstMessage } from '../hooks/session-engine/useAcpEngine';
import { hasPendingElicitation } from './acp-elicitation';
import { isAwaitingPermission } from './acp-events';
import { createId } from './ids';
import {
  TRANSPORT_ACP,
  type AgentProfile,
  type ChatMessage,
  type Session,
  type SessionWorktree,
} from '../types';

/** A session title from a message, or from its first file when it has no text. */
export function titleFor({ text, attachments }: FirstMessage): string {
  return titleFromPrompt(text || fileNameOf(attachments?.[0] ?? ''));
}

/** What a new session is recorded and started with. */
export interface SessionSpec {
  id?: string;
  agent: AgentProfile;
  cwd: string;
  name: string;
  forkedFrom?: string;
  initialMessages?: ChatMessage[];
  worktree?: SessionWorktree | null;
  /** The agent's own session to reopen, for a session started outside Zorvo. */
  acpSessionId?: string;
}

/** The record of a session about to start: running, with the spec's agent and folder. */
export function newSessionRecord(spec: SessionSpec, createdAt: number = Date.now()): Session {
  const { id, agent, cwd, name, forkedFrom, worktree, acpSessionId } = spec;
  return {
    id: id ?? createId('s'),
    name,
    profileId: agent.id,
    cwd,
    status: 'running',
    createdAt,
    forkedFrom: forkedFrom ?? null,
    transport: TRANSPORT_ACP,
    worktree: worktree ?? null,
    acpSessionId: acpSessionId ?? null,
  };
}

/**
 * The record spec for a session the agent listed: its own title, or one made
 * from the agent and the day it was last used, so no row is ever blank.
 */
export function importedSessionSpec(
  listed: ListedSession,
  agent: AgentProfile,
  cwd: string,
  now: number = Date.now(),
): SessionSpec {
  // The first line that has text: a markdown title can run over several lines,
  // and a name is always one line.
  const firstLine = (listed.title ?? '')
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line !== '');
  const parsed = new Date(listed.updatedAt ?? now);
  // Rust accepts a leap second (`:60`), which Date reads as invalid: date it by the import time instead.
  const updatedAt = Number.isNaN(parsed.getTime()) ? new Date(now) : parsed;
  const date = updatedAt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  return {
    agent,
    cwd,
    name: firstLine ? titleFromPrompt(firstLine) : `${agent.name} session, ${date}`,
    acpSessionId: listed.acpSessionId,
  };
}

/**
 * Whether a session's agent waits for the user's answer: it stays busy while
 * it asks for permission, and an elicitation waits even between turns.
 * `isBusy` is asked only for a running session.
 */
export function isWaitingForAnswer(
  session: Session | undefined,
  messages: readonly ChatMessage[],
  isBusy: () => boolean,
): boolean {
  if (session?.status !== 'running') return false;
  return hasPendingElicitation(messages) || (isBusy() && isAwaitingPermission(messages));
}
