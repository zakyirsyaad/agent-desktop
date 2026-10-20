import type { AgentProfile } from "../types";

/** Shown where agents are checked again (onboarding, Settings) when the check failed. */
export const RECHECK_ERROR = "Couldn't check your agents. Try again.";

/** The subset of `AgentProfile` the setup screens read. */
export type AgentSummary = Pick<AgentProfile, "id" | "name" | "detected" | "detected_path" | "distribution"> &
  Partial<Pick<AgentProfile, "install_plan">>;

export function isAgentReady(agent: AgentSummary): boolean {
  return agent.detected;
}

/**
 * Zorvo can start the agent now: installed, with the runtime it needs. Stricter than
 * `isAgentReady`, which only says the agent was found.
 */
export function isAgentRunnable(agent: Pick<AgentProfile, "availability">): boolean {
  return agent.availability === "ready";
}

/** Zorvo can install the agent: its plan says what Install would do. */
export function canInstall(agent: AgentSummary): boolean {
  return (agent.install_plan?.length ?? 0) > 0;
}

/** Install would set up Zorvo's Node.js first: the agent needs a newer Node than this Mac has. */
export function needsNode(agent: AgentSummary): boolean {
  return agent.install_plan?.some((step) => step.kind === "node") ?? false;
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
 * but Zorvo can install: the ones whose Install sets up Node.js are named as
 * needing it, else every installable one is named. With none, it asks to
 * install one of the agents.
 */
export function noAgentNotice(agentsInUse: readonly AgentSummary[]): string {
  const installable = agentsInUse.filter((agent) => !isAgentReady(agent) && canInstall(agent));
  if (installable.length === 0) {
    return "No agent is ready. Install one of your agents, then check again in Settings.";
  }
  // Counted over every installable agent: the draft may show any of them.
  const action = installable.length === 1 ? "Click Install to set it up." : "Choose one and click Install.";
  const nodeNames = installable.filter(needsNode).map((agent) => agent.name);
  if (nodeNames.length > 0) {
    const verb = nodeNames.length === 1 ? "needs" : "need";
    return `No agent is ready. ${joinNames(nodeNames)} ${verb} Node.js 22 or newer, which Zorvo installs for you. ${action}`;
  }
  const verb = installable.length === 1 ? "is" : "are";
  return `No agent is ready. ${joinNames(installable.map((agent) => agent.name))} ${verb} not installed yet. ${action}`;
}

export type InstallHint =
  | { kind: "command"; command: string }
  | { kind: "docs"; text: string };

/** An agent whose Install sets up Node.js: this Mac has none, or one older than 22. */
export const NODE_HINT = "Needs Node.js 22 or newer. Zorvo installs it when you click Install in a new session.";

/** A registry agent Zorvo can download for this Mac. */
export const INSTALLABLE_HINT = "Zorvo installs it when you click Install in a new session.";

const INSTALL_HINTS: Readonly<Record<string, InstallHint>> = {
  aider: { kind: "command", command: "python -m pip install aider-install && aider-install" },
  omp: { kind: "docs", text: "See the omp documentation for install steps." },
};

/** How to install a missing agent; agents without a verified command get a docs pointer. */
export function installHintFor(agent: AgentSummary): InstallHint {
  if (needsNode(agent)) return { kind: "docs", text: NODE_HINT };
  if (canInstall(agent)) return { kind: "docs", text: INSTALLABLE_HINT };
  return (
    INSTALL_HINTS[agent.id] ?? {
      kind: "docs",
      text: `See the ${agent.name} documentation for install steps.`,
    }
  );
}
