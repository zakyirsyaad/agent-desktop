import { useState } from "react";
import { BookOpen, CircleAlert, CircleCheck, RefreshCw } from "lucide-react";
import { installHintFor, isAgentReady, type AgentSummary } from "../../lib/agent-readiness";
import { CopyButton } from "./CopyButton";

export interface AgentsStepProps {
  agents: readonly AgentSummary[];
  onRecheckAgents: () => void | Promise<void>;
}

export const RECHECK_ERROR = "Couldn't check your agents. Try again.";

function InstallHintRow({ agent }: { agent: AgentSummary }) {
  const hint = installHintFor(agent);
  if (hint.kind === "docs") {
    return (
      <p className="mt-2 flex items-center gap-1.5 text-[11px] text-neutral-400">
        <BookOpen size={12} aria-hidden="true" />
        {hint.text}
      </p>
    );
  }
  return (
    <div className="mt-2 flex items-center gap-2">
      <code className="min-w-0 flex-1 truncate rounded-md border border-neutral-800 bg-black px-2 py-1 font-mono text-[11px] text-neutral-300">
        {hint.command}
      </code>
      <CopyButton text={hint.command} label={`Copy install command for ${agent.name}`} />
    </div>
  );
}

function AgentRow({ agent }: { agent: AgentSummary }) {
  const ready = isAgentReady(agent);
  return (
    <li className="rounded-lg border border-[#262626] bg-[#121212] px-3 py-2.5">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-neutral-100">{agent.name}</p>
          {agent.detected_path && (
            <p className="truncate font-mono text-[11px] text-neutral-500">{agent.detected_path}</p>
          )}
        </div>
        {ready ? (
          <span className="flex shrink-0 items-center gap-1 text-[11px] font-medium text-emerald-400">
            <CircleCheck size={13} aria-hidden="true" />
            Ready
          </span>
        ) : (
          <span className="flex shrink-0 items-center gap-1 text-[11px] font-medium text-amber-400">
            <CircleAlert size={13} aria-hidden="true" />
            Not installed
          </span>
        )}
      </div>
      {!ready && <InstallHintRow agent={agent} />}
    </li>
  );
}

export function AgentsStep({ agents, onRecheckAgents }: AgentsStepProps) {
  const [isChecking, setIsChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleRecheck = async () => {
    setIsChecking(true);
    setError(null);
    try {
      await onRecheckAgents();
    } catch {
      setError(RECHECK_ERROR);
    } finally {
      setIsChecking(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <ul aria-label="Agents" className="flex flex-col gap-2">
        {agents.map((agent) => (
          <AgentRow key={agent.id} agent={agent} />
        ))}
      </ul>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={handleRecheck}
          disabled={isChecking}
          className="flex items-center gap-1.5 rounded-lg border border-neutral-800/60 px-2.5 py-1 text-xs text-neutral-300 transition-colors hover:bg-neutral-800 hover:text-neutral-100 disabled:opacity-50 focus:outline-none focus:ring-1 focus:ring-amber-500/40"
        >
          <RefreshCw size={12} className={isChecking ? "animate-spin" : undefined} aria-hidden="true" />
          Check again
        </button>
        {error && (
          <p role="alert" className="text-[11px] text-red-400">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
