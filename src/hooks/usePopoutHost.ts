import { useEffect, useRef } from 'react';
import { emit, listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { ChatMessage, Session } from '../types';
import {
  POPOUT_ACTION_EVENT,
  POPOUT_READY_EVENT,
  SESSION_SNAPSHOT_EVENT,
  type PopoutAction,
  type PopoutActionPayload,
  type PopoutReadyPayload,
  buildSessionSnapshot,
} from '../lib/popout-bridge';
import { useLatest } from './useLatest';

export interface PopoutHostOptions {
  sessions: readonly Session[];
  transcripts: Record<string, ChatMessage[]>;
  ensureLoaded: (sessionId: string) => void;
  onAction: (sessionId: string, action: PopoutAction) => void;
}

/**
 * Main-window side of the popout bridge: answers popouts with snapshots of
 * their session, re-sends a snapshot whenever that session changes, and
 * performs the actions popouts forward.
 */
export function usePopoutHost({ sessions, transcripts, ensureLoaded, onAction }: PopoutHostOptions): void {
  const poppedOutRef = useRef(new Set<string>());
  const latest = useLatest({ sessions, transcripts, ensureLoaded, onAction });

  useEffect(() => {
    const sendSnapshot = (sessionId: string) => {
      const { sessions: current, transcripts: messages } = latest.current;
      emit(SESSION_SNAPSHOT_EVENT, buildSessionSnapshot(sessionId, current, messages)).catch(() => {});
    };

    let isCancelled = false;
    const unlisteners: UnlistenFn[] = [];
    const keep = (unlisten: UnlistenFn) => (isCancelled ? unlisten() : unlisteners.push(unlisten));

    listen<PopoutReadyPayload>(POPOUT_READY_EVENT, ({ payload }) => {
      poppedOutRef.current.add(payload.sessionId);
      latest.current.ensureLoaded(payload.sessionId);
      sendSnapshot(payload.sessionId);
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

  // Keep every open popout in sync with its session.
  useEffect(() => {
    poppedOutRef.current.forEach((sessionId) => {
      emit(SESSION_SNAPSHOT_EVENT, buildSessionSnapshot(sessionId, sessions, transcripts)).catch(() => {});
    });
  }, [sessions, transcripts]);
}
