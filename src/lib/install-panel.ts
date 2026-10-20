import type { Session } from "../types";
import { canInstall, type AgentSummary } from "./agent-readiness";
import { isAcpSession } from "./session-helpers";

/**
 * The agent whose Install panel the main area shows: the new-session draft's agent, or an
 * ended chat's own agent, which must be installed before the chat can continue. None for a
 * running session, an old terminal session, or an agent with nothing to install.
 */
export function installPanelAgentOf<T extends AgentSummary>(
  activeSession: Session | undefined,
  sessionAgent: T | undefined,
  newSessionAgent: T | undefined
): T | undefined {
  const agent = !activeSession
    ? newSessionAgent
    : isAcpSession(activeSession) && activeSession.status !== "running"
      ? sessionAgent
      : undefined;
  return agent && canInstall(agent) ? agent : undefined;
}
