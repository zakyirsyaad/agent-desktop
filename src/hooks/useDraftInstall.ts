import { useEffect } from 'react';
import { forgetFailedInstalls } from '../lib/agent-installs';
import { isAgentRunnable } from '../lib/agent-readiness';
import type { AgentProfile } from '../types';

/**
 * Whether the composer's Send must wait for an install: true while
 * `panelAgent` (the agent the install panel offers, from `installPanelAgentOf`)
 * is the draft's agent and cannot run yet. The prompt can still be written.
 * Also forgets the failed installs of agents now ready, so a later missing
 * agent offers Install rather than an old failure.
 */
export function useDraftInstall(
  agents: readonly AgentProfile[],
  panelAgent: AgentProfile | undefined,
  draftAgent: AgentProfile | undefined,
): boolean {
  useEffect(() => {
    forgetFailedInstalls(agents.filter(isAgentRunnable).map((agent) => agent.id));
  }, [agents]);
  return panelAgent !== undefined && panelAgent.id === draftAgent?.id && !isAgentRunnable(panelAgent);
}
