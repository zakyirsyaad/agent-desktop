import { titleFromPrompt } from './session-helpers';
import { fileNameOf } from './attachments';
import type { FirstMessage } from '../hooks/session-engine/useAcpEngine';
import { isAwaitingUser } from './acp-elicitation';
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
}

/** The record of a session about to start: running, with the spec's agent and folder. */
export function newSessionRecord(spec: SessionSpec, createdAt: number = Date.now()): Session {
  const { id, agent, cwd, name, forkedFrom, worktree } = spec;
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
  };
}

/**
 * Whether a session's agent waits for the user's answer: it stays busy while
 * it asks. `isBusy` is asked only for a running session.
 */
export function isWaitingForAnswer(
  session: Session | undefined,
  messages: readonly ChatMessage[],
  isBusy: () => boolean,
): boolean {
  if (session?.status !== 'running') return false;
  return isBusy() && isAwaitingUser(messages);
}
