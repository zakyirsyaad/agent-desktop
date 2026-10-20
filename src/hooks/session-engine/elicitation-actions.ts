import {
  ELICITATION_GONE,
  markElicitationsUnanswered,
  parseInvalidElicitation,
  rejectElicitationSubmit,
  setElicitationStatus,
} from '../../lib/acp-elicitation';
import type { ChatMessage, ElicitationAnswer, ElicitationCard, ElicitationStatus } from '../../types';

/** The backend calls an answer needs. */
export interface ElicitationTransport {
  respondElicitation: (sessionId: string, key: string, answer: ElicitationAnswer) => Promise<void>;
  reopenElicitationUrl: (sessionId: string, key: string) => Promise<void>;
}

/**
 * An answer on its way: the card as it was while waiting (the transcript drops
 * its fields and url at once) and the status it was moved to. It holds nothing
 * the user typed.
 */
export interface InFlightAnswer {
  card: ElicitationCard;
  status: ElicitationStatus;
}

export interface ElicitationActionDeps {
  acp: ElicitationTransport;
  updateMessages: (sessionId: string, change: (prev: ChatMessage[]) => ChatMessage[]) => void;
  reportError: (message: string) => void;
  /** The session's transcript as last rendered: only a card still waiting is answered. */
  transcriptOf: (sessionId: string) => readonly ChatMessage[];
  /** Answers on their way, owned by the engine so they outlive a render; an entry lives until its call settles. */
  inFlight: Map<string, InFlightAnswer>;
}

const idOf = (sessionId: string, key: string) => `${sessionId}\n${key}`;

/** What a card shows as soon as the user answers, before the agent has it. */
function optimisticStatus(answer: ElicitationAnswer, mode: ElicitationCard['mode']): ElicitationStatus {
  if (answer.action === 'decline') return 'declined';
  if (answer.action === 'cancel') return 'dismissed';
  return mode === 'url' ? 'opened' : 'submitted';
}

/** Puts the waiting card back, but only while it still shows the answer that failed. */
function putBack(messages: ChatMessage[], { card, status }: InFlightAnswer): ChatMessage[] | null {
  const index = messages.findIndex((m) => m.elicitation?.key === card.key);
  if (index < 0 || messages[index].elicitation?.status !== status) return null;
  return messages.map((m, i) => (i === index ? { ...m, elicitation: card } : m));
}

/**
 * Answering an agent's elicitation from its card. The card moves on at once;
 * when the answer fails it comes back to be answered again, unless the user
 * stopped the turn or the agent ended meanwhile (`forget`).
 */
export function elicitationActions({ acp, updateMessages, reportError, transcriptOf, inFlight }: ElicitationActionDeps) {
  const fail = (sessionId: string, entry: InFlightAnswer, error: unknown) => {
    const restore = (change: (messages: ChatMessage[]) => ChatMessage[]) =>
      updateMessages(sessionId, (prev) => {
        const restored = putBack(prev, entry);
        return restored ? change(restored) : prev;
      });
    const errors = parseInvalidElicitation(error);
    if (errors) return restore((messages) => rejectElicitationSubmit(messages, entry.card.key, errors));
    const text = error instanceof Error ? error.message : String(error);
    if (text === ELICITATION_GONE) {
      restore((messages) => setElicitationStatus(messages, entry.card.key, 'unanswered'));
      reportError(ELICITATION_GONE);
      return;
    }
    restore((messages) => messages);
    reportError(`Could not answer the agent: ${text}`);
  };

  const answer = (sessionId: string, key: string, reply: ElicitationAnswer) => {
    const id = idOf(sessionId, key);
    const card = transcriptOf(sessionId).find((m) => m.elicitation?.key === key)?.elicitation;
    if (card?.status !== 'pending' || inFlight.has(id)) return;
    const entry: InFlightAnswer = { card, status: optimisticStatus(reply, card.mode) };
    inFlight.set(id, entry);
    updateMessages(sessionId, (prev) => setElicitationStatus(prev, key, entry.status));
    acp.respondElicitation(sessionId, key, reply).then(
      () => {
        if (inFlight.get(id) === entry) inFlight.delete(id);
      },
      (error: unknown) => {
        // Forgotten meanwhile (Stop, or the agent ended): the failure is expected and the card stays as it is.
        if (inFlight.get(id) !== entry) return;
        inFlight.delete(id);
        fail(sessionId, entry, error);
      },
    );
  };

  const reopen = (sessionId: string, key: string) => {
    acp.reopenElicitationUrl(sessionId, key).catch((error: unknown) => {
      reportError(`Could not open the page again: ${error instanceof Error ? error.message : String(error)}`);
    });
  };

  /** Drops a session's answers on their way: the turn was stopped or the agent ended, so none comes back. */
  const forget = (sessionId: string) => {
    for (const id of [...inFlight.keys()]) {
      if (id.startsWith(`${sessionId}\n`)) inFlight.delete(id);
    }
  };

  /** The agent ended (or never opened): every card still open is left unanswered. */
  const abandon = (sessionId: string) => {
    forget(sessionId);
    updateMessages(sessionId, markElicitationsUnanswered);
  };

  return { answer, reopen, forget, abandon };
}
