import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { AgentProfile, Workspace } from '../types';
import { useLatest } from './useLatest';

export interface AgentProfilesHandle {
  /** Agent profiles detected on this machine; empty until detection finishes. */
  agents: AgentProfile[];
  /** Detects again, e.g. after the user installed an agent during setup. */
  refresh: () => Promise<void>;
}

export function useAgentProfiles(onError: (message: string) => void): AgentProfilesHandle {
  const [agents, setAgents] = useState<AgentProfile[]>([]);
  const onErrorRef = useLatest(onError);

  const refresh = useCallback(async () => {
    try {
      const profiles = await invoke<AgentProfile[]>('get_agent_profiles');
      setAgents(Array.isArray(profiles) ? profiles : []);
    } catch (error) {
      onErrorRef.current(`Failed to detect agents: ${String(error)}`);
      throw error;
    }
  }, [onErrorRef]);

  useEffect(() => {
    refresh().catch(() => {
      // Already reported through onError.
    });
  }, [refresh]);

  return { agents, refresh };
}

/**
 * Project folders found under ~/developer, offered as suggestions during setup.
 * Failing to scan is not an error worth interrupting the user for: the native
 * folder dialog is always available.
 */
export function useSuggestedFolders(): Workspace[] {
  const [folders, setFolders] = useState<Workspace[]>([]);

  useEffect(() => {
    invoke<Workspace[]>('list_workspaces')
      .then((found) => setFolders(Array.isArray(found) ? found : []))
      .catch(() => setFolders([]));
  }, []);

  return folders;
}
