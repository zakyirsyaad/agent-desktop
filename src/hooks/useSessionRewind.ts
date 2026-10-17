import { useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { AcpChoices } from '../lib/acp-draft';
import type { AcpEngine, FirstMessage } from './session-engine/useAcpEngine';
import { buildForkHandoff, buildRewindContext } from '../lib/fork-handoff';
import { createId } from '../lib/ids';
import type { AgentProfile, ChatMessage, Session } from '../types';

export interface SessionRewindDeps {
  agents: readonly AgentProfile[];
  transcripts: Readonly<Record<string, ChatMessage[]>>;
  acp: Pick<AcpEngine, 'start' | 'stop'>;
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
    if (session.status === 'running') stopsRef.current.set(session.id, acp.stop(session.id));
    // No agent session to resume: the next message starts a fresh agent.
    patchSession(session.id, { status: 'terminated', endedAt: Date.now(), acpSessionId: null });
    updateMessages(session.id, (prev) => before(prev, messageId));
    onRestore(session.id, message.content, message.attachments);
  };

  /** The handoff a fresh agent reads first; undefined when nothing is left of the conversation. */
  const handoffFor = async (session: Session): Promise<string | undefined> => {
    const messages = transcripts[session.id] ?? [];
    if (messages.length === 0) return undefined;
    const content = buildForkHandoff(messages, messages[messages.length - 1].id, {
      sourceSessionName: session.name,
      agentName: agents.find((a) => a.id === session.profileId)?.name ?? session.profileId,
      cwd: session.cwd,
      createdAt: Date.now(),
    });
    const handoffPath = await invoke<string>('write_fork_handoff', { handoffId: createId('rewind'), content });
    return buildRewindContext(handoffPath);
  };

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
      stopsRef.current.delete(session.id);
      if (cancelledRef.current.delete(session.id)) return;
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

  return { rewind, restart, isRestarting: (sessionId) => restarting.has(sessionId), cancelRestart };
}
