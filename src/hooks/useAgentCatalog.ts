import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { AgentCatalog } from '../types';

export interface AgentCatalogHandle {
  /** Null until the first load finishes. */
  catalog: AgentCatalog | null;
  /**
   * The message of the last failed load, cleared by the next successful one; while no
   * load has failed, the message that watching for agent changes failed, which stays.
   */
  error: string | null;
  reload: () => Promise<void>;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The agent catalog, read again whenever the backend reports that agent data changed. */
export function useAgentCatalog(): AgentCatalogHandle {
  const [catalog, setCatalog] = useState<AgentCatalog | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [watchError, setWatchError] = useState<string | null>(null);

  const latestRequest = useRef(0);

  /** Only the newest started load may set state, so a slow older one cannot overwrite fresher data. */
  const reload = useCallback(async () => {
    latestRequest.current += 1;
    const request = latestRequest.current;
    try {
      const loaded = await invoke<AgentCatalog>('get_agent_catalog');
      if (request !== latestRequest.current) return;
      setCatalog(loaded);
      setLoadError(null);
    } catch (failure) {
      if (request === latestRequest.current) setLoadError(messageOf(failure));
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
      if (isMounted) setWatchError(`Could not watch for agent changes: ${messageOf(failure)}`);
      return null;
    });
    return () => {
      isMounted = false;
      void unlisten.then((stop) => stop?.());
    };
  }, [reload]);

  return { catalog, error: loadError ?? watchError, reload };
}
