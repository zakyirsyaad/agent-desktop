import { readyAgents, type AgentSummary } from "../../lib/agent-readiness";

export interface DefaultAgentStepProps {
  agents: readonly AgentSummary[];
  selectedAgentId: string | null;
  onSelectAgent: (agentId: string) => void;
}

const RADIO_GROUP_NAME = "default-agent";

export function DefaultAgentStep({ agents, selectedAgentId, onSelectAgent }: DefaultAgentStepProps) {
  return (
    <div role="radiogroup" aria-label="Default agent" className="flex flex-col gap-1.5">
      {readyAgents(agents).map((agent) => {
        const checked = agent.id === selectedAgentId;
        return (
          <label
            key={agent.id}
            className={`flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5 transition-colors focus-within:outline focus-within:outline-1 focus-within:outline-offset-1 focus-within:outline-focus-ring ${
              checked
                ? "border-border-strong bg-surface-hover"
                : "border-border bg-surface-2 hover:bg-surface-hover"
            }`}
          >
            <input
              type="radio"
              name={RADIO_GROUP_NAME}
              value={agent.id}
              checked={checked}
              onChange={() => onSelectAgent(agent.id)}
              className="accent-primary"
            />
            <span className="min-w-0">
              <span className="block text-sm font-medium text-fg">{agent.name}</span>
              {agent.detected_path && (
                <span className="block truncate font-mono text-[11px] text-fg-muted">
                  {agent.detected_path}
                </span>
              )}
            </span>
          </label>
        );
      })}
    </div>
  );
}
