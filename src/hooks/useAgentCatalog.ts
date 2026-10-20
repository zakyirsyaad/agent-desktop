import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { AgentCatalog } from '../types';

export interface AgentCatalogHandle {
  /** Null until the first load finishes. */
  catalog: AgentCatalog | null;
  /** The message of the last failed load; cleared by the next successful one. */
  error: string | null;
  reload: () => Promise<void>;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The agent catalog, read again whenever the backend reports that agent data changed. */
export function useAgentCatalog(): AgentCatalogHandle {
  const [catalog, setCatalog] = useState<AgentCatalog | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setCatalog(await invoke<AgentCatalog>('get_agent_catalog'));
      setError(null);
    } catch (failure) {
      setError(messageOf(failure));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    let isMounted = true;
    const unlisten = listen('agent-profiles-changed', () => {
      if (isMounted) void reload();
    }).catch((failure: unknown) => {
      if (isMounted) setError(`Could not watch for agent changes: ${messageOf(failure)}`);
      return null;
    });
    return () => {
      isMounted = false;
      void unlisten.then((stop) => stop?.());
    };
  }, [reload]);

  return { catalog, error, reload };
}
