import type { AgentProfile } from "../types";

/** Shown where agents are checked again (onboarding, Settings) when the check failed. */
export const RECHECK_ERROR = "Couldn't check your agents. Try again.";

/** The subset of `AgentProfile` the setup screens read. */
export type AgentSummary = Pick<AgentProfile, "id" | "name" | "detected" | "detected_path">;

export function isAgentReady(agent: AgentSummary): boolean {
  return agent.detected;
}

export function readyAgents<T extends AgentSummary>(agents: readonly T[]): T[] {
  return agents.filter(isAgentReady);
}

/** Keeps `preferredId` when it names a ready agent, else falls back to the first ready one. */
export function resolveDefaultAgentId(
  agents: readonly AgentSummary[],
  preferredId: string | null
): string | null {
  const ready = readyAgents(agents);
  const preferred = ready.find((agent) => agent.id === preferredId);
  return (preferred ?? ready[0])?.id ?? null;
}

export type InstallHint =
  | { kind: "command"; command: string }
  | { kind: "docs"; text: string };

const INSTALL_HINTS: Readonly<Record<string, InstallHint>> = {
  "claude-acp": { kind: "command", command: "npm install -g @anthropic-ai/claude-code" },
  aider: { kind: "command", command: "python -m pip install aider-install && aider-install" },
  omp: { kind: "docs", text: "See the omp documentation for install steps." },
};

/** How to install a missing agent; agents without a verified command get a docs pointer. */
export function installHintFor(agent: AgentSummary): InstallHint {
  return (
    INSTALL_HINTS[agent.id] ?? {
      kind: "docs",
      text: `See the ${agent.name} documentation for install steps.`,
    }
  );
}
