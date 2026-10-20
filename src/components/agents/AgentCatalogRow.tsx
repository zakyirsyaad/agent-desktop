import { useState } from "react";
import { Download, Plus, RotateCcw } from "lucide-react";
import { AgentLogo } from "../AgentLogo";
import { InstallProgressLine } from "../InstallProgressLine";
import { Button } from "../ui/Button";
import { useAgentInstall } from "../../hooks/useAgentInstall";
import { rowActions, statusLine } from "../../lib/agent-catalog";
import type { CatalogAgent, InstallStep } from "../../types";

export interface AgentCatalogRowProps {
  agent: CatalogAgent;
  isInUse: boolean;
  /** What Add or Install would install, from the agent's profile; null when nothing or unknown. */
  plan: readonly InstallStep[] | null;
  runningSessionCount: number;
  /** Why the last Remove could not delete Zorvo's copy; kept by the list, as the row moves section. */
  removeError: string | null;
  onAdd: () => void;
  onUpdate: () => void;
  onRemove: () => void;
}

function removeQuestion(name: string, runningSessionCount: number): string {
  const question = `Remove ${name}? Zorvo deletes its copy. Saved sessions stay readable.`;
  return runningSessionCount > 0 ? `${question} Its open sessions stop.` : question;
}

/** One agent in the catalog: what it is, how it runs here, and Add / Install / Update / Remove. */
export function AgentCatalogRow({
  agent,
  isInUse,
  plan,
  runningSessionCount,
  removeError,
  onAdd,
  onUpdate,
  onRemove,
}: AgentCatalogRowProps) {
  const job = useAgentInstall(agent.id);
  const [isConfirmingRemove, setIsConfirmingRemove] = useState(false);
  const actions = rowActions(agent, isInUse);
  const isBusy = job.status === "installing";
  const retry = job.action === "update" ? onUpdate : job.install;
  // A failure is about an agent in use; once removed, its Add starts over.
  const hasFailed = job.status === "failed" && isInUse;

  return (
    <li aria-label={agent.name} className="flex gap-3 rounded-lg border border-border bg-surface-2 px-3 py-2.5 text-xs">
      <AgentLogo profileId={agent.id} name="" size={20} className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="truncate font-medium text-fg">{agent.name}</span>
          {agent.version && <span className="shrink-0 font-mono text-[11px] text-fg-subtle">{agent.version}</span>}
        </div>
        <p className="mt-0.5 text-[11px] text-fg-muted">{statusLine(agent, plan, isInUse)}</p>
        {agent.description && <p className="mt-1 line-clamp-2 text-[11px] text-fg-subtle">{agent.description}</p>}

        {isBusy && <InstallProgressLine progress={job.progress} onCancel={job.cancel} action={job.action} />}
        {isBusy && job.error && <p className="mt-2 text-danger">{job.error}</p>}
        {hasFailed && (
          <>
            <p className="mt-2 text-danger">
              {job.action === "update" ? "Update" : "Install"} failed: {job.error}
            </p>
            <Button onClick={retry} icon={<RotateCcw size={12} aria-hidden="true" />} className="mt-2">
              Retry
            </Button>
          </>
        )}

        {isConfirmingRemove && (
          <div className="mt-2 rounded-md border border-border-strong bg-surface-1 px-3 py-2">
            <p className="text-fg-secondary">{removeQuestion(agent.name, runningSessionCount)}</p>
            <div className="mt-2 flex gap-2">
              <Button
                variant="danger"
                onClick={() => {
                  setIsConfirmingRemove(false);
                  onRemove();
                }}
              >
                Remove
              </Button>
              <Button onClick={() => setIsConfirmingRemove(false)}>Cancel</Button>
            </div>
          </div>
        )}
        {removeError && (
          <p role="alert" className="mt-2 text-danger">
            {removeError}
          </p>
        )}
      </div>

      <div className="flex shrink-0 items-start gap-2">
        {actions.add && !isBusy && (
          <Button variant="primary" onClick={onAdd} icon={<Plus size={12} aria-hidden="true" />}>
            Add
          </Button>
        )}
        {actions.install && !isBusy && !hasFailed && (
          <Button variant="primary" onClick={job.install} icon={<Download size={12} aria-hidden="true" />}>
            Install
          </Button>
        )}
        {actions.update && !isBusy && <Button onClick={onUpdate}>{`Update to ${agent.updateVersion}`}</Button>}
        {actions.remove && !isConfirmingRemove && (
          <Button variant="ghost" onClick={() => setIsConfirmingRemove(true)}>
            Remove
          </Button>
        )}
      </div>
    </li>
  );
}
