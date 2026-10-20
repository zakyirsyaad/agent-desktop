import { AgentCatalogPanel } from "./agents/AgentCatalogPanel";
import { SettingsPanel, type SettingsTab } from "./SettingsPanel";
import type { FolderOption } from "./onboarding/types";
import type { AgentCatalogActions } from "../hooks/useAgentCatalogActions";
import type { AgentCatalogHandle } from "../hooks/useAgentCatalog";
import type { PersistedStateHandle } from "../hooks/usePersistedState";
import { pendingUpdates } from "../lib/agent-catalog";
import { enabledAgentIds, isInUse } from "../lib/enabled-agents";
import type { AgentProfile, Settings } from "../types";

export type { SettingsTab };

export interface AppSettingsDialogProps {
  isOpen: boolean;
  /** The tab shown when the dialog opens. */
  initialTab?: SettingsTab;
  persisted: Pick<PersistedStateHandle, "state" | "updateState">;
  agents: readonly AgentProfile[];
  refreshAgents: () => Promise<void>;
  catalog: AgentCatalogHandle;
  /** What Add, Update and Remove do; the app's one instance, shared with the screens that offer Add. */
  actions: AgentCatalogActions;
  recentFolders: readonly FolderOption[];
  onRemoveRecentFolder: (path: string) => void;
  onRunOnboarding: () => void;
  onClose: () => void;
}

/** The app's Settings dialog: General, and the agent catalog with its Add, Update and Remove. */
export function AppSettingsDialog({
  isOpen,
  initialTab,
  persisted: { state, updateState },
  agents,
  refreshAgents,
  catalog,
  actions,
  recentFolders,
  onRemoveRecentFolder,
  onRunOnboarding,
  onClose,
}: AppSettingsDialogProps) {
  if (!isOpen) return null;

  const { settings } = state;
  const enabledIds = enabledAgentIds(settings);
  const updateSettings = (patch: Partial<Settings>) =>
    updateState((prev) => ({ ...prev, settings: { ...prev.settings, ...patch } }));
  return (
    <SettingsPanel
      initialTab={initialTab}
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
        <AgentCatalogPanel
          agents={agents}
          settings={settings}
          refreshAgents={refreshAgents}
          catalog={catalog}
          actions={actions}
        />
      }
    />
  );
}
