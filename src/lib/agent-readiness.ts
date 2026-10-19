import type { AgentProfile } from "../types";

/** Shown where agents are checked again (onboarding, Settings) when the check failed. */
export const RECHECK_ERROR = "Couldn't check your agents. Try again.";

/** The subset of `AgentProfile` the setup screens read. */
export type AgentSummary = Pick<AgentProfile, "id" | "name" | "detected" | "detected_path" | "distribution">;

export function isAgentReady(agent: AgentSummary): boolean {
  return agent.detected;
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

/** English list joining: "A", "A and B", "A, B and C". */
function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * Why no session can start, built from the agents in use: names the ones that
 * run through `npx` and are not ready (they need Node.js), else asks to install one.
 */
export function noAgentNotice(agentsInUse: readonly AgentSummary[]): string {
  const needNode = agentsInUse
    .filter((agent) => agent.distribution === "npx" && !isAgentReady(agent))
    .map((agent) => agent.name);
  if (needNode.length === 0) {
    return "No agent is ready. Install one of your agents, then check again in Settings.";
  }
  const verb = needNode.length === 1 ? "needs" : "need";
  return `No agent is ready. ${joinNames(needNode)} ${verb} Node.js 22 or later: install it from https://nodejs.org, then check again in Settings.`;
}

export type InstallHint =
  | { kind: "command"; command: string }
  | { kind: "docs"; text: string };

/** A registry npx agent runs through `npx`, so it is only missing when Node.js is. */
export const NODE_HINT = "Needs Node.js 22 or later. Install it from https://nodejs.org, then check again.";

const INSTALL_HINTS: Readonly<Record<string, InstallHint>> = {
  aider: { kind: "command", command: "python -m pip install aider-install && aider-install" },
  omp: { kind: "docs", text: "See the omp documentation for install steps." },
};

/** How to install a missing agent; agents without a verified command get a docs pointer. */
export function installHintFor(agent: AgentSummary): InstallHint {
  if (agent.distribution === "npx") {
    return { kind: "docs", text: NODE_HINT };
  }
  return (
    INSTALL_HINTS[agent.id] ?? {
      kind: "docs",
      text: `See the ${agent.name} documentation for install steps.`,
    }
  );
}
