import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { AgentProfile, Workspace } from '../types';
import { useLatest } from './useLatest';

/** Agent profiles detected on this machine; empty until detection finishes. */
export function useAgentProfiles(onError: (message: string) => void): AgentProfile[] {
  const [agents, setAgents] = useState<AgentProfile[]>([]);
  const onErrorRef = useLatest(onError);

  useEffect(() => {
    invoke<AgentProfile[]>('get_agent_profiles')
      .then((profiles) => setAgents(Array.isArray(profiles) ? profiles : []))
      .catch((error) => onErrorRef.current(`Failed to detect agents: ${String(error)}`));
  }, [onErrorRef]);

  return agents;
}

export interface WorkspacesHandle {
  workspaces: Workspace[];
  activeWorkspace: string;
  activeWorkspacePath: string | undefined;
  setActiveWorkspace: (name: string) => void;
}

/** Project folders discovered on disk, plus the selected one. */
export function useWorkspaces(onError: (message: string) => void): WorkspacesHandle {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [activeWorkspace, setActiveWorkspace] = useState('');
  const onErrorRef = useLatest(onError);

  useEffect(() => {
    invoke<Workspace[]>('list_workspaces')
      .then((discovered) => {
        const found = Array.isArray(discovered) ? discovered : [];
        setWorkspaces(found);
        if (found.length > 0) setActiveWorkspace(found[0].name);
      })
      .catch((error) => onErrorRef.current(`Failed to load workspaces: ${String(error)}`));
  }, [onErrorRef]);

  const activeWorkspacePath = workspaces.find((ws) => ws.name === activeWorkspace)?.path;
  return { workspaces, activeWorkspace, activeWorkspacePath, setActiveWorkspace };
}
