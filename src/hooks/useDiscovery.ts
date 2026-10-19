import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
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

  /** With `refresh`, the backend re-reads the login shell's PATH first (an agent may just have been installed). */
  const detect = useCallback(
    async (refresh: boolean) => {
      try {
        const profiles = await invoke<AgentProfile[]>('get_agent_profiles', { refresh });
        setAgents(Array.isArray(profiles) ? profiles : []);
      } catch (error) {
        onErrorRef.current(`Failed to detect agents: ${String(error)}`);
        throw error;
      }
    },
    [onErrorRef],
  );

  useEffect(() => {
    detect(false).catch(() => {
      // Already reported through onError.
    });
  }, [detect]);

  /** The backend refreshed the registry or found a changed install: read the profiles again. */
  useEffect(() => {
    let isMounted = true;
    const unlisten = listen('agent-profiles-changed', () => {
      // The event can arrive after unmount, while the listener is still being removed.
      if (!isMounted) return;
      detect(false).catch(() => {
        // Already reported through onError.
      });
    }).catch((error: unknown) => {
      if (isMounted) onErrorRef.current(`Could not watch for agent changes: ${String(error)}`);
      return null;
    });
    return () => {
      isMounted = false;
      void unlisten.then((stop) => stop?.());
    };
  }, [detect, onErrorRef]);

  /** "Check again": detects with a fresh PATH. */
  const refresh = useCallback(() => detect(true), [detect]);

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
