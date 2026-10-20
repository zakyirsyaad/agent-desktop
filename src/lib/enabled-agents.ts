import type { AgentProfile, Session, Settings } from "../types";

/** The registry agents in use until the user changes the list. */
export const DEFAULT_ENABLED_AGENTS: readonly string[] = ["claude-acp", "codex-acp", "qwen-code"];

export type EnabledSettings = Pick<Settings, "enabledAgents">;
type UsableAgent = Pick<AgentProfile, "id" | "source" | "detected">;

export function enabledAgentIds(settings: EnabledSettings): readonly string[] {
  return settings.enabledAgents ?? DEFAULT_ENABLED_AGENTS;
}

/** Terminal agents are in use when found on this machine; registry agents when the user enabled them. */
export function isInUse(agent: UsableAgent, settings: EnabledSettings): boolean {
  if (agent.source === "builtin") return agent.detected;
  return enabledAgentIds(settings).includes(agent.id);
}

/** The name of a registry agent that is no longer in use, whose saved sessions can only be read. */
export function removedAgentName(
  agent: (UsableAgent & Pick<AgentProfile, "name">) | undefined,
  settings: EnabledSettings,
): string | null {
  return agent?.source === "registry" && !isInUse(agent, settings) ? agent.name : null;
}

/**
 * The removed agent's name when `session` should show the removed-agent panel in place of its
 * composer. A running session keeps the composer, which holds Stop.
 */
export function removedAgentNameFor(
  session: Pick<Session, "profileId" | "status"> | undefined,
  agents: readonly (UsableAgent & Pick<AgentProfile, "name">)[],
  settings: EnabledSettings,
): string | null {
  if (!session || session.status === "running") return null;
  return removedAgentName(agents.find((agent) => agent.id === session.profileId), settings);
}

/**
 * Enables registry agents found installed (unless the user removed them) and records the
 * version of each one in use, so it only changes when the user updates it. Returns the same
 * object when there is nothing to add, so callers can apply it on every change.
 */
export function withAutoEnabled(settings: Settings, agents: readonly AgentProfile[]): Settings {
  const removed = settings.removedAgents ?? [];
  const enabled = enabledAgentIds(settings);
  const installed = agents
    .filter((a) => a.source === "registry" && a.installed_on_system)
    .map((a) => a.id)
    .filter((id) => !enabled.includes(id) && !removed.includes(id));
  const nextEnabled = installed.length > 0 ? [...new Set([...enabled, ...installed])] : enabled;

  const known = settings.agentVersions ?? {};
  const newVersions = Object.fromEntries(
    agents
      .filter((a) => a.source === "registry" && a.version && nextEnabled.includes(a.id) && !(a.id in known))
      .map((a) => [a.id, a.version as string]),
  );
  const hasNewVersions = Object.keys(newVersions).length > 0;

  if (installed.length === 0 && !hasNewVersions) return settings;
  // The list is written only when an agent was added, so the defaults are not frozen into it.
  return {
    ...settings,
    ...(installed.length > 0 ? { enabledAgents: [...nextEnabled] } : {}),
    ...(hasNewVersions ? { agentVersions: { ...known, ...newVersions } } : {}),
  };
}
