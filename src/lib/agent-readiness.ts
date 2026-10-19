import type { AgentProfile } from "../types";

/** Shown where agents are checked again (onboarding, Settings) when the check failed. */
export const RECHECK_ERROR = "Couldn't check your agents. Try again.";

/** The subset of `AgentProfile` the setup screens read. */
export type AgentSummary = Pick<AgentProfile, "id" | "name" | "detected" | "detected_path"> &
  Partial<Pick<AgentProfile, "distribution" | "install_plan">>;

export function isAgentReady(agent: AgentSummary): boolean {
  return agent.detected;
}

/** Zorvo can install the agent: its plan says what Install would do. */
export function canInstall(agent: AgentSummary): boolean {
  return (agent.install_plan?.length ?? 0) > 0;
}

/** Ready now, or ready after Install. */
export function isAgentUsable(agent: AgentSummary): boolean {
  return isAgentReady(agent) || canInstall(agent);
}

export function readyAgents<T extends AgentSummary>(agents: readonly T[]): T[] {
  return agents.filter(isAgentReady);
}

/**
 * Keeps `preferredId` when it names a ready agent, else falls back to the first ready one.
 * `isCandidate` narrows the choice, e.g. to the agents the user has in use.
 */
export function resolveDefaultAgentId<T extends AgentSummary>(
  agents: readonly T[],
  preferredId: string | null,
  isCandidate: (agent: T) => boolean = () => true
): string | null {
  const ready = readyAgents(agents).filter(isCandidate);
  const preferred = ready.find((agent) => agent.id === preferredId);
  return (preferred ?? ready[0])?.id ?? null;
}

/**
 * The agent a new session starts with: the ready default, else the preferred or first of
 * `offered` (agents not ready yet), so the draft can show the picker and the Install panel.
 */
export function resolveDraftAgentId<T extends AgentSummary>(
  agents: readonly T[],
  preferredId: string | null,
  offered: readonly T[]
): string | null {
  const ready = resolveDefaultAgentId(agents, preferredId);
  if (ready) return ready;
  return (offered.find((agent) => agent.id === preferredId) ?? offered[0])?.id ?? null;
}

/** Keeps `preferredId` when it names a usable agent, else the first ready one, else the first usable one. */
export function resolveUsableAgentId<T extends AgentSummary>(
  agents: readonly T[],
  preferredId: string | null
): string | null {
  const usable = agents.filter(isAgentUsable);
  const preferred = usable.find((agent) => agent.id === preferredId);
  return (preferred ?? readyAgents(usable)[0] ?? usable[0])?.id ?? null;
}

export type InstallHint =
  | { kind: "command"; command: string }
  | { kind: "docs"; text: string };

/** A registry npx agent runs through `npx`, so it is only missing when Node.js is. */
export const NODE_HINT = "Needs Node.js 22 or later. Zorvo installs it when you click Install in a new session.";

/** A registry agent Zorvo can download for this Mac. */
export const INSTALLABLE_HINT = "Zorvo installs it when you click Install in a new session.";

/** Registry agents that run through `npx`, for profiles that do not say so. */
const NPX_AGENT_IDS: readonly string[] = ["claude-acp", "codex-acp", "qwen-code"];

const INSTALL_HINTS: Readonly<Record<string, InstallHint>> = {
  aider: { kind: "command", command: "python -m pip install aider-install && aider-install" },
  omp: { kind: "docs", text: "See the omp documentation for install steps." },
};

/** How to install a missing agent; agents without a verified command get a docs pointer. */
export function installHintFor(agent: AgentSummary): InstallHint {
  if (agent.distribution === "npx" || NPX_AGENT_IDS.includes(agent.id)) {
    return { kind: "docs", text: NODE_HINT };
  }
  if (canInstall(agent)) return { kind: "docs", text: INSTALLABLE_HINT };
  return (
    INSTALL_HINTS[agent.id] ?? {
      kind: "docs",
      text: `See the ${agent.name} documentation for install steps.`,
    }
  );
}
