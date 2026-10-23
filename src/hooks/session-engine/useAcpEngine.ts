import { useCallback, useRef, useState } from 'react';
import {
  applyAcpUpdate,
  applyPermissionRequest,
  applyReplayUpdate,
  closeImportedTurn,
  closeTurn,
  noteModeChange,
  pendingCardsInTurn,
  reopenPermissionCard,
  resolvePermissionCard,
  type PermissionRequestPayload,
} from '../../lib/acp-events';
import { changesToApply, NO_CHOICES, type AcpChange, type AcpChoices, type AgentOptions } from '../../lib/acp-draft';
import { findCard, titleFromPrompt, userMessage, withoutMessage } from '../../lib/session-helpers';
import { createId } from '../../lib/ids';
import { toCommands, useAcpSessions, type AcpSessionInfo, type TurnResult } from '../useAcpSessions';
import { useLatest } from '../useLatest';
import { useBatchedUpdates } from '../useBatchedUpdates';
import type { AgentProfile, ChatMessage, ElicitationCard, Session } from '../../types';
import { parseAuthRequired, type AuthMethod } from '../../lib/acp-auth';
import { isUnknownSessionError } from '../../lib/acp-load-error';
import { writeConversationHandoff } from '../../lib/session-handoff';
import { applyElicitation, completeElicitation, dismissPendingElicitations } from '../../lib/acp-elicitation';
import { elicitationActions, type InFlightAnswer } from './elicitation-actions';

const NOT_ENDED_NORMALLY = new Set(['refusal', 'max_tokens', 'max_turn_requests']);

function turnEndNotice(stopReason: string | undefined, error: string | undefined): string | null {
  if (error) return `The agent's turn failed: ${error}`;
  if (stopReason && NOT_ENDED_NORMALLY.has(stopReason)) return `The agent stopped early (${stopReason}).`;
  return null;
}

function isCommandsUpdate(update: unknown): update is { availableCommands: unknown } {
  return typeof update === 'object' && update !== null && (update as { sessionUpdate?: unknown }).sessionUpdate === 'available_commands_update';
}

/** The title in a session_info_update, if it carries a usable one. */
function sessionTitleOf(update: unknown): string | undefined {
  if (typeof update !== 'object' || update === null) return undefined;
  const { sessionUpdate, title } = update as { sessionUpdate?: unknown; title?: unknown };
  if (sessionUpdate !== 'session_info_update' || typeof title !== 'string') return undefined;
  return title.trim() || undefined;
}

/** The message a session starts (or resumes) with. */
export interface FirstMessage {
  text: string;
  attachments?: readonly string[];
  /** Sent to the agent ahead of the text but not shown: what a rewound session's fresh agent is handed. */
  context?: string;
}

export type AttentionReason = 'needs-answer' | 'finished' | 'failed';

export interface EngineDeps {
  sessions: readonly Session[];
  agents: readonly AgentProfile[];
  updateMessages: (sessionId: string, change: (prev: ChatMessage[]) => ChatMessage[]) => void;
  patchSession: (sessionId: string, patch: Partial<Session>) => void;
  reportError: (message: string) => void;
}

interface LaunchOptions {
  first?: FirstMessage;
  /** What the user picked in the composer before the agent ran. */
  choices: AcpChoices;
  /** False for a fork: it keeps the mode the user chose in the source session. */
  applySafeMode: boolean;
  /** "start" or "resume", for the error message. */
  action: string;
  /**
   * The agent could not open the session, and the caller made its record: it
   * undoes that record itself, so the session is not marked terminated and no
   * sign-in is tied to it.
   */
  onOpenError?: (error: unknown) => void;
}

export interface AcpEngineDeps extends EngineDeps {
  /** The agent needs the user's answer, or ended its turn: worth a notification when the user is away. */
  onAttention?: (sessionId: string, reason: AttentionReason) => void;
  /** The agent refused to start, or to answer, until the user signs in: the ways it offers and the unsent message. */
  onAuthRequired: (session: Pick<Session, 'id' | 'profileId' | 'cwd'>, methods: AuthMethod[], unsent?: FirstMessage) => void;
  /** Called with what an agent offers when one of its sessions opens or its commands change. */
  rememberOptions: (profileId: string, options: Partial<AgentOptions>) => void;
  /** Each session's conversation: handed to a fresh ACP session that does not have it. */
  transcripts?: Readonly<Record<string, ChatMessage[]>>;
}

