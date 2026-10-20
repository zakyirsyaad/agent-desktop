import type { AgentProfile, Settings } from "../types";

/** The registry agents in use until the user changes the list. */
export const DEFAULT_ENABLED_AGENTS: readonly string[] = ["claude-acp", "codex-acp", "qwen-code"];

export type EnabledSettings = Pick<Settings, "enabledAgents">;
type UsableAgent = Pick<AgentProfile, "id">;

export function enabledAgentIds(settings: EnabledSettings): readonly string[] {
  return settings.enabledAgents ?? DEFAULT_ENABLED_AGENTS;
}

/** An agent is in use when the user enabled it. */
export function isInUse(agent: UsableAgent, settings: EnabledSettings): boolean {
  return enabledAgentIds(settings).includes(agent.id);
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
    .filter((a) => a.installed_on_system)
    .map((a) => a.id)
    .filter((id) => !enabled.includes(id) && !removed.includes(id));
  const nextEnabled = installed.length > 0 ? [...new Set([...enabled, ...installed])] : enabled;

  const known = settings.agentVersions ?? {};
  const newVersions = Object.fromEntries(
    agents
      .filter((a) => a.version && nextEnabled.includes(a.id) && !(a.id in known))
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
