import { AgentCatalog } from "./AgentCatalog";
import type { AgentCatalogHandle } from "../../hooks/useAgentCatalog";
import type { AgentCatalogActions } from "../../hooks/useAgentCatalogActions";
import { loadAgentIcons } from "../../lib/agent-icons";
import { enabledAgentIds } from "../../lib/enabled-agents";
import type { AgentProfile, Settings } from "../../types";

export interface AgentCatalogPanelProps {
  agents: readonly AgentProfile[];
  settings: Settings;
  refreshAgents: () => Promise<void>;
  catalog: AgentCatalogHandle;
  /** The app's one set of catalog actions. */
  actions: AgentCatalogActions;
}

/** The agent catalog wired to the app's state; Settings and onboarding show the same one. */
export function AgentCatalogPanel({ agents, settings, refreshAgents, catalog, actions }: AgentCatalogPanelProps) {
  // Check again refreshes the registry, but reports no change event: the catalog and icons are read here.
  const checkAgain = async () => {
    try {
      await refreshAgents();
    } finally {
      await Promise.all([catalog.reload(), loadAgentIcons()]);
    }
  };

  return (
    <AgentCatalog
      catalog={catalog.catalog}
      error={catalog.error}
      agents={agents}
      enabledIds={enabledAgentIds(settings)}
      actions={actions}
      onCheckAgain={checkAgain}
      onRetryLoad={() => void catalog.reload()}
    />
  );
}
