import type { AgentProfile } from "../types";

/** Shown where agents are checked again (onboarding, Settings) when the check failed. */
export const RECHECK_ERROR = "Couldn't check your agents. Try again.";

/** The subset of `AgentProfile` the setup screens read. */
export type AgentSummary = Pick<AgentProfile, "id" | "name" | "detected" | "detected_path" | "distribution"> &
  Partial<Pick<AgentProfile, "install_plan">>;

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
 * `agents` are the candidates, e.g. only the agents the user has in use.
 */
export function resolveDefaultAgentId(agents: readonly AgentSummary[], preferredId: string | null): string | null {
  const ready = readyAgents(agents);
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

/** English list joining: "A", "A and B", "A, B and C". */
function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * Why no session can start, built from the agents in use that are not ready
 * but Zorvo can install: the ones that run through `npx` are named as needing
 * Node.js (which Install sets up), else the others are named. With none, it
 * asks to install one of the agents.
 */
export function noAgentNotice(agentsInUse: readonly AgentSummary[]): string {
  const installable = agentsInUse.filter((agent) => !isAgentReady(agent) && canInstall(agent));
  if (installable.length === 0) {
    return "No agent is ready. Install one of your agents, then check again in Settings.";
  }
  const needNode = installable.filter((agent) => agent.distribution === "npx").map((agent) => agent.name);
  const named = needNode.length > 0 ? needNode : installable.map((agent) => agent.name);
  const isOne = named.length === 1;
  const action = isOne ? "Click Install to set it up." : "Choose one and click Install.";
  if (needNode.length > 0) {
    return `No agent is ready. ${joinNames(named)} ${isOne ? "needs" : "need"} Node.js 22 or later, which Zorvo installs for you. ${action}`;
  }
  return `No agent is ready. ${joinNames(named)} ${isOne ? "is" : "are"} not installed yet. ${action}`;
}

export type InstallHint =
  | { kind: "command"; command: string }
  | { kind: "docs"; text: string };

/** A registry npx agent runs through `npx`, so it is only missing when Node.js is. */
export const NODE_HINT = "Needs Node.js 22 or later. Zorvo installs it when you click Install in a new session.";

/** A registry agent Zorvo can download for this Mac. */
export const INSTALLABLE_HINT = "Zorvo installs it when you click Install in a new session.";

const INSTALL_HINTS: Readonly<Record<string, InstallHint>> = {
  aider: { kind: "command", command: "python -m pip install aider-install && aider-install" },
  omp: { kind: "docs", text: "See the omp documentation for install steps." },
};

/** How to install a missing agent; agents without a verified command get a docs pointer. */
export function installHintFor(agent: AgentSummary): InstallHint {
  if (agent.distribution === "npx") {
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
