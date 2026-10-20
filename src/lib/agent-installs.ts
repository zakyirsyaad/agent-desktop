/**
 * Every agent install the app has started, kept for the app's lifetime rather than a panel's:
 * the user can pick another agent mid-install and come back to its live progress and result.
 */
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { InstallPhase } from './install-plan';
import type { InstallStep } from '../types';

/** The rejection `install_agent` gives when the user cancelled: not a failure. */
const INSTALL_CANCELLED = 'INSTALL_CANCELLED';

/** The `agent-install-progress` event's payload. */
export interface InstallProgress {
  agentId: string;
  stepIndex: number;
  stepCount: number;
  kind: InstallStep['kind'];
  name: string;
  phase: InstallPhase;
  receivedBytes: number;
  totalBytes: number | null;
}

export type InstallStatus = 'idle' | 'installing' | 'failed';

export interface InstallEntry {
  status: InstallStatus;
  progress: InstallProgress | null;
  error: string | null;
  /** What the job is: an install or an update, so a failure can say which. */
  action: 'install' | 'update';
  /** The install this entry is about; an older install's answer does not land on a newer one. */
  attempt: number;
}

export const IDLE_INSTALL: InstallEntry = { status: 'idle', progress: null, error: null, action: 'install', attempt: 0 };

let entries: ReadonlyMap<string, InstallEntry> = new Map();
const subscribers = new Set<() => void>();
let progressListener: Promise<UnlistenFn> | null = null;
/** Never reset, so an install from before a reset can never match an entry made after it. */
let lastAttempt = 0;
/** Attempts the user cancelled; one not yet sent to the backend is then never sent. */
const cancelledAttempts = new Set<number>();

export function installEntryOf(agentId: string): InstallEntry {
  return entries.get(agentId) ?? IDLE_INSTALL;
}

export function subscribeToInstalls(onChange: () => void): () => void {
  subscribers.add(onChange);
  return () => {
    subscribers.delete(onChange);
  };
}

function setEntry(agentId: string, entry: InstallEntry) {
  entries = new Map(entries).set(agentId, entry);
  subscribers.forEach((notify) => notify());
}

/** Updates an agent's entry only while it is still about `attempt`. */
function settle(agentId: string, attempt: number, next: (entry: InstallEntry) => InstallEntry) {
  const entry = installEntryOf(agentId);
  if (entry.attempt === attempt) setEntry(agentId, next(entry));
}

/**
 * Attaches the progress listener once and resolves when it is attached. A failed listen
 * resolves too: the install still runs and still reports how it ended; listen again next time.
 */
function ensureProgressListener(): Promise<UnlistenFn> {
  progressListener ??= listen<InstallProgress>('agent-install-progress', (event) => {
    const progress = event.payload;
    const entry = installEntryOf(progress.agentId);
    if (entry.status === 'installing') setEntry(progress.agentId, { ...entry, progress });
  }).catch(() => {
    progressListener = null;
    return () => {};
  });
  return progressListener;
}

/**
 * Starts installing an agent, unless it is already installing. The backend reports its
 * first phase at once, so the install starts only once the progress listener is attached.
 */
export function startInstall(agentId: string): void {
  startJob(agentId, 'install', () => {});
}

/**
 * Starts updating an installed agent, unless a job for it is already running. Same entry,
 * progress and cancel handling as an install; `onUpdated` gets the version now installed.
 */
export function startUpdate(agentId: string, onUpdated: (version: string) => void): void {
  startJob(agentId, 'update', onUpdated);
}

function startJob(agentId: string, action: InstallEntry['action'], onDone: (version: string) => void): void {
  if (installEntryOf(agentId).status === 'installing') return;
  lastAttempt += 1;
  const attempt = lastAttempt;
  setEntry(agentId, { status: 'installing', progress: null, error: null, action, attempt });
  void ensureProgressListener().then(() => runJob(agentId, attempt, action, onDone));
}

function runJob(agentId: string, attempt: number, action: InstallEntry['action'], onDone: (version: string) => void): void {
  if (cancelledAttempts.delete(attempt)) {
    // Cancelled while the listener attached: the backend never heard of it.
    settle(agentId, attempt, () => ({ ...IDLE_INSTALL, attempt }));
    return;
  }
  const command = action === 'update' ? 'update_agent' : 'install_agent';
  invoke<unknown>(command, { agentId })
    .then(
      // The backend emits `agent-profiles-changed`, which reloads the profiles.
      (result) => {
        settle(agentId, attempt, () => ({ ...IDLE_INSTALL, attempt }));
        if (action === 'update') onDone(String(result));
      },
      (error: unknown) => {
        const message = String(error);
        settle(agentId, attempt, () =>
          message === INSTALL_CANCELLED
            ? { ...IDLE_INSTALL, attempt }
            : { status: 'failed', progress: null, error: message, action, attempt },
        );
      },
    )
    .finally(() => cancelledAttempts.delete(attempt));
}

/** Forgets the failed installs of agents now ready, so a later missing agent offers Install, not an old failure. */
export function forgetFailedInstalls(readyAgentIds: readonly string[]): void {
  const stale = readyAgentIds.filter((agentId) => entries.get(agentId)?.status === 'failed');
  if (stale.length === 0) return;
  entries = new Map([...entries].filter(([agentId]) => !stale.includes(agentId)));
  subscribers.forEach((notify) => notify());
}

/**
 * Asks the backend to stop an agent's install; the install's own answer then says how it
 * ended. An install not yet sent to the backend is not sent at all.
 */
export function cancelInstall(agentId: string): void {
  const { attempt, status } = installEntryOf(agentId);
  if (status === 'installing') cancelledAttempts.add(attempt);
  invoke<boolean>('cancel_agent_install', { agentId }).catch((error: unknown) => {
    settle(agentId, attempt, (entry) => ({ ...entry, error: `Could not cancel the install: ${String(error)}` }));
  });
}

/** Tests only: forgets every install and the progress listener, so each test starts clean. */
export function resetAgentInstalls(): void {
  const listener = progressListener;
  progressListener = null;
  void listener?.then((stop) => stop());
  entries = new Map();
  cancelledAttempts.clear();
  subscribers.forEach((notify) => notify());
}
