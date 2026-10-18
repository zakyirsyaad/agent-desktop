import { useState } from "react";
import { BookOpen, CircleAlert, CircleCheck, RefreshCw } from "lucide-react";
import { RECHECK_ERROR, installHintFor, isAgentReady, type AgentSummary } from "../../lib/agent-readiness";
import { Button } from "../ui/Button";
import { CopyButton } from "./CopyButton";

export interface AgentsStepProps {
  agents: readonly AgentSummary[];
  onRecheckAgents: () => void | Promise<void>;
}


function InstallHintRow({ agent }: { agent: AgentSummary }) {
  const hint = installHintFor(agent);
  if (hint.kind === "docs") {
    return (
      <p className="mt-2 flex items-center gap-1.5 text-[11px] text-fg-muted">
        <BookOpen size={12} aria-hidden="true" />
        {hint.text}
      </p>
    );
  }
  return (
    <div className="mt-2 flex items-center gap-2">
      <code className="min-w-0 flex-1 truncate rounded-md border border-border bg-bg px-2 py-1 font-mono text-[11px] text-fg-secondary">
        {hint.command}
      </code>
      <CopyButton text={hint.command} label={`Copy install command for ${agent.name}`} />
    </div>
  );
}

function AgentRow({ agent }: { agent: AgentSummary }) {
  const ready = isAgentReady(agent);
  return (
    <li className="rounded-lg border border-border bg-surface-2 px-3 py-2.5">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-fg">{agent.name}</p>
          {agent.detected_path && (
            <p className="truncate font-mono text-[11px] text-fg-subtle">{agent.detected_path}</p>
          )}
        </div>
        {ready ? (
          <span className="flex shrink-0 items-center gap-1 text-[11px] font-medium text-status-running">
            <CircleCheck size={13} aria-hidden="true" />
            Ready
          </span>
        ) : (
          <span className="flex shrink-0 items-center gap-1 text-[11px] font-medium text-fg-muted">
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
        <Button
          onClick={handleRecheck}
          disabled={isChecking}
          icon={<RefreshCw size={12} className={isChecking ? "animate-spin" : undefined} aria-hidden="true" />}
        >
          Check again
        </Button>
        {error && (
          <p role="alert" className="text-[11px] text-danger">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
