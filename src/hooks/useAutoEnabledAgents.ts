import { useEffect } from 'react';
import { withAutoEnabled } from '../lib/enabled-agents';
import type { AgentProfile } from '../types';
import type { PersistedStateHandle } from './usePersistedState';

/** Installed registry agents join the ones in use, and each one's version is recorded. */
export function useAutoEnabledAgents(
  agents: readonly AgentProfile[],
  isLoaded: boolean,
  updateState: PersistedStateHandle['updateState'],
): void {
  useEffect(() => {
    if (!isLoaded || agents.length === 0) return;
    updateState((prev) => {
      const settings = withAutoEnabled(prev.settings, agents);
      return settings === prev.settings ? prev : { ...prev, settings };
    });
  }, [agents, isLoaded, updateState]);
}
