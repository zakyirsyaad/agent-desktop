import { useCallback, useSyncExternalStore } from 'react';
import {
  cancelInstall,
  IDLE_INSTALL,
  installEntryOf,
  startInstall,
  subscribeToInstalls,
  type InstallProgress,
  type InstallStatus,
} from '../lib/agent-installs';

export type { InstallProgress, InstallStatus } from '../lib/agent-installs';

export interface AgentInstall {
  status: InstallStatus;
  progress: InstallProgress | null;
  error: string | null;
  install: () => void;
  cancel: () => void;
}

/**
 * One agent's install: its live progress and how it ended. The state lives in
 * `lib/agent-installs`, so it survives picking another agent or the panel unmounting.
 * Whenever an install job ends, however it ended, the backend emits `agent-profiles-changed`,
 * which reloads the profiles.
 */
export function useAgentInstall(agentId: string | undefined): AgentInstall {
  const entry = useSyncExternalStore(subscribeToInstalls, () =>
    agentId ? installEntryOf(agentId) : IDLE_INSTALL,
  );
  const install = useCallback(() => {
    if (agentId) startInstall(agentId);
  }, [agentId]);
  const cancel = useCallback(() => {
    if (agentId) cancelInstall(agentId);
  }, [agentId]);
  return { status: entry.status, progress: entry.progress, error: entry.error, install, cancel };
}
