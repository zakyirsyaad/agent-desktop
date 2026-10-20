import { invoke } from '@tauri-apps/api/core';
import { TRANSPORT_ACP, type ChatMessage, type PersistedState, type Session, type SessionWorktree } from '../types';
import { normalizeAppearance } from './appearance';
import type { AgentOptions } from './acp-draft';
import { toCommands, toConfigOptions, toModes } from '../hooks/useAcpSessions';

export const STATE_VERSION = 2;

export function emptyPersistedState(): PersistedState {
  return {
    version: STATE_VERSION,
    settings: { appearance: 'system', defaultAgentId: null, onboardingCompleted: false },
    recentFolders: [],
    sessions: [],
  };
}

/** Agent ids from before the ACP registry catalog, by the registry id that replaced them. */
export const LEGACY_AGENT_IDS: Readonly<Record<string, string>> = {
  'claude-code': 'claude-acp',
  qwen: 'qwen-code',
  codex: 'codex-acp',
};

/** Removed agents (Oh-My-Pi and Aider); saved settings that name them are cleaned on load. */
export const REMOVED_AGENT_IDS: readonly string[] = ['omp', 'aider'];

function isRemovedAgent(id: string): boolean {
  return REMOVED_AGENT_IDS.includes(id);
}

export function canonicalAgentId(id: string): string {
  return Object.hasOwn(LEGACY_AGENT_IDS, id) ? LEGACY_AGENT_IDS[id] : id;
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

/** A session keeps everything else when one of its optional fields is malformed. */
function withValidFields(session: Session): Session {
  const { worktree, pinned, archivedAt, namedByUser, hasUnread, ...rest } = session;
  return {
    ...rest,
    ...(worktree == null || isWorktree(worktree) ? { worktree } : {}),
    ...(typeof pinned === 'boolean' ? { pinned } : {}),
    ...(archivedAt == null || typeof archivedAt === 'number' ? { archivedAt } : {}),
    ...(typeof namedByUser === 'boolean' ? { namedByUser } : {}),
    ...(typeof hasUnread === 'boolean' ? { hasUnread } : {}),
  };
}

/** The remembered picks, keeping only string values. */
function toPreferredConfig(raw: unknown): Pick<AgentOptions, 'preferredConfig'> {
  if (!isObject(raw)) return {};
  const picks = Object.entries(raw).filter((entry): entry is [string, string] => typeof entry[1] === 'string');
  return picks.length > 0 ? { preferredConfig: Object.fromEntries(picks) } : {};
}

/**
 * Re-keys a record by canonical agent id. When an old and a new key collide,
 * the new key's value wins.
 */
function withCanonicalKeys<T>(record: Record<string, T>): Record<string, T> {
  const entries = Object.entries(record);
  const current = entries.filter(([id]) => canonicalAgentId(id) === id);
  const legacy = entries.filter(([id]) => canonicalAgentId(id) !== id);
  return Object.fromEntries(
    [...legacy, ...current].map(([id, value]) => [canonicalAgentId(id), value]).filter(([id]) => !isRemovedAgent(id as string)),
  );
}

function toAgentOptions(raw: unknown): Record<string, AgentOptions> {
  if (!isObject(raw)) return {};
  return withCanonicalKeys(
    Object.fromEntries(
      Object.entries(raw)
        .filter((entry): entry is [string, Record<string, unknown>] => isObject(entry[1]))
        .map(([profileId, options]) => [
          profileId,
          {
            modes: toModes(options.modes),
            configOptions: toConfigOptions(options.configOptions),
            commands: toCommands(options.commands),
            ...toPreferredConfig(options.preferredConfig),
          },
        ]),
    ),
  );
}

/** A list of canonical agent ids without repeats, or undefined when it is not a list of strings. */
function toAgentIdList(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw) || !raw.every((id) => typeof id === 'string')) return undefined;
  return [...new Set((raw as string[]).map(canonicalAgentId).filter((id) => !isRemovedAgent(id)))];
}

function toAgentVersions(raw: unknown): Record<string, string> {
  if (!isObject(raw) || !Object.values(raw).every((v) => typeof v === 'string')) return {};
  return withCanonicalKeys(raw as Record<string, string>);
}

function toDefaultAgentId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const id = canonicalAgentId(raw);
  return isRemovedAgent(id) ? null : id;
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
    version: STATE_VERSION,
    settings: {
      appearance: normalizeAppearance(settings.appearance),
      defaultAgentId: toDefaultAgentId(settings.defaultAgentId),
      onboardingCompleted: settings.onboardingCompleted === true,
      ...(toAgentIdList(settings.enabledAgents) ? { enabledAgents: toAgentIdList(settings.enabledAgents) } : {}),
      removedAgents: toAgentIdList(settings.removedAgents) ?? [],
      agentVersions: toAgentVersions(settings.agentVersions),
    },
    recentFolders: Array.isArray(raw.recentFolders)
      ? raw.recentFolders.filter(
          (f): f is PersistedState['recentFolders'][number] =>
            isObject(f) && typeof f.name === 'string' && typeof f.path === 'string',
        )
      : [],
    sessions: Array.isArray(raw.sessions)
      ? raw.sessions.filter(isSession).map(withValidFields).map((s) => ({ ...s, profileId: canonicalAgentId(s.profileId) }))
      : [],
    agentOptions: toAgentOptions(raw.agentOptions),
  };
}

/**
 * Terminal (PTY) sessions are gone, and sessions saved before ACP have no
 * transport at all, so only ACP sessions survive a load. Returns the same
 * state object when nothing is dropped.
 */
export function dropTerminalSessions(state: PersistedState): { state: PersistedState; droppedSessionIds: string[] } {
  const kept = state.sessions.filter((s) => s.transport === TRANSPORT_ACP);
  if (kept.length === state.sessions.length) return { state, droppedSessionIds: [] };
  const droppedSessionIds = state.sessions.filter((s) => s.transport !== TRANSPORT_ACP).map((s) => s.id);
  return { state: { ...state, sessions: kept }, droppedSessionIds };
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
