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
  /** False until the saved state is loaded: until then `settings` are the defaults, not the user's. */
  isLoaded: boolean;
  updateState: (updater: (prev: PersistedState) => PersistedState) => void;
}

const NO_UPDATES: CatalogAgent[] = [];

/**
 * Which agent updates are pending, and which of them the notice still has to announce.
 * Nothing is pending before the saved state loads, so the notice cannot flash for a version
 * already announced, and a Dismiss cannot be lost to the load.
 */
export function useAgentUpdates({ catalog, settings, isLoaded, updateState }: UseAgentUpdatesOptions): AgentUpdates {
  const { notifiedUpdates } = settings;
  const pending = useMemo(
    () => (isLoaded ? pendingUpdates(catalog?.agents ?? [], enabledAgentIds(settings)) : NO_UPDATES),
    [catalog, settings, isLoaded],
  );
  const unnotified = useMemo(
    () => pending.filter((agent) => notifiedUpdates?.[agent.id] !== agent.updateVersion),
    [pending, notifiedUpdates],
  );

  const acknowledge = useCallback(() => {
    if (unnotified.length === 0) return;
    const announced = Object.fromEntries(unnotified.map((agent) => [agent.id, agent.updateVersion ?? '']));
    updateState((prev) => ({
      ...prev,
      settings: { ...prev.settings, notifiedUpdates: { ...prev.settings.notifiedUpdates, ...announced } },
    }));
  }, [unnotified, updateState]);

  return { updateCount: pending.length, unnotified, acknowledge };
}