/**
 * Sessions whose agent speaks the Agent Client Protocol: structured updates
 * become chat messages, permission requests become cards with the agent's own
 * choices, and modes and config options are changed live.
 */
export function useAcpEngine({
  sessions,
  agents,
  updateMessages,
  patchSession,
  reportError,
  rememberOptions,
  onAuthRequired,
  onAttention,
  transcripts,
}: AcpEngineDeps) {
  const [starting, setStarting] = useState<ReadonlySet<string>>(new Set());
  // An agent streams many updates per second: they apply once a frame, still in order.
  const queued = useBatchedUpdates(updateMessages);
  /**
   * A change that is not a streamed chunk (the user answered, the turn ended):
   * land what the agent already sent first, then apply this at once.
   */
  const updateNow = (sessionId: string, updater: (prev: ChatMessage[]) => ChatMessage[]) => {
    queued.flush();
    updateMessages(sessionId, updater);
  };
  // Sessions the app stopped (deleted, or stopped while starting): their late
  // events must not write a transcript back, and a start still in flight must
  // end the agent as soon as it is up.
  const stoppedRef = useRef(new Set<string>());
  // Sessions whose `session/load` replay is still streaming: their user chunks
  // open a turn instead of landing in the agent's current reply.
  const replayingRef = useRef(new Set<string>());
  // Each session's launch token: a newer launch (or a stop) replaces it, so a
  // continuation that settles later can tell it was superseded and must not
  // touch the session, which may belong to another launch by then.
  const launchGenRef = useRef(new Map<string, number>());
  const bumpLaunchGen = (sessionId: string) => {
    const gen = (launchGenRef.current.get(sessionId) ?? 0) + 1;
    launchGenRef.current.set(sessionId, gen);
    return gen;
  };
  const isCurrentLaunch = (sessionId: string, gen: number) =>
    launchGenRef.current.get(sessionId) === gen;
  // Each session's latest prompt: an agent that refuses it for a sign-in hands it back to the composer.
  const lastPromptRef = useRef(new Map<string, { message: ChatMessage; context?: string }>());
  // Hidden context a refused prompt carried (a rewound session's conversation): it goes out with the next message.
  const unsentContextRef = useRef(new Map<string, string>());
  // The picks a session was opened with when its agent refused to open it until the user signs in.
  const refusedChoicesRef = useRef(new Map<string, AcpChoices>());
  // Elicitation answers on their way, with the card each came from (never what the user typed).
  const elicitationsInFlightRef = useRef(new Map<string, InFlightAnswer>());
  const ctx = (sessionId: string) => ({ sessionId, now: Date.now(), createId });
  const isStopped = (sessionId: string) => stoppedRef.current.has(sessionId);
  const unlessStopped =
    <A extends unknown[]>(handle: (sessionId: string, ...args: A) => void) =>
    (sessionId: string, ...args: A) => {
      if (!isStopped(sessionId)) handle(sessionId, ...args);
    };

  const acp = useAcpSessions({
    onUpdate: unlessStopped((sessionId, update: unknown) => {
      const title = sessionTitleOf(update);
      if (title) {
        // The agent's own title (e.g. a summary) beats one cut from the first
        // prompt, but never a name the user gave; it is held to the same
        // one-line, bounded shape.
        const isNamedByUser = sessions.find((s) => s.id === sessionId)?.namedByUser === true;
        if (!isNamedByUser) patchSession(sessionId, { name: titleFromPrompt(title) });
        return;
      }
      if (isCommandsUpdate(update)) {
        const profileId = sessions.find((s) => s.id === sessionId)?.profileId;
        if (profileId) rememberOptions(profileId, { commands: toCommands(update.availableCommands) });
        return;
      }
      queued.update(sessionId, (prev) =>
        replayingRef.current.has(sessionId)
          ? applyReplayUpdate(prev, update, ctx(sessionId))
          : applyAcpUpdate(prev, update, ctx(sessionId)),
      );
    }),
    onPermission: unlessStopped((sessionId, request: PermissionRequestPayload) => {
      updateNow(sessionId, (prev) => applyPermissionRequest(prev, request, ctx(sessionId)));
      onAttention?.(sessionId, 'needs-answer');
    }),
    onElicitation: unlessStopped((sessionId, card: ElicitationCard) => {
      updateNow(sessionId, (prev) => applyElicitation(prev, card, ctx(sessionId)));
      onAttention?.(sessionId, 'needs-answer');
    }),
    onElicitationComplete: unlessStopped((sessionId, key: string) => {
      updateNow(sessionId, (prev) => completeElicitation(prev, key));
    }),
    onTurnEnd: unlessStopped((sessionId, { stopReason, error }: TurnResult) => {
      updateNow(sessionId, closeTurn);
      const authMethods = parseAuthRequired(error);
      if (authMethods) {
        handBackForSignIn(sessionId, authMethods);
        return;
      }
      lastPromptRef.current.delete(sessionId);
      const notice = turnEndNotice(stopReason, error);
      if (notice) reportError(notice);
      // A turn the user cancelled needs no notification: they were there.
      if (stopReason !== 'cancelled') onAttention?.(sessionId, notice ? 'failed' : 'finished');
    }),
    onExit: unlessStopped((sessionId, code: number | null) => {
      updateNow(sessionId, closeTurn);
      // The agent leaves no more updates: the cards it showed are the ones marked unanswered.
      elicitations.abandon(sessionId);
      patchSession(sessionId, { status: 'terminated', endedAt: Date.now(), exitCode: code });
    }),
    onError: reportError,
  });

  // Read when a call settles, long after the render that made it: the latest sessions and transcripts, not that render's.
  const sessionsRef = useLatest(sessions);
  const transcriptsRef = useLatest(transcripts);
  const transcriptOf = (sessionId: string) => transcriptsRef.current?.[sessionId];
  const elicitations = elicitationActions({
    acp,
    updateMessages: updateNow,
    reportError,
    transcriptOf,
    inFlight: elicitationsInFlightRef.current,
  });

  const markStarting = useCallback((sessionId: string, isStarting: boolean) => {
    setStarting((prev) => {
      const next = new Set(prev);
      if (isStarting) next.add(sessionId);
      else next.delete(sessionId);
      return next;
    });
  }, []);

  /** The agent opened the session but refused the prompt until the user signs in. */
  const handBackForSignIn = (sessionId: string, methods: AuthMethod[]) => {
    const session = sessions.find((s) => s.id === sessionId);
    const refused = lastPromptRef.current.get(sessionId);
    lastPromptRef.current.delete(sessionId);
    const message = refused?.message;
    // The turn end before this one lands first; the message goes back at once.
    if (message) updateNow(sessionId, (prev) => withoutMessage(prev, message.id));
    if (refused?.context) unsentContextRef.current.set(sessionId, refused.context);
    if (!session) return;
    const unsent = message ? { text: message.content, attachments: message.attachments } : undefined;
    onAuthRequired(session, methods, unsent);
  };

  /** The context a refused prompt left for this session, once: the next message the agent takes carries it. */
  const takeUnsentContext = (sessionId: string): string | undefined => {
    const context = unsentContextRef.current.get(sessionId);
    unsentContextRef.current.delete(sessionId);
    return context;
  };

  const reportFailure = (what: string) => (error: unknown) => reportError(`${what}: ${String(error)}`);

  /** Prompts the agent with a message already shown in the chat; removes it if the prompt is refused. */
  const prompt = async (sessionId: string, message: ChatMessage, context?: string): Promise<boolean> => {
    lastPromptRef.current.set(sessionId, { message, context });
    try {
      await acp.prompt(sessionId, context ? `${context}\n\n${message.content}` : message.content, message.attachments);
      return true;
    } catch (error) {
      lastPromptRef.current.delete(sessionId);
      if (context) unsentContextRef.current.set(sessionId, context);
      updateNow(sessionId, (prev) => withoutMessage(prev, message.id));
      reportError(`Failed to send the message: ${String(error)}`);
      return false;
    }
  };

  /** Resolves to whether the agent took the message. */
  const send = async (sessionId: string, text: string, attachments: readonly string[] = []): Promise<boolean> => {
    // Shown before the prompt goes out, so the agent's reply always lands after it.
    const message = userMessage(text, attachments);
    updateNow(sessionId, (prev) => [...prev, message]);
    return prompt(sessionId, message, takeUnsentContext(sessionId));
  };

  /**
   * Applies the user's picks, or the safe mode. A failed change leaves the
   * agent as it started, which the composer shows; the session stays usable.
   * Resolves with the agent's options once the changes are made, as it last reported them.
   */
  const applyChanges = async (
    sessionId: string,
    info: AcpSessionInfo,
    options: LaunchOptions,
  ): Promise<Pick<AcpSessionInfo, 'modes' | 'configOptions'>> => {
    let current: Pick<AcpSessionInfo, 'modes' | 'configOptions'> = info;
    const done = new Set<string>();
    const keyOf = (change: AcpChange) => (change.kind === 'mode' ? 'mode' : `config:${change.configId}`);
    // One change at a time, each checked against the agent's latest state: what
    // is on offer can depend on what was just set (an effort on its model).
    for (;;) {
      const change = changesToApply(current, options.choices, options.applySafeMode).find((c) => !done.has(keyOf(c)));
      if (!change || isStopped(sessionId)) return current;
      done.add(keyOf(change));
      try {
        if (change.kind === 'mode') await acp.setMode(sessionId, change.modeId);
        else {
          const reported = await acp.setConfigOption(sessionId, change.configId, change.value);
          if (reported.length > 0) current = { ...current, configOptions: reported };
        }
      } catch (error) {
        // Stopped meanwhile (the user pressed Stop): the failure is expected.
        if (!isStopped(sessionId)) reportError(`Could not apply the session settings: ${String(error)}`);
      }
    }
  };

  /**
   * Opens an already recorded session in its agent, then applies the picks and
   * the first prompt. Resolves to false when the agent could not be opened or
   * prompted for a reason other than a sign-in (reported); a refusal for a
   * sign-in hands the message back itself.
   */
  const launch = async (session: Session, open: () => Promise<AcpSessionInfo>, options: LaunchOptions): Promise<boolean> => {
    // A session ended earlier and now resumed must hear from its agent again.
    stoppedRef.current.delete(session.id);
    refusedChoicesRef.current.delete(session.id);
    // Taken before the open starts: a later launch or stop supersedes this one.
    const gen = bumpLaunchGen(session.id);
    const message = options.first ? userMessage(options.first.text, options.first.attachments) : null;
    if (message) updateNow(session.id, (prev) => [...prev, message]);
    // Busy until the first prompt is out: a message sent meanwhile would race it.
    markStarting(session.id, true);
    try {
      let info: AcpSessionInfo;
      try {
        info = await open();
      } catch (error) {
        // A newer launch owns the session now: this failure is not its failure.
        if (!isCurrentLaunch(session.id, gen)) {
          // The message this launch showed was never prompted: take it back.
          if (message) updateNow(session.id, (prev) => withoutMessage(prev, message.id));
          return true;
        }
        if (isStopped(session.id)) return true;
        if (message) updateNow(session.id, (prev) => withoutMessage(prev, message.id));
        elicitations.abandon(session.id);
        if (options.onOpenError) {
          // The caller made this record: it removes it rather than ending a session the user never had.
          options.onOpenError(error);
          return false;
        }
        // The message's hidden context goes out with the next one.
        if (options.first?.context) unsentContextRef.current.set(session.id, options.first.context);
        patchSession(session.id, { status: 'terminated', endedAt: Date.now() });
        const authMethods = parseAuthRequired(error);
        if (authMethods) {
          refusedChoicesRef.current.set(session.id, options.choices);
          onAuthRequired(session, authMethods, options.first);
          return true;
        }
        const name = agents.find((a) => a.id === session.profileId)?.name ?? session.profileId;
        reportError(`Failed to ${options.action} ${name}: ${String(error)}`);
        return false;
      }
      // Stopped or superseded while opening: the agent is already being ended, and
      // none of the answer belongs to the session anymore.
      if (isStopped(session.id)) {
        // Stopped while starting: the backend could not end an agent it did not know yet.
        acp.stop(session.id).catch(reportFailure('Failed to stop the agent'));
        return true;
      }
      if (!isCurrentLaunch(session.id, gen)) {
        // A newer launch owns the session: the message this one showed was never prompted.
        if (message) updateNow(session.id, (prev) => withoutMessage(prev, message.id));
        return true;
      }
      rememberOptions(session.profileId, { modes: info.modes, configOptions: info.configOptions });
      if (info.acpSessionId) patchSession(session.id, { acpSessionId: info.acpSessionId });
      const settled = await applyChanges(session.id, info, options);
      // Superseded while the picks were applied: a newer launch owns the session.
      if (!isCurrentLaunch(session.id, gen)) {
        // The message this launch showed was never prompted: take it back.
        if (message) queued.update(session.id, (prev) => withoutMessage(prev, message.id));
        return true;
      }
      // What the agent offers now, after the picks: an effort list follows its model,
      // and the next draft should offer what this session ended up with.
      if (settled.configOptions !== info.configOptions) {
        rememberOptions(session.profileId, { configOptions: settled.configOptions });
      }
      if (message && isCurrentLaunch(session.id, gen) && !isStopped(session.id)) {
        // A launch's own context (a rewind's) is newer than one a refused prompt left behind.
        const leftOver = takeUnsentContext(session.id);
        return await prompt(session.id, message, options.first?.context ?? leftOver);
      }
      return true;
    } finally {
      // A newer launch owns the starting flag now; it clears it itself.
      if (isCurrentLaunch(session.id, gen)) markStarting(session.id, false);
    }
  };

  const start = (session: Session, first?: FirstMessage, choices: AcpChoices = NO_CHOICES) =>
    launch(session, () => acp.start(session.id, session.cwd, session.profileId), {
      first,
      choices,
      applySafeMode: true,
      action: 'start',
    });

  /** Continues an ended session in a fresh agent process through the agent's own session/resume or session/load. */
  const resume = (session: Session, acpSessionId: string, first?: FirstMessage, choices: AcpChoices = NO_CHOICES) =>
    launch(session, () => acp.reopen(session.id, session.cwd, session.profileId, acpSessionId), {
      first,
      choices,
      applySafeMode: true,
      action: 'resume',
    });

  /**
   * Opens a session the agent started outside Zorvo, folding its
   * `session/load` replay into the chat. A failure is the caller's to undo:
   * the record it made was never a session of the user's.
   */
  const importSession = async (
    session: Session,
    choices: AcpChoices,
    onOpenError: (error: unknown) => void,
  ): Promise<boolean> => {
    const { id, acpSessionId } = session;
    // Nothing to load without the agent's own id: the backend would send
    // `session/load` with an empty one, and its error would read as an import
    // failure. The caller undoes the record it made for the import.
    if (!acpSessionId) {
      onOpenError(new Error('This session has no agent session id.'));
      return false;
    }
    // The replay's user chunks open turns only while the import is opening.
    replayingRef.current.add(id);
    let reopenedWith: AcpSessionInfo['reopenedWith'];
    let gen = 0;
    try {
      const opening = launch(
        session,
        async () => {
          const info = await acp.importSession(id, session.cwd, session.profileId, acpSessionId);
          reopenedWith = info.reopenedWith;
          return info;
        },
        { choices, applySafeMode: true, action: 'import', onOpenError },
      );
      // `launch` takes its token before it first awaits, so this is this import's.
      gen = launchGenRef.current.get(id) ?? 0;
      const isOpened = await opening;
      // A newer launch (a resume after a stop) owns the session now: a late answer
      // must not close its live turn or mark its history as elsewhere.
      if (!isCurrentLaunch(id, gen)) return isOpened;
      // A deleted session has no transcript to close, and none may be written back;
      // a stopped one that is still listed still needs its last replay reply closed.
      if (isOpened) {
        if (sessionsRef.current.some((s) => s.id === id)) updateNow(id, closeImportedTurn);
        if (reopenedWith === 'resume') patchSession(id, { historyElsewhere: true });
      }
      return isOpened;
    } finally {
      // Only the launch that still owns the session clears its replay route: a newer
      // import of the same id has its own.
      if (isCurrentLaunch(id, gen)) replayingRef.current.delete(id);
    }
  };

  /** The conversation so far, written for a fresh ACP session to read; undefined when there is none. */
  const handoffFor = (session: Session) =>
    writeConversationHandoff(
      session,
      transcripts?.[session.id] ?? [],
      agents.find((a) => a.id === session.profileId)?.name ?? session.profileId,
      'signin',
    );

  /**
   * After a sign-in: sends a refused message in a fresh agent, which picks up
   * the new credentials. The session is reopened through the agent's own
   * session/resume or session/load when it has one to reopen, else started
   * anew. Resolves to false when the message did not go out, for a reason
   * other than a sign-in: the caller gives it back to the user.
   */
  const retryAfterSignIn = async (sessionId: string, message: FirstMessage): Promise<boolean> => {
    const session = sessions.find((s) => s.id === sessionId);
    // Deleted meanwhile: there is no session to give the message back to.
    if (!session) return true;
    const canReopen = acp.info[sessionId]?.canReopen === true;
    // Taken before stop, which forgets it.
    const hidden = message.context ?? takeUnsentContext(sessionId);
    const wasTerminated = session.status === 'terminated';
    const { acpSessionId } = session;
    const startsAnew = !acpSessionId || !(wasTerminated || canReopen);
    // A fresh ACP session does not have the conversation: it is handed over, before the old agent stops.
    let handoff: string | undefined;
    if (startsAnew && !hidden) {
      try {
        handoff = await handoffFor(session);
      } catch (error) {
        reportError(`Could not hand the conversation to the agent: ${String(error)}`);
        return false;
      }
    }
    const first = { ...message, context: hidden ?? handoff };
    if (!wasTerminated && !(await stop(sessionId))) {
      // The agent may still run: its events count again, and the context waits for the next message.
      stoppedRef.current.delete(sessionId);
      if (hidden) unsentContextRef.current.set(sessionId, hidden);
      return false;
    }
    // A session refused at start was ended: it runs again, with the picks it was opened with.
    const choices = refusedChoicesRef.current.get(sessionId) ?? NO_CHOICES;
    if (wasTerminated) patchSession(sessionId, { status: 'running', endedAt: null, exitCode: null, archivedAt: null });
    if (!acpSessionId || startsAnew) return start(session, first, choices);
    // Reached only when the agent does not know the old session: the conversation goes with the message.
    const openNew = async () => {
      const context = hidden ? undefined : await handoffFor(session);
      if (context) unsentContextRef.current.set(sessionId, context);
      return acp.start(session.id, session.cwd, session.profileId).catch((error: unknown) => {
        if (context) unsentContextRef.current.delete(sessionId);
        throw error;
      });
    };
    const reopenSession = () => acp.reopen(session.id, session.cwd, session.profileId, acpSessionId);
    // A session refused at a prompt may have had no turn the agent kept: when the agent does not know it,
    // it starts anew. Any other failure keeps the session, whose conversation the agent may still have.
    const reopen = wasTerminated
      ? reopenSession
      : () => reopenSession().catch((error: unknown) => (isUnknownSessionError(error) ? openNew() : Promise.reject(error)));
    return launch(session, reopen, { first, choices, applySafeMode: true, action: 'resume' });
  };

  const fork = (sourceSessionId: string, session: Session) =>
    launch(session, () => acp.fork(sourceSessionId, session.id, session.cwd), {
      choices: NO_CHOICES,
      applySafeMode: false,
      action: 'fork',
    });

  const chooseOption = (sessionId: string, messages: ChatMessage[] | undefined, cardId: string, optionId: string) => {
    const card = findCard(messages, cardId);
    if (card?.status !== 'pending') return;
    if (card.requestId === undefined) {
      reportError('This request can no longer be answered.');
      return;
    }
    updateNow(sessionId, (prev) => resolvePermissionCard(prev, cardId, optionId));
    acp.respondPermission(sessionId, card.requestId, optionId).catch((error) => {
      // The agent is still waiting, so the card must stay answerable.
      updateNow(sessionId, (prev) => reopenPermissionCard(prev, cardId));
      reportError(`Could not answer the agent: ${String(error)}`);
    });
  };

  /**
   * Ends the agent process (deleted session, or a start the user stopped);
   * later events from it are ignored. Resolves with whether it stopped, after
   * the backend has done it.
   */
  const stop = (sessionId: string): Promise<boolean> => {
    // What the agent already sent belongs before anything this stop makes:
    // a deleted session's transcript goes away after these land, not before.
    queued.flush();
    // The backend cancels the open requests, and the agent's later events (its exit) are ignored.
    elicitations.abandon(sessionId);
    stoppedRef.current.add(sessionId);
    // A launch still opening is superseded. An import that made the record keeps its
    // token: when it answers it still closes its last reply and sets the history note;
    // a resume in the meantime bumps the token and makes it stale.
    if (!replayingRef.current.has(sessionId)) bumpLaunchGen(sessionId);
    // A stopped import no longer replays: if the session is resumed, its updates fold normally.
    replayingRef.current.delete(sessionId);
    // Stopped while opening: it is no longer starting, so its row can be deleted before the open settles.
    markStarting(sessionId, false);
    lastPromptRef.current.delete(sessionId);
    unsentContextRef.current.delete(sessionId);
    refusedChoicesRef.current.delete(sessionId);
    return acp.stop(sessionId).then(
      () => true,
      (error) => {
        reportFailure('Failed to stop the agent')(error);
        return false;
      },
    );
  };

  /**
   * Stops the agent's current turn. ACP asks the client to answer the
   * permission requests it is still waiting on as cancelled; an agent blocked
   * on one would otherwise never end the turn. While the agent is still
   * starting, stopping ends the session instead.
   */
  const interrupt = (sessionId: string, messages: ChatMessage[] | undefined) => {
    if (starting.has(sessionId)) {
      void stop(sessionId);
      patchSession(sessionId, { status: 'terminated', endedAt: Date.now() });
      return;
    }
    for (const card of pendingCardsInTurn(messages ?? [])) {
      if (card.requestId === undefined) continue;
      acp.respondPermission(sessionId, card.requestId, null).catch(reportFailure('Could not answer the agent'));
    }
    // The backend answers the open elicitations as cancelled and names them; one that comes after stays open.
    elicitations.forget(sessionId);
    acp.cancel(sessionId).then(
      (cancelled) => updateNow(sessionId, (prev) => dismissPendingElicitations(prev, new Set(cancelled))),
      reportFailure('Failed to stop the agent'),
    );
  };

  const setMode = (sessionId: string, modeId: string) => {
    // Read now, not once the change lands: a request asked meanwhile is in the new mode.
    const askedBefore = new Set(pendingCardsInTurn(transcriptOf(sessionId) ?? []).map((card) => card.id));
    acp
      .setMode(sessionId, modeId)
      .then(() => {
        // A request made before the switch stays right: the agent is still
        // waiting for its answer, and the card says why it did not go away.
        if (askedBefore.size > 0) updateNow(sessionId, (prev) => noteModeChange(prev, askedBefore));
      })
      .catch(reportFailure('Could not change the mode'));
  };

  /** Resolves with the options the agent reports after the change, or null when it failed (reported). */
  const setConfigOption = (sessionId: string, configId: string, value: string) =>
    acp.setConfigOption(sessionId, configId, value).catch((error: unknown) => {
      reportFailure('Could not change the setting')(error);
      return null;
    });

  const isBusy = (sessionId: string) => starting.has(sessionId) || acp.isBusy(sessionId);

  return {
    info: acp.info,
    start,
    resume,
    importSession,
    listSessions: acp.listSessions,
    retryAfterSignIn,
    fork,
    send,
    chooseOption,
    answerElicitation: elicitations.answer,
    reopenElicitationUrl: elicitations.reopen,
    interrupt,
    setMode,
    setConfigOption,
    stop,
    /** Drops a removed session's queued transcript changes before its transcript is deleted. */
    forgetQueued: queued.forget,
    isBusy,
    busySinceOf: acp.busySinceOf,
    canFork: acp.canFork,
  };
}

export type AcpEngine = ReturnType<typeof useAcpEngine>;
