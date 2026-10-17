import { titleFromPrompt } from './session-helpers';
import { fileNameOf } from './attachments';
import type { SessionDraft } from './composer-controls';
import type { FirstMessage } from '../hooks/session-engine/useAcpEngine';
import { isAwaitingPermission } from './acp-events';
import { createId } from './ids';
import {
  DEFAULT_PERMISSION_MODE,
  TRANSPORT_ACP,
  type AgentProfile,
  type ChatMessage,
  type Session,
  type SessionWorktree,
  type SpawnOptions,
} from '../types';

/** The choices for a new terminal session before the user changes any. */
export const EMPTY_DRAFT: SessionDraft = { permissionMode: DEFAULT_PERMISSION_MODE };

/** The CLI flags a terminal agent starts with, from the choices for it. */
export function spawnOptionsFor(agent: AgentProfile, draft: SessionDraft): SpawnOptions {
  return {
    model: draft.model,
    effort: draft.effort,
    permissionMode: draft.permissionMode,
    // Agents with a session-id flag get an id we choose, so they can be forked natively later.
    agentSessionId: agent.session_id_arg ? crypto.randomUUID() : undefined,
  };
}

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
  /** Terminal agents only: the CLI flags to start with. */
  options?: SpawnOptions;
  forkedFrom?: string;
  initialMessages?: ChatMessage[];
  worktree?: SessionWorktree | null;
}

/** The record of a session about to start: running, with the spec's agent, folder and flags. */
export function newSessionRecord(spec: SessionSpec, createdAt: number = Date.now()): Session {
  const { id, agent, cwd, name, options, forkedFrom, worktree } = spec;
  return {
    id: id ?? createId('s'),
    name,
    profileId: agent.id,
    cwd,
    status: 'running',
    createdAt,
    model: options?.model,
    effort: options?.effort,
    permissionMode: options?.permissionMode,
    agentSessionId: options?.agentSessionId ?? null,
    forkedFrom: forkedFrom ?? null,
    transport: agent.transport,
    worktree: worktree ?? null,
  };
}

/**
 * Whether a session's agent waits for the user's answer. An ACP agent stays
 * busy while it asks; a terminal agent goes quiet on its y/n prompt, so for
 * it a running session with an unanswered approval card is enough.
 */
export function isWaitingForAnswer(
  session: Session | undefined,
  messages: readonly ChatMessage[],
  isBusy: boolean,
): boolean {
  if (session?.status !== 'running') return false;
  return session.transport === TRANSPORT_ACP
    ? isBusy && isAwaitingPermission(messages)
    : isAwaitingPermission(messages, { includeTerminal: true });
}
