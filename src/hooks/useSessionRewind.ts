import { useRef, useState } from 'react';
import { keptConfigOf, type AcpChoices, type RewoundOptions } from '../lib/acp-draft';
import type { AcpEngine, FirstMessage } from './session-engine/useAcpEngine';
import { writeConversationHandoff } from '../lib/session-handoff';
import type { AgentProfile, ChatMessage, Session } from '../types';

export interface SessionRewindDeps {
  agents: readonly AgentProfile[];
  transcripts: Readonly<Record<string, ChatMessage[]>>;
  acp: Pick<AcpEngine, 'info' | 'start' | 'stop'>;
  patchSession: (sessionId: string, patch: Partial<Session>) => void;
  updateMessages: (sessionId: string, updater: (prev: ChatMessage[]) => ChatMessage[]) => void;
  /** Puts a message back in the composer of the session it was written for. */
  onRestore: (sessionId: string, text: string, attachments?: readonly string[]) => void;
  onNotice: (message: string) => void;
}

export interface SessionRewind {
  /** Takes an ACP session back to before one of the user's messages, which returns to the composer. */
  rewind: (session: Session, messageId: string) => void;
  /** Continues a rewound session: a fresh agent is handed the conversation left, then gets the message. */
  restart: (session: Session, message: FirstMessage, choices: AcpChoices) => Promise<void>;
  /** True while a restart writes its handoff, before the agent starts: the session takes no other message. */
  isRestarting: (sessionId: string) => boolean;
  /** Stop pressed before the fresh agent started: none starts, and the message goes back to the composer. */
  cancelRestart: (sessionId: string) => void;
  /**
   * The model and effort a rewound session ran with, and the lists they came
   * from (an effort list follows its model), for its fresh agent to start with again.
   */
  rewoundOptionsOf: (sessionId: string) => RewoundOptions | undefined;
}

/** Messages before the one with `messageId`; all of them when it is gone. */
const before = (messages: readonly ChatMessage[], messageId: string): ChatMessage[] => {
  const index = messages.findIndex((m) => m.id === messageId);
  return index < 0 ? [...messages] : messages.slice(0, index);
};

/**
 * Rewinds a session in place. An agent cannot forget part of a conversation,
 * so its agent is ended and the session cannot be resumed; the next message
 * starts a fresh agent for the same session, handed what is left of the
 * conversation in a file. Files the agent changed stay as they are.
 */
export function useSessionRewind(deps: SessionRewindDeps): SessionRewind {
  const { agents, transcripts, acp, patchSession, updateMessages, onRestore, onNotice } = deps;
  // A fresh agent for a session waits until its old one is gone: a late stop would end the new one.
  const stopsRef = useRef(new Map<string, Promise<boolean>>());
  // Read and written at once, so a second send cannot start a second agent.
  const restartingRef = useRef(new Set<string>());
  const cancelledRef = useRef(new Set<string>());
  // The message each pending restart carries, put back in the composer the moment Stop is pressed.
  const pendingRef = useRef(new Map<string, FirstMessage>());
  // Read before the stop forgets the agent's options: a fresh agent should not switch models.
  const rewoundOptionsRef = useRef(new Map<string, RewoundOptions>());
  const [restarting, setRestarting] = useState<ReadonlySet<string>>(() => new Set());

  const markRestarting = (sessionId: string, isRestarting: boolean) => {
    if (isRestarting) restartingRef.current.add(sessionId);
    else restartingRef.current.delete(sessionId);
    setRestarting(new Set(restartingRef.current));
  };

  const rewind = (session: Session, messageId: string) => {
    const message = transcripts[session.id]?.find((m) => m.id === messageId);
    if (message?.role !== 'user') return;
    // Done at once, while this session is still the one shown: its message goes
    // back into its own composer. The old agent's late events are ignored.
    const configOptions = acp.info[session.id]?.configOptions ?? [];
    const preferredConfig = keptConfigOf(configOptions);
    if (Object.keys(preferredConfig).length > 0) {
      rewoundOptionsRef.current.set(session.id, { configOptions, preferredConfig });
    }
    if (session.status === 'running') {
      const stopped = acp.stop(session.id);
      stopsRef.current.set(session.id, stopped);
      // Kept only while it is under way: a session never continued leaves nothing behind.
      void stopped.finally(() => {
        if (stopsRef.current.get(session.id) === stopped) stopsRef.current.delete(session.id);
      });
    }
    // No agent session to resume: the next message starts a fresh agent.
    patchSession(session.id, { status: 'terminated', endedAt: Date.now(), acpSessionId: null });
    updateMessages(session.id, (prev) => before(prev, messageId));
    onRestore(session.id, message.content, message.attachments);
  };

  /** The handoff a fresh agent reads first; undefined when nothing is left of the conversation. */
  const handoffFor = (session: Session): Promise<string | undefined> =>
    writeConversationHandoff(
      session,
      transcripts[session.id] ?? [],
      agents.find((a) => a.id === session.profileId)?.name ?? session.profileId,
      'rewind',
    );

  const restart = async (session: Session, message: FirstMessage, choices: AcpChoices) => {
    if (restartingRef.current.has(session.id)) return;
    markRestarting(session.id, true);
    pendingRef.current.set(session.id, message);
    try {
      let context: string | undefined;
      try {
        context = await handoffFor(session);
      } catch (error) {
        // Stopped meanwhile: the message is back already, and the failure is moot.
        if (cancelledRef.current.delete(session.id)) return;
        onNotice(`Could not continue the session: ${String(error)}`);
        onRestore(session.id, message.text, message.attachments);
        return;
      }
      await stopsRef.current.get(session.id);
      if (cancelledRef.current.delete(session.id)) return;
      rewoundOptionsRef.current.delete(session.id);
      // Continuing an archived session brings it back into the list.
      patchSession(session.id, { status: 'running', endedAt: null, exitCode: null, archivedAt: null });
      // The engine marks the session as starting before this returns, so it stays busy throughout.
      void acp.start(session, { ...message, context }, choices);
    } finally {
      pendingRef.current.delete(session.id);
      markRestarting(session.id, false);
    }
  };

  /** Restored at once, not when the wait ends: a draft typed meanwhile is never overwritten. */
  const cancelRestart = (sessionId: string) => {
    const message = pendingRef.current.get(sessionId);
    if (!message || cancelledRef.current.has(sessionId)) return;
    cancelledRef.current.add(sessionId);
    onRestore(sessionId, message.text, message.attachments);
  };

  return {
    rewind,
    restart,
    isRestarting: (sessionId) => restarting.has(sessionId),
    cancelRestart,
    rewoundOptionsOf: (sessionId) => rewoundOptionsRef.current.get(sessionId),
  };
}
