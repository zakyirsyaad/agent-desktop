import {
  ELICITATION_GONE,
  findElicitationIndex,
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
  /** The session's latest transcript (undefined when never loaded): only a card still waiting is answered. */
  transcriptOf: (sessionId: string) => readonly ChatMessage[] | undefined;
  /** Answers on their way, owned by the engine so they outlive a render; an entry lives until its call settles. */
  inFlight: Map<string, InFlightAnswer>;
}

const idOf = (sessionId: string, key: string) => `${sessionId}\n${key}`;
const textOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** What a card shows as soon as the user answers, before the agent has it. */
function optimisticStatus(answer: ElicitationAnswer, mode: ElicitationCard['mode']): ElicitationStatus {
  if (answer.action === 'decline') return 'declined';
  if (answer.action === 'cancel') return 'dismissed';
  return mode === 'url' ? 'opened' : 'submitted';
}

/** Puts the waiting card back, but only while it still shows the answer that failed. */
function putBack(messages: ChatMessage[], { card, status }: InFlightAnswer): ChatMessage[] | null {
  const index = findElicitationIndex(messages, card.key, status);
  if (index < 0) return null;
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
    const text = textOf(error);
    if (text === ELICITATION_GONE) {
      restore((messages) => setElicitationStatus(messages, entry.card.key, 'pending', 'unanswered'));
      reportError(ELICITATION_GONE);
      return;
    }
    restore((messages) => messages);
    reportError(`Could not answer the agent: ${text}`);
  };

  /**
   * An answer that failed after the turn was stopped or the agent ended: the
   * card is not answerable again, but a form or page the agent never got must
   * not read as sent. Gone is expected after a stop and is not reported.
   */
  const failForgotten = (sessionId: string, entry: InFlightAnswer, error: unknown) => {
    if (entry.status !== 'submitted' && entry.status !== 'opened') return;
    // A deleted session's transcript is gone; writing to it would save an empty one.
    if (!transcriptOf(sessionId)) return;
    updateMessages(sessionId, (prev) => setElicitationStatus(prev, entry.card.key, entry.status, 'unanswered'));
    const text = textOf(error);
    if (text !== ELICITATION_GONE) reportError(`Could not answer the agent: ${text}`);
  };

  const answer = (sessionId: string, key: string, reply: ElicitationAnswer) => {
    const id = idOf(sessionId, key);
    const transcript = transcriptOf(sessionId) ?? [];
    const card = transcript[findElicitationIndex(transcript, key, 'pending')]?.elicitation;
    if (!card || inFlight.has(id)) return;
    const entry: InFlightAnswer = { card, status: optimisticStatus(reply, card.mode) };
    inFlight.set(id, entry);
    updateMessages(sessionId, (prev) => setElicitationStatus(prev, key, 'pending', entry.status));
    acp.respondElicitation(sessionId, key, reply).then(
      () => {
        if (inFlight.get(id) === entry) inFlight.delete(id);
      },
      (error: unknown) => {
        // Forgotten meanwhile (Stop, or the agent ended): the card is not put back to be answered again.
        if (inFlight.get(id) !== entry) return failForgotten(sessionId, entry, error);
        inFlight.delete(id);
        fail(sessionId, entry, error);
      },
    );
  };

  const reopen = (sessionId: string, key: string) => {
    acp.reopenElicitationUrl(sessionId, key).catch((error: unknown) => {
      reportError(`Could not open the page again: ${textOf(error)}`);
    });
  };

  /** Drops a session's answers on their way: the turn was stopped or the agent ended, so none comes back. */
  const forget = (sessionId: string) => {
    for (const id of [...inFlight.keys()]) {
      if (id.startsWith(`${sessionId}\n`)) inFlight.delete(id);
    }
  };

  /**
   * The agent ended, never opened or was stopped: every card still open is left
   * unanswered. A transcript never loaded holds no card, and writing to it would save over its file.
   */
  const abandon = (sessionId: string) => {
    forget(sessionId);
    if (transcriptOf(sessionId)) updateMessages(sessionId, markElicitationsUnanswered);
  };

  return { answer, reopen, forget, abandon };
}
