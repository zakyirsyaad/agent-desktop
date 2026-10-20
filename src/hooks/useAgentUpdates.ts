import { useCallback, useMemo } from 'react';
import { pendingUpdates } from '../lib/agent-catalog';
import { enabledAgentIds } from '../lib/enabled-agents';
import type { AgentCatalog, CatalogAgent, PersistedState, Settings } from '../types';

export interface AgentUpdates {
  /** Updates waiting for agents in use; drives the badge. */
  updateCount: number;
  /** Pending updates whose version the user has not been told about yet. */
  unnotified: CatalogAgent[];
  /** Records the versions in `unnotified` as announced, so the notice does not come back for them. */
  acknowledge: () => void;
}

export interface UseAgentUpdatesOptions {
  catalog: AgentCatalog | null;
  settings: Settings;
  updateState: (updater: (prev: PersistedState) => PersistedState) => void;
}

/** Which agent updates are pending, and which of them the notice still has to announce. */
export function useAgentUpdates({ catalog, settings, updateState }: UseAgentUpdatesOptions): AgentUpdates {
  const { notifiedUpdates } = settings;
  const pending = useMemo(
    () => pendingUpdates(catalog?.agents ?? [], enabledAgentIds(settings)),
    [catalog, settings],
  );
  const unnotified = useMemo(
    () => pending.filter((agent) => notifiedUpdates?.[agent.id] !== agent.updateVersion),
    [pending, notifiedUpdates],
  );

  const acknowledge = useCallback(() => {
    const announced = Object.fromEntries(unnotified.map((agent) => [agent.id, agent.updateVersion ?? '']));
    updateState((prev) => ({
      ...prev,
      settings: { ...prev.settings, notifiedUpdates: { ...prev.settings.notifiedUpdates, ...announced } },
    }));
  }, [unnotified, updateState]);

  return { updateCount: pending.length, unnotified, acknowledge };
}
