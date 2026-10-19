import { useEffect } from 'react';
import { forgetFailedInstalls } from '../lib/agent-installs';
import { canInstall, isAgentRunnable } from '../lib/agent-readiness';
import type { AgentProfile } from '../types';

export interface DraftInstall {
  /** The draft shows the agent's install panel. */
  showsPanel: boolean;
  /** The agent must be installed first: only Send waits, the prompt can be written. */
  needsInstall: boolean;
}

/**
 * Whether a draft offers its agent's install. `canOffer` is true for a draft
 * (a new session, or an ended one that can continue) in the window that installs.
 * Also forgets the failed installs of agents now ready, so a later missing
 * agent offers Install rather than an old failure.
 */
export function useDraftInstall(
  agents: readonly AgentProfile[],
  draftAgent: AgentProfile | undefined,
  canOffer: boolean,
): DraftInstall {
  useEffect(() => {
    forgetFailedInstalls(agents.filter(isAgentRunnable).map((agent) => agent.id));
  }, [agents]);
  const showsPanel = canOffer && draftAgent !== undefined && canInstall(draftAgent);
  return { showsPanel, needsInstall: showsPanel && draftAgent !== undefined && !isAgentRunnable(draftAgent) };
}
