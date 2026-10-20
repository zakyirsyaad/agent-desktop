import { useEffect, useRef } from 'react';
import { emit, listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { AgentProfile, ChatMessage, Session } from '../types';
import { removedAgentNameFor, type EnabledSettings } from '../lib/enabled-agents';
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
  onAction: (sessionId: string, action: Exclude<PopoutAction, { kind: 'add-agent' }>) => void;
  /** The agent's live status (busy, waiting, context use), sent along with each snapshot. */
  statusOf?: (sessionId: string) => SessionLiveStatus;
  /**
   * What a popout needs to offer Add for a session whose agent was removed: it is sent the agent's name,
   * and its Add is performed here with `addAgent`.
   */
  agentCatalog?: {
    agents: readonly AgentProfile[];
    settings: EnabledSettings;
    addAgent: (agentId: string) => void;
  };
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

/** The name of the session's agent when it was removed and the session is not running, else null. */
function removedAgentNameOf(
  session: Session | undefined,
  catalog: PopoutHostOptions['agentCatalog'],
): string | null {
  return catalog ? removedAgentNameFor(session, catalog.agents, catalog.settings) : null;
}

const statusKeyOf = (status: SessionLiveStatus, removedAgentName: string | null) =>
  JSON.stringify([status, removedAgentName]);

export function usePopoutHost({
  sessions,
  transcripts,
  ensureLoaded,
  onAction,
  statusOf = () => IDLE_STATUS,
  agentCatalog,
}: PopoutHostOptions): void {
  // Open popouts, with what each was last sent: a snapshot goes out only when
  // that session, its transcript (both replaced, never mutated) or its agent's
  // live status changed.
  const poppedOutRef = useRef(new Map<string, SentSnapshot>());
  const latest = useLatest({ sessions, transcripts, ensureLoaded, onAction, statusOf, agentCatalog });

  useEffect(() => {
    const sendSnapshot = (sessionId: string) => {
      const { sessions: current, transcripts: messages, statusOf: liveStatusOf, agentCatalog: catalog } =
        latest.current;
      const status = liveStatusOf(sessionId);
      const removedName = removedAgentNameOf(current.find((s) => s.id === sessionId), catalog);
      poppedOutRef.current.set(sessionId, {
        session: current.find((s) => s.id === sessionId),
        messages: messages[sessionId],
        statusKey: statusKeyOf(status, removedName),
      });
      emit(SESSION_SNAPSHOT_EVENT, buildSessionSnapshot(sessionId, current, messages, status, removedName)).catch(() => {});
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
      const { action } = payload;
      if (action.kind !== 'add-agent') return latest.current.onAction(payload.sessionId, action);
      const session = latest.current.sessions.find((s) => s.id === payload.sessionId);
      if (session) latest.current.agentCatalog?.addAgent(session.profileId);
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
      const removedName = removedAgentNameOf(session, agentCatalog);
      const statusKey = statusKeyOf(status, removedName);
      if (session === last.session && messages === last.messages && statusKey === last.statusKey) return;
      poppedOutRef.current.set(sessionId, { session, messages, statusKey });
      emit(SESSION_SNAPSHOT_EVENT, buildSessionSnapshot(sessionId, sessions, transcripts, status, removedName)).catch(() => {});
    });
  });
}
