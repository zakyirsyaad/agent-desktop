import type { ChatMessage, ContextUsage, ElicitationAnswer, Session } from '../types';

/**
 * Events between the main window and session popouts.
 *
 * The main window is the single writer: it parses agent output and persists
 * state. A popout only renders snapshots the main window sends and forwards
 * the user's actions back, so two windows never overwrite each other's files.
 */
export const POPOUT_READY_EVENT = 'popout-ready';
export const SESSION_SNAPSHOT_EVENT = 'session-snapshot';
export const POPOUT_ACTION_EVENT = 'popout-action';
/** A popout window is going away; the main window stops syncing it. */
export const POPOUT_CLOSED_EVENT = 'popout-closed';

export interface PopoutReadyPayload {
  sessionId: string;
}

/** What the main window knows live about a session's agent, beyond its saved state. */
export interface SessionLiveStatus {
  isBusy: boolean;
  isWaiting: boolean;
  contextUsage?: ContextUsage;
}

export const IDLE_STATUS: SessionLiveStatus = { isBusy: false, isWaiting: false };

export interface SessionSnapshotPayload {
  sessionId: string;
  session: Session | null;
  messages: ChatMessage[];
  status: SessionLiveStatus;
  /** The session's agent when it was removed from use: the popout offers to add it again instead of a composer. */
  removedAgentName: string | null;
}

export type PopoutAction =
  | { kind: 'send'; text: string }
  | { kind: 'choose-option'; cardId: string; optionId: string }
  | { kind: 'answer-elicitation'; key: string; answer: ElicitationAnswer }
  | { kind: 'reopen-elicitation-url'; key: string }
  | { kind: 'stop' }
  | { kind: 'add-agent' };

export interface PopoutActionPayload {
  sessionId: string;
  action: PopoutAction;
}

export function buildSessionSnapshot(
  sessionId: string,
  sessions: readonly Session[],
  transcripts: Record<string, ChatMessage[]>,
  status: SessionLiveStatus = IDLE_STATUS,
  removedAgentName: string | null = null,
): SessionSnapshotPayload {
  return {
    sessionId,
    session: sessions.find((s) => s.id === sessionId) ?? null,
    messages: transcripts[sessionId] ?? [],
    status,
    removedAgentName,
  };
}
