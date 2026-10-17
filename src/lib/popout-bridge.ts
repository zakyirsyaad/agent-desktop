import type { ActionCard, ChatMessage, Session } from '../types';

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

export interface PopoutReadyPayload {
  sessionId: string;
}

export interface SessionSnapshotPayload {
  sessionId: string;
  session: Session | null;
  messages: ChatMessage[];
}

export type PopoutAction =
  | { kind: 'send'; text: string }
  | { kind: 'resolve-card'; cardId?: string; key: string; status: ActionCard['status'] }
  | { kind: 'choose-option'; cardId: string; optionId: string };

export interface PopoutActionPayload {
  sessionId: string;
  action: PopoutAction;
}

export function buildSessionSnapshot(
  sessionId: string,
  sessions: readonly Session[],
  transcripts: Record<string, ChatMessage[]>,
): SessionSnapshotPayload {
  return {
    sessionId,
    session: sessions.find((s) => s.id === sessionId) ?? null,
    messages: transcripts[sessionId] ?? [],
  };
}
