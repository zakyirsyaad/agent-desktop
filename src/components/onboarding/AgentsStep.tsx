import type { ReactNode } from "react";

export interface AgentsStepProps {
  /** The agent catalog, the same one Settings shows. */
  agentsPanel: ReactNode;
}

export function AgentsStep({ agentsPanel }: AgentsStepProps) {
  return <div className="max-h-[50vh] overflow-y-auto">{agentsPanel}</div>;
}
