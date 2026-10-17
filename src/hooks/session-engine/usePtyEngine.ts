import { useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { StreamParser } from '../../lib/stream-parser';
import { applyParsedEvents } from '../../lib/apply-parsed-events';
import { setCardStatus, userMessage } from '../../lib/session-helpers';
import { createId } from '../../lib/ids';
import { usePtyEvents } from '../usePtyEvents';
import { useAgentActivity } from '../useAgentActivity';
import { useFirstPrompts } from '../useFirstPrompts';
import type { ActionCard, AgentProfile, ChatMessage, Session, SpawnOptions } from '../../types';

/** Ctrl+C: what a terminal agent reads as "stop what you are doing". */
const INTERRUPT_KEY = '\x03';

import type { PtyOutputStore } from '../../lib/pty-output-store';

export interface EngineDeps {
  sessions: readonly Session[];
  agents: readonly AgentProfile[];
  updateMessages: (sessionId: string, change: (prev: ChatMessage[]) => ChatMessage[]) => void;
  patchSession: (sessionId: string, patch: Partial<Session>) => void;
  reportError: (message: string) => void;
}

/**
 * Sessions whose agent runs as a TUI in a pseudo-terminal: its output is
 * parsed into chat messages, and the user's messages are typed into it.
 */
export interface PtyEngineDeps extends EngineDeps {
  /** Where raw output is kept for the session's terminal view. */
  output: PtyOutputStore;
}

export function usePtyEngine({ sessions, agents, updateMessages, patchSession, reportError, output }: PtyEngineDeps) {
  const parsersRef = useRef(new Map<string, StreamParser>());
  // Deleted sessions: their last output must not write a transcript back.
  const forgottenRef = useRef(new Set<string>());
  const resizeReportedRef = useRef(new Set<string>());
  const activity = useAgentActivity();

  const sendRaw = useCallback(
    async (sessionId: string, data: string): Promise<boolean> => {
      try {
        await invoke('send_input', { sessionId, data });
        return true;
      } catch (error) {
        reportError(`Failed to send input: ${String(error)}`);
        return false;
      }
    },
    [reportError],
  );

  /** Resolves to whether the agent took the message. */
  const send = useCallback(
    async (sessionId: string, text: string): Promise<boolean> => {
      if (!(await sendRaw(sessionId, `${text}\n`))) return false;
      updateMessages(sessionId, (prev) => [...prev, userMessage(text)]);
      return true;
    },
    [sendRaw, updateMessages],
  );

  const firstPrompts = useFirstPrompts(activity, sessions, (sessionId, prompt) => {
    void send(sessionId, prompt);
  });

  usePtyEvents({
    onOutput: (sessionId, data) => {
      if (forgottenRef.current.has(sessionId)) return;
      output.append(sessionId, data);
      activity.markOutput(sessionId);
      firstPrompts.noteOutput(sessionId);
      const profile = agents.find((a) => a.id === sessions.find((s) => s.id === sessionId)?.profileId);
      let parser = parsersRef.current.get(sessionId);
      if (!parser) {
        parser = new StreamParser({ approvalPattern: profile?.approval_pattern ?? undefined });
        parsersRef.current.set(sessionId, parser);
      }
      const events = parser.feed(data);
      if (events.length === 0) return;
      updateMessages(sessionId, (prev) =>
        applyParsedEvents(prev, events, { sessionId, profile, now: Date.now(), createId }),
      );
    },
    onExit: (sessionId, exitCode) => {
      parsersRef.current.delete(sessionId);
      if (forgottenRef.current.has(sessionId)) return;
      patchSession(sessionId, { status: 'terminated', endedAt: Date.now(), exitCode });
    },
  });

  /** Asks the backend to start the agent for an already recorded session. */
  const start = (session: Session, options: SpawnOptions, firstPrompt?: string) => {
    if (firstPrompt) firstPrompts.queue(session.id, firstPrompt);
    invoke('spawn_session', { sessionId: session.id, cwd: session.cwd, profileId: session.profileId, options }).catch(
      (error) => {
        // The PTY never came up, so the session cannot stay "running".
        firstPrompts.cancel(session.id);
        patchSession(session.id, { status: 'terminated', endedAt: Date.now() });
        const name = agents.find((a) => a.id === session.profileId)?.name ?? session.profileId;
        reportError(`Failed to start ${name}: ${String(error)}`);
      },
    );
  };

  const resolveCard = (sessionId: string, key: string, cardId: string | undefined, status: ActionCard['status']) => {
    updateMessages(sessionId, (prev) => setCardStatus(prev, cardId, status));
    void sendRaw(sessionId, key);
  };

  /** Ends the agent process; the session is marked ended when pty-exit arrives. */
  const stop = (sessionId: string) => {
    invoke('terminate_session', { sessionId }).catch((error) => {
      reportError(`Failed to stop the session: ${String(error)}`);
    });
  };

  const interrupt = (sessionId: string) => void sendRaw(sessionId, INTERRUPT_KEY);

  /** Tells the agent its terminal's size, so its TUI lays out for the view. */
  const resize = (sessionId: string, cols: number, rows: number) => {
    invoke('resize_session', { sessionId, cols, rows }).catch((error) => {
      // A view resizes on every layout change; one notice per session is enough.
      if (resizeReportedRef.current.has(sessionId)) return;
      resizeReportedRef.current.add(sessionId);
      reportError(`Failed to resize the terminal: ${String(error)}`);
    });
  };

  /** Drops a deleted session; anything it still prints is ignored. */
  const forget = (sessionId: string) => {
    forgottenRef.current.add(sessionId);
    parsersRef.current.delete(sessionId);
    output.forget(sessionId);
    firstPrompts.cancel(sessionId);
  };

  return { start, send, sendRaw, resolveCard, stop, interrupt, resize, forget, isBusy: activity.isBusy };
}

export type PtyEngine = ReturnType<typeof usePtyEngine>;
