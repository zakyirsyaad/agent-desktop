import { useEffect, useRef, type ReactNode } from 'react';
import { AgentSessionList } from '../components/workspace/AgentSessionList';
import { useAgentSessionList } from './useAgentSessionList';
import { useSessionImport } from './useSessionImport';
import type { AcpEngine } from './session-engine/useAcpEngine';
import type { AgentAuth } from './useAgentAuth';
import type { AcpChoices } from '../lib/acp-draft';
import type { SessionSpec } from '../lib/session-start';
import type { ListedSessions } from '../lib/session-list';
import type { AgentProfile, Session } from '../types';

export interface DraftSessionListDeps {
  /** The draft's agent; undefined when no draft is shown. */
  agent: AgentProfile | undefined;
  /** The draft's folder. */
  cwd: string | undefined;
  sessions: readonly Session[];
  /** Whether the agent offered `session/list` and the draft is not making a worktree. */
  isShown: boolean;
  listSessions: (profileId: string, cwd: string) => Promise<ListedSessions>;
  acp: Pick<AcpEngine, 'importSession'>;
  choices: AcpChoices;
  onChoicesUsed: () => void;
  recordSession: (spec: SessionSpec) => Session;
  openSession: (sessionId: string) => void;
  discardSession: (sessionId: string) => void;
  openNewSession: (path: string, agentId: string) => void;
  requestSignIn: AgentAuth['requestSignIn'];
}

/**
 * The new-session draft's list of the agent's other sessions, with the
 * import it starts: App wires it in one line, and the list keeps its own
 * loading, error and filtering state.
 */
export function useDraftSessionList(deps: DraftSessionListDeps): {
  sessionList: ReactNode;
} {
  const { agent, cwd, sessions, isShown, listSessions, acp, choices, ...actions } = deps;
  // While an imported session opens, the draft's agent is still the list's
  // agent: a failed import must come back to the draft with its error, not
  // start the list over because the draft left the screen for a moment.
  const lastAgentRef = useRef(agent);
  useEffect(() => {
    if (agent) lastAgentRef.current = agent;
  }, [agent]);
  const list = useAgentSessionList({
    profileId: (agent ?? lastAgentRef.current)?.id,
    cwd,
    sessions,
    listSessions,
    requestSignIn: actions.requestSignIn,
  });
  const importListed = useSessionImport({
    sessions,
    agent,
    cwd,
    acp,
    choices,
    onChoicesUsed: actions.onChoicesUsed,
    recordSession: actions.recordSession,
    openSession: actions.openSession,
    discardSession: actions.discardSession,
    openNewSession: actions.openNewSession,
    requestSignIn: actions.requestSignIn,
    onImportError: list.setImportError,
  });
  // An old failure belongs to the attempt that made it: a new try starts clean.
  const clearImportError = () => list.setImportError(null);
  const sessionList =
    isShown && agent ? (
      <AgentSessionList
        agentName={agent.name}
        state={list.state}
        importError={list.importError}
        onLoad={() => {
          clearImportError();
          list.load();
        }}
        onImport={(listed) => {
          clearImportError();
          importListed(listed);
        }}
      />
    ) : null;
  return { sessionList };
}
