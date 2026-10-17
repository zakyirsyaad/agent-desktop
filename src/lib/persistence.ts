import { invoke } from '@tauri-apps/api/core';
import type { ChatMessage, PersistedState, Session, SessionWorktree } from '../types';
import type { AgentOptions } from './acp-draft';
import { toCommands, toConfigOptions, toModes } from '../hooks/useAcpSessions';

export const STATE_VERSION = 1;

export function emptyPersistedState(): PersistedState {
  return {
    version: STATE_VERSION,
    settings: { defaultAgentId: null, onboardingCompleted: false },
    recentFolders: [],
    sessions: [],
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSession(value: unknown): value is Session {
  return (
    isObject(value) &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.profileId === 'string' &&
    typeof value.cwd === 'string' &&
    typeof value.status === 'string' &&
    typeof value.createdAt === 'number'
  );
}

function isWorktree(value: unknown): value is SessionWorktree {
  return (
    isObject(value) &&
    typeof value.repoPath === 'string' &&
    typeof value.path === 'string' &&
    typeof value.branch === 'string'
  );
}

/** A session with a malformed worktree keeps everything else. */
function withValidWorktree(session: Session): Session {
  if (session.worktree == null || isWorktree(session.worktree)) return session;
  const { worktree: _dropped, ...rest } = session;
  return rest;
}

function toAgentOptions(raw: unknown): Record<string, AgentOptions> {
  if (!isObject(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw)
      .filter((entry): entry is [string, Record<string, unknown>] => isObject(entry[1]))
      .map(([profileId, options]) => [
        profileId,
        {
          modes: toModes(options.modes),
          configOptions: toConfigOptions(options.configOptions),
          commands: toCommands(options.commands),
        },
      ]),
  );
}

/**
 * Coerces whatever the backend returned into a well-formed state, keeping the
 * valid parts. A malformed file must degrade to "empty", never crash the UI.
 */
export function normalizePersistedState(raw: unknown): PersistedState {
  const empty = emptyPersistedState();
  if (!isObject(raw)) return empty;

  const settings = isObject(raw.settings) ? raw.settings : {};
  return {
    version: typeof raw.version === 'number' ? raw.version : STATE_VERSION,
    settings: {
      defaultAgentId: typeof settings.defaultAgentId === 'string' ? settings.defaultAgentId : null,
      onboardingCompleted: settings.onboardingCompleted === true,
    },
    recentFolders: Array.isArray(raw.recentFolders)
      ? raw.recentFolders.filter(
          (f): f is PersistedState['recentFolders'][number] =>
            isObject(f) && typeof f.name === 'string' && typeof f.path === 'string',
        )
      : [],
    sessions: Array.isArray(raw.sessions) ? raw.sessions.filter(isSession).map(withValidWorktree) : [],
    agentOptions: toAgentOptions(raw.agentOptions),
  };
}

export async function loadAppState(): Promise<PersistedState> {
  return normalizePersistedState(await invoke<unknown>('load_app_state'));
}

export function saveAppState(state: PersistedState): Promise<void> {
  return invoke('save_app_state', { state });
}

export async function loadTranscript(sessionId: string): Promise<ChatMessage[]> {
  const messages = await invoke<unknown>('load_transcript', { sessionId });
  return Array.isArray(messages) ? (messages as ChatMessage[]) : [];
}

export function saveTranscript(sessionId: string, messages: ChatMessage[]): Promise<void> {
  return invoke('save_transcript', { sessionId, messages });
}

export function deleteTranscript(sessionId: string): Promise<void> {
  return invoke('delete_transcript', { sessionId });
}
