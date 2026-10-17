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
  /** Puts a message back in the composer to edit. */
  onRestore: (text: string, attachments?: readonly string[]) => void;
  onNotice: (message: string) => void;
}

export interface SessionRewind {
  /** Takes an ACP session back to before one of the user's messages, which returns to the composer. */
  rewind: (session: Session, messageId: string) => Promise<void>;
  /** Continues a rewound session: a fresh agent is handed the conversation left, then gets the message. */
  restart: (session: Session, message: FirstMessage, choices: AcpChoices) => Promise<void>;
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

  const rewind = async (session: Session, messageId: string) => {
    const message = transcripts[session.id]?.find((m) => m.id === messageId);
    if (message?.role !== 'user') return;
    // A failed stop was reported; the conversation is left as it was.
    if (session.status === 'running' && !(await acp.stop(session.id))) return;
    // No agent session to resume: the next message starts a fresh agent.
    patchSession(session.id, { status: 'terminated', endedAt: Date.now(), acpSessionId: null });
    updateMessages(session.id, (prev) => before(prev, messageId));
    onRestore(message.content, message.attachments);
  };

  const restart = async (session: Session, message: FirstMessage, choices: AcpChoices) => {
    const messages = transcripts[session.id] ?? [];
    let context: string | undefined;
    if (messages.length > 0) {
      try {
        const content = buildForkHandoff(messages, messages[messages.length - 1].id, {
          sourceSessionName: session.name,
          agentName: agents.find((a) => a.id === session.profileId)?.name ?? session.profileId,
          cwd: session.cwd,
          createdAt: Date.now(),
        });
        const handoffPath = await invoke<string>('write_fork_handoff', { handoffId: createId('rewind'), content });
        context = buildRewindContext(handoffPath);
      } catch (error) {
        onNotice(`Could not continue the session: ${String(error)}`);
        onRestore(message.text, message.attachments);
        return;
      }
    }
    // Continuing an archived session brings it back into the list.
    patchSession(session.id, { status: 'running', endedAt: null, exitCode: null, archivedAt: null });
    void acp.start(session, { ...message, context }, choices);
  };

  return { rewind, restart };
}
