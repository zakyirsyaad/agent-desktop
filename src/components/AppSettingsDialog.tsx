import { AgentCatalog } from "./agents/AgentCatalog";
import { SettingsPanel } from "./SettingsPanel";
import type { FolderOption } from "./onboarding/types";
import { useAgentCatalogActions } from "../hooks/useAgentCatalogActions";
import type { AgentCatalogHandle } from "../hooks/useAgentCatalog";
import type { PersistedStateHandle } from "../hooks/usePersistedState";
import { pendingUpdates } from "../lib/agent-catalog";
import { loadAgentIcons } from "../lib/agent-icons";
import { enabledAgentIds, isInUse } from "../lib/enabled-agents";
import type { AgentProfile, Settings } from "../types";

export interface AppSettingsDialogProps {
  isOpen: boolean;
  persisted: Pick<PersistedStateHandle, "state" | "updateState" | "saveNow">;
  agents: readonly AgentProfile[];
  refreshAgents: () => Promise<void>;
  catalog: AgentCatalogHandle;
  /** The ACP engine's stop, for the sessions of an agent being removed. */
  stopSession: (sessionId: string) => Promise<boolean>;
  recentFolders: readonly FolderOption[];
  onRemoveRecentFolder: (path: string) => void;
  onRunOnboarding: () => void;
  onClose: () => void;
}

/** The app's Settings dialog: General, and the agent catalog with its Add, Update and Remove. */
export function AppSettingsDialog({
  isOpen,
  persisted: { state, updateState, saveNow },
  agents,
  refreshAgents,
  catalog,
  stopSession,
  recentFolders,
  onRemoveRecentFolder,
  onRunOnboarding,
  onClose,
}: AppSettingsDialogProps) {
  const actions = useAgentCatalogActions({
    updateState,
    saveNow,
    agents,
    sessions: state.sessions,
    stopSession,
    refreshAgents,
    reloadCatalog: catalog.reload,
  });
  if (!isOpen) return null;

  const { settings } = state;
  const enabledIds = enabledAgentIds(settings);
  const updateSettings = (patch: Partial<Settings>) =>
    updateState((prev) => ({ ...prev, settings: { ...prev.settings, ...patch } }));
  // Check again refreshes the registry, but reports no change event: the catalog and icons are read here.
  const checkAgain = async () => {
    try {
      await refreshAgents();
    } finally {
      await Promise.all([catalog.reload(), loadAgentIcons()]);
    }
  };

  return (
    <SettingsPanel
      appearance={settings.appearance}
      onChangeAppearance={(appearance) => updateSettings({ appearance })}
      agents={agents.filter((agent) => isInUse(agent, settings))}
      defaultAgentId={settings.defaultAgentId}
      recentFolders={recentFolders}
      onChangeDefaultAgent={(defaultAgentId) => updateSettings({ defaultAgentId })}
      onRemoveRecentFolder={onRemoveRecentFolder}
      onRunOnboarding={onRunOnboarding}
      onClose={onClose}
      updateCount={pendingUpdates(catalog.catalog?.agents ?? [], enabledIds).length}
      agentsPanel={
        <AgentCatalog
          catalog={catalog.catalog}
          error={catalog.error}
          agents={agents}
          enabledIds={enabledIds}
          actions={actions}
          onCheckAgain={checkAgain}
          onRetryLoad={() => void catalog.reload()}
        />
      }
    />
  );
}
