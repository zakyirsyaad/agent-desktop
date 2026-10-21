import type { AcpEngine } from './session-engine/useAcpEngine';
import type { AgentAuth } from './useAgentAuth';
import { useLatest } from './useLatest';
import { parseAuthRequired } from '../lib/acp-auth';
import type { AcpChoices } from '../lib/acp-draft';
import { importedSessionSpec, type SessionSpec } from '../lib/session-start';
import type { ListedSession } from '../lib/session-list';
import type { AgentProfile, Session } from '../types';

function messageOf(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  return String(error);
}

export interface SessionImportDeps {
  /** The Zorvo sessions, so a session a listed id already belongs to is opened, not imported again. */
  sessions: readonly Session[];
  /** The draft's agent: the one the import runs in. */
  agent: AgentProfile | undefined;
  /** The draft's folder: where the agent's session is. */
  cwd: string | undefined;
  /** The session open now: a slow import that fails only returns to the draft when it is still this one. */
  activeSessionId: string;
  acp: Pick<AcpEngine, 'importSession'>;
  /** What the user picked in the composer: the import applies it as a start would. */
  choices: AcpChoices;
  /** The picks went with the import; a later draft starts from the model picked last. */
  onChoicesUsed: () => void;
  recordSession: (spec: SessionSpec) => Session;
  openSession: (sessionId: string) => void;
  discardSession: (sessionId: string) => void;
  openNewSession: (path: string, agentId: string) => void;
  requestSignIn: AgentAuth['requestSignIn'];
  onImportError: (message: string) => void;
}

/**
 * Opens one of the agent's own sessions, listed in the new-session draft, as a
 * Zorvo session. The record is made before the agent is asked, so its replay
 * has a transcript to land in, and removed again when the import fails.
 */
export function useSessionImport({
  sessions,
  agent,
  cwd,
  activeSessionId,
  acp,
  choices,
  onChoicesUsed,
  recordSession,
  openSession,
  discardSession,
  openNewSession,
  requestSignIn,
  onImportError,
}: SessionImportDeps): (listed: ListedSession) => void {
  // Read when the agent answers, seconds after the click: the user may have opened another session.
  const activeSessionIdRef = useLatest(activeSessionId);
  return (listed: ListedSession) => {
    // A double click, or a list that no longer matches: show the session Zorvo has.
    const held = sessions.find((session) => session.acpSessionId === listed.acpSessionId);
    if (held) {
      openSession(held.id);
      return;
    }
    if (!agent || !cwd) return;
    const session = recordSession(importedSessionSpec(listed, agent, cwd));
    onChoicesUsed();
    void acp.importSession(session, choices, (error) => {
      // The record was only made for the import: it and its transcript go, and the
      // draft it started from comes back — unless the user has opened another session.
      discardSession(session.id);
      if (activeSessionIdRef.current === session.id) openNewSession(cwd, agent.id);
      const methods = parseAuthRequired(error);
      if (methods) requestSignIn(agent.id, cwd, methods);
      else onImportError(`Could not open the session: ${messageOf(error)}`);
    });
  };
}
