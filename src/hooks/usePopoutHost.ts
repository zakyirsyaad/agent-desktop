import { useEffect, useRef } from 'react';
import { emit, listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { ChatMessage, Session } from '../types';
import {
  POPOUT_ACTION_EVENT,
  POPOUT_CLOSED_EVENT,
  POPOUT_READY_EVENT,
  SESSION_SNAPSHOT_EVENT,
  type PopoutAction,
  type PopoutActionPayload,
  type PopoutReadyPayload,
  type SessionLiveStatus,
  IDLE_STATUS,
  buildSessionSnapshot,
} from '../lib/popout-bridge';
import { useLatest } from './useLatest';

export interface PopoutHostOptions {
  sessions: readonly Session[];
  transcripts: Record<string, ChatMessage[]>;
  ensureLoaded: (sessionId: string) => void;
  onAction: (sessionId: string, action: PopoutAction) => void;
  /** The agent's live status (busy, waiting, context use), sent along with each snapshot. */
  statusOf?: (sessionId: string) => SessionLiveStatus;
}

/**
 * Main-window side of the popout bridge: answers popouts with snapshots of
 * their session, re-sends a snapshot whenever that session changes, and
 * performs the actions popouts forward.
 */
interface SentSnapshot {
  session: Session | undefined;
  messages: ChatMessage[] | undefined;
  statusKey: string;
}

const statusKeyOf = (status: SessionLiveStatus) => JSON.stringify(status);

export function usePopoutHost({
  sessions,
  transcripts,
  ensureLoaded,
  onAction,
  statusOf = () => IDLE_STATUS,
}: PopoutHostOptions): void {
  // Open popouts, with what each was last sent: a snapshot goes out only when
  // that session, its transcript (both replaced, never mutated) or its agent's
  // live status changed.
  const poppedOutRef = useRef(new Map<string, SentSnapshot>());
  const latest = useLatest({ sessions, transcripts, ensureLoaded, onAction, statusOf });

  useEffect(() => {
    const sendSnapshot = (sessionId: string) => {
      const { sessions: current, transcripts: messages, statusOf: liveStatusOf } = latest.current;
      const status = liveStatusOf(sessionId);
      poppedOutRef.current.set(sessionId, {
        session: current.find((s) => s.id === sessionId),
        messages: messages[sessionId],
        statusKey: statusKeyOf(status),
      });
      emit(SESSION_SNAPSHOT_EVENT, buildSessionSnapshot(sessionId, current, messages, status)).catch(() => {});
    };

    let isCancelled = false;
    const unlisteners: UnlistenFn[] = [];
    const keep = (unlisten: UnlistenFn) => (isCancelled ? unlisten() : unlisteners.push(unlisten));

    listen<PopoutReadyPayload>(POPOUT_READY_EVENT, ({ payload }) => {
      latest.current.ensureLoaded(payload.sessionId);
      sendSnapshot(payload.sessionId);
    })
      .then(keep)
      .catch(() => {});

    listen<PopoutReadyPayload>(POPOUT_CLOSED_EVENT, ({ payload }) => {
      poppedOutRef.current.delete(payload.sessionId);
    })
      .then(keep)
      .catch(() => {});

    listen<PopoutActionPayload>(POPOUT_ACTION_EVENT, ({ payload }) => {
      latest.current.onAction(payload.sessionId, payload.action);
    })
      .then(keep)
      .catch(() => {});

    return () => {
      isCancelled = true;
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, [latest]);

  // Keep every open popout in sync, sending only what changed. Runs after
  // every render: the live status lives outside sessions and transcripts.
  useEffect(() => {
    poppedOutRef.current.forEach((last, sessionId) => {
      const session = sessions.find((s) => s.id === sessionId);
      const messages = transcripts[sessionId];
      const status = statusOf(sessionId);
      const statusKey = statusKeyOf(status);
      if (session === last.session && messages === last.messages && statusKey === last.statusKey) return;
      poppedOutRef.current.set(sessionId, { session, messages, statusKey });
      emit(SESSION_SNAPSHOT_EVENT, buildSessionSnapshot(sessionId, sessions, transcripts, status)).catch(() => {});
    });
  });
}
