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
            className={`flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5 transition-colors focus-within:ring-1 focus-within:ring-amber-500/40 ${
              checked
                ? "border-amber-500/40 bg-amber-500/10"
                : "border-[#262626] bg-[#121212] hover:bg-neutral-900"
            }`}
          >
            <input
              type="radio"
              name={RADIO_GROUP_NAME}
              value={agent.id}
              checked={checked}
              onChange={() => onSelectAgent(agent.id)}
              className="accent-amber-500"
            />
            <span className="min-w-0">
              <span className="block text-sm font-medium text-neutral-100">{agent.name}</span>
              {agent.detected_path && (
                <span className="block truncate font-mono text-[11px] text-neutral-500">
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
