import { titleFromPrompt } from './session-helpers';
import { fileNameOf } from './attachments';
import type { SessionDraft } from './composer-controls';
import type { FirstMessage } from '../hooks/session-engine/useAcpEngine';
import { DEFAULT_PERMISSION_MODE, type AgentProfile, type SpawnOptions } from '../types';

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
