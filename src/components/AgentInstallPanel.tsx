import { Download, RotateCcw } from "lucide-react";
import { Button } from "./ui/Button";
import { InstallProgressLine } from "./InstallProgressLine";
import { useAgentInstall } from "../hooks/useAgentInstall";
import { describePlan } from "../lib/install-plan";
import type { AgentProfile } from "../types";

export interface AgentInstallPanelProps {
  agent: AgentProfile;
}

/**
 * Shown in a new-session draft whose agent is not installed yet: says what
 * Install puts on the machine, then follows the install until the agent is ready.
 */
export function AgentInstallPanel({ agent }: AgentInstallPanelProps) {
  const { status, progress, error, install, cancel } = useAgentInstall(agent.id);
  const title = `Install ${agent.name}`;
  return (
    <section
      aria-label={title}
      className="mx-6 mt-3 rounded-lg border border-border bg-surface-1 px-4 py-3 text-xs text-fg-secondary"
    >
      <h2 className="flex items-center gap-1.5 font-medium text-fg">
        <Download size={13} />
        {title}
      </h2>
      <p className="mt-1.5 text-fg-muted">
        {agent.name} needs {describePlan(agent.install_plan ?? [])} before it can start.
      </p>

      {status === "installing" && <InstallProgressLine progress={progress} onCancel={cancel} />}
      {status === "idle" && (
        <Button variant="primary" onClick={install} icon={<Download size={12} />} className="mt-2">
          Install
        </Button>
      )}
      {error && <p className="mt-2 text-danger">{status === "failed" ? `Install failed: ${error}` : error}</p>}
      {status === "failed" && (
        <Button variant="primary" onClick={install} icon={<RotateCcw size={12} />} className="mt-2">
          Retry
        </Button>
      )}
    </section>
  );
}
