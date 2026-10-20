import { useEffect, useId, useState, type ReactNode } from "react";
import { RefreshCw, Search } from "lucide-react";
import { AgentCatalogRow } from "./AgentCatalogRow";
import { Button } from "../ui/Button";
import type { AgentCatalogActions } from "../../hooks/useAgentCatalogActions";
import { catalogSections, formatCheckedAgo } from "../../lib/agent-catalog";
import { RECHECK_ERROR } from "../../lib/agent-readiness";
import type { AgentCatalog as Catalog, AgentProfile, CatalogAgent } from "../../types";

export interface AgentCatalogProps {
  catalog: Catalog | null;
  error: string | null;
  /** The agent profiles, for what Add would install. */
  agents: readonly AgentProfile[];
  enabledIds: readonly string[];
  actions: AgentCatalogActions;
  onCheckAgain: () => Promise<void>;
  onRetryLoad: () => void;
}

const SECTION_HEADING = "mb-2 text-[10px] font-semibold uppercase tracking-wider text-fg-subtle";

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const CLOCK_TICK_MS = 60_000;

/** The current time in seconds, refreshed every minute while mounted, so "checked … ago" keeps ageing. */
function useNowSeconds(): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const timer = setInterval(() => setNow(Math.floor(Date.now() / 1000)), CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function useCheckAgain(onCheckAgain: () => Promise<void>) {
  const [isChecking, setIsChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const checkAgain = () => {
    setIsChecking(true);
    setCheckError(null);
    onCheckAgain()
      .catch(() => setCheckError(RECHECK_ERROR))
      .finally(() => setIsChecking(false));
  };
  return { isChecking, checkError, checkAgain };
}

interface CatalogSectionProps {
  title: string;
  agents: readonly CatalogAgent[];
  isInUse: boolean;
  renderRow: (agent: CatalogAgent, isInUse: boolean) => ReactNode;
}

function CatalogSection({ title, agents, isInUse, renderRow }: CatalogSectionProps) {
  const headingId = useId();
  if (agents.length === 0) return null;
  return (
    <section aria-labelledby={headingId}>
      <h3 id={headingId} className={SECTION_HEADING}>
        {`${title} (${agents.length})`}
      </h3>
      <ul className="flex flex-col gap-1.5">{agents.map((agent) => renderRow(agent, isInUse))}</ul>
    </section>
  );
}

/** Every registry agent: search, Check again, and the agents in use above all the others. */
export function AgentCatalog({ catalog, error, agents, enabledIds, actions, onCheckAgain, onRetryLoad }: AgentCatalogProps) {
  const [query, setQuery] = useState("");
  // Kept here, not in the row: a removed agent's row moves to the other section and starts afresh.
  const [removeErrors, setRemoveErrors] = useState<Readonly<Record<string, string>>>({});
  const { isChecking, checkError, checkAgain } = useCheckAgain(onCheckAgain);
  const now = useNowSeconds();
  const { inUse, others } = catalogSections(catalog?.agents ?? [], enabledIds, query);
  const trimmedQuery = query.trim();

  const setRemoveError = (id: string, message: string | null) =>
    setRemoveErrors((current) => {
      const rest = Object.fromEntries(Object.entries(current).filter(([agentId]) => agentId !== id));
      return message === null ? rest : { ...rest, [id]: message };
    });

  const remove = (id: string) => {
    setRemoveError(id, null);
    actions.removeAgent(id).catch((failure: unknown) => setRemoveError(id, messageOf(failure)));
  };

  const renderRow = (agent: CatalogAgent, isInUse: boolean) => (
    <AgentCatalogRow
      key={agent.id}
      agent={agent}
      isInUse={isInUse}
      plan={agents.find((profile) => profile.id === agent.id)?.install_plan ?? null}
      runningSessionCount={actions.runningSessionCount(agent.id)}
      removeError={removeErrors[agent.id] ?? null}
      onAdd={() => {
        setRemoveError(agent.id, null);
        actions.addAgent(agent.id);
      }}
      onUpdate={() => actions.updateAgent(agent.id)}
      onRemove={() => remove(agent.id)}
    />
  );

  return (
    <div className="flex flex-col gap-4 text-xs">
      <header className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <label className="flex flex-1 items-center gap-2 rounded-lg border border-border-strong bg-surface-2 px-3 py-1.5 focus-ring-within">
            <Search size={13} className="shrink-0 text-fg-subtle" aria-hidden="true" />
            <input
              type="search"
              aria-label="Search agents"
              placeholder="Search agents"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="min-w-0 flex-1 bg-transparent text-fg-secondary outline-none placeholder:text-fg-subtle"
            />
          </label>
          <Button
            disabled={isChecking}
            onClick={checkAgain}
            icon={<RefreshCw size={12} className={isChecking ? "animate-spin" : undefined} aria-hidden="true" />}
          >
            Check again
          </Button>
        </div>
        {catalog?.lastChecked != null && (
          <p className="text-[11px] text-fg-subtle">
            {`Registry checked ${formatCheckedAgo(catalog.lastChecked, now)}`}
          </p>
        )}
        {checkError && (
          <p role="alert" className="text-[11px] text-danger">
            {checkError}
          </p>
        )}
      </header>

      {error && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-surface-2 px-3 py-2">
          <p className="text-danger">{`Could not load the agents: ${error}`}</p>
          <Button onClick={onRetryLoad} className="shrink-0">
            Try again
          </Button>
        </div>
      )}
      {!catalog && !error && <p className="text-fg-subtle">Loading the agents…</p>}

      <CatalogSection title="In use" agents={inUse} isInUse renderRow={renderRow} />
      <CatalogSection title="All agents" agents={others} isInUse={false} renderRow={renderRow} />
      {catalog && trimmedQuery !== "" && inUse.length === 0 && others.length === 0 && (
        <p className="text-fg-subtle">{`No agents match "${trimmedQuery}".`}</p>
      )}
    </div>
  );
}
