import { invoke } from '@tauri-apps/api/core';
import { startInstall, startUpdate } from '../lib/agent-installs';
import { withAgentAdded, withAgentRemoved } from '../lib/agent-catalog';
import { enabledAgentIds } from '../lib/enabled-agents';
import { patchSessionIn } from '../lib/session-helpers';
import type { AgentCatalogHandle } from './useAgentCatalog';
import type { PersistedStateHandle } from './usePersistedState';
import type { AgentProfile, Session, Settings } from '../types';

export interface AgentCatalogActions {
  /** Puts the agent in use, and installs it when the catalog (else its profile) says it is not installed. */
  addAgent: (id: string) => void;
  /** Updates the agent; on success records and saves its version, then reloads profiles and catalog. */
  updateAgent: (id: string) => void;
  /** Stops the agent's running sessions, takes it out of use and deletes Zorvo's copy of it. */
  removeAgent: (id: string) => Promise<void>;
  runningSessionCount: (id: string) => number;
}

export interface AgentCatalogActionsArgs {
  updateState: PersistedStateHandle['updateState'];
  /** Rejects when the write failed. */
  saveNow: () => Promise<void>;
  agents: readonly AgentProfile[];
  sessions: readonly Session[];
  /** The ACP engine's stop: resolves false when the agent could not be stopped (already reported). */
  stopSession: (sessionId: string) => Promise<boolean>;
  /** Reads the profiles again, without the registry refresh that Check again does. */
  reloadAgents: () => Promise<void>;
  catalog: Pick<AgentCatalogHandle, 'catalog' | 'reload'>;
}

const ignore = () => {
  // A failed reload is reported where it happens: the profiles' notice, the catalog's own error.
};

/** What the catalog's Add, Update and Remove do to the saved settings, the sessions and the backend. */
export function useAgentCatalogActions({
  updateState,
  saveNow,
  agents,
  sessions,
  stopSession,
  reloadAgents,
  catalog,
}: AgentCatalogActionsArgs): AgentCatalogActions {
  const reloadCatalog = catalog.reload;

  const updateSettings = (change: (settings: Settings) => Settings) =>
    updateState((prev) => ({ ...prev, settings: change(prev.settings) }));

  const runningSessionsOf = (id: string) =>
    sessions.filter((session) => session.profileId === id && session.status === 'running');

  /** The catalog row is read fresh from the backend; a profile can lag behind it. */
  const needsInstall = (id: string) => {
    const row = catalog.catalog?.agents.find((agent) => agent.id === id);
    if (row) return row.status === 'not_installed';
    const profile = agents.find((agent) => agent.id === id);
    return profile !== undefined && profile.availability !== 'ready';
  };

  const addAgent = (id: string) => {
    updateSettings((settings) => withAgentAdded(settings, id, enabledAgentIds(settings)));
    if (needsInstall(id)) startInstall(id);
  };

  /** Rejects when the version could not be saved: the profiles would then be read from the old file. */
  const recordUpdate = async (id: string, version: string) => {
    updateSettings((settings) => ({ ...settings, agentVersions: { ...settings.agentVersions, [id]: version } }));
    try {
      await saveNow();
    } catch (error) {
      throw new Error(`Could not save version ${version}: ${String(error)}`);
    }
    await Promise.all([reloadAgents().catch(ignore), reloadCatalog()]);
  };

  const updateAgent = (id: string) => {
    // A refused update emits no `agent-profiles-changed`, so the catalog is read again here.
    startUpdate(id, (version) => recordUpdate(id, version), () => void reloadCatalog());
  };

  const stopRunningSessions = (id: string) =>
    Promise.all(
      runningSessionsOf(id).map(async (session) => {
        if (await stopSession(session.id)) {
          updateState((prev) => patchSessionIn(prev, session.id, { status: 'terminated', endedAt: Date.now() }));
        }
      }),
    );

  const removeAgent = async (id: string) => {
    await stopRunningSessions(id);
    updateSettings((settings) => withAgentRemoved(settings, id, enabledAgentIds(settings)));
    // The backend keeps the prerequisites the agents still in use need, read from the saved state.
    try {
      await saveNow();
    } catch (error) {
      throw new Error(`Could not save the removal: ${String(error)}`);
    }
    try {
      await invoke('remove_agent_install', { agentId: id });
    } catch (error) {
      throw new Error(`Could not delete Zorvo's copy: ${String(error)}`);
    }
  };

  return { addAgent, updateAgent, removeAgent, runningSessionCount: (id) => runningSessionsOf(id).length };
}
