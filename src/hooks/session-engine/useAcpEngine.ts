import { useCallback, useRef, useState } from 'react';
import {
  applyAcpUpdate,
  applyPermissionRequest,
  closeTurn,
  pendingCardsInTurn,
  reopenPermissionCard,
  resolvePermissionCard,
  type PermissionRequestPayload,
} from '../../lib/acp-events';
import { changesToApply, NO_CHOICES, type AcpChange, type AcpChoices, type AgentOptions } from '../../lib/acp-draft';
import { findCard, titleFromPrompt, userMessage, withoutMessage } from '../../lib/session-helpers';
import { createId } from '../../lib/ids';
import { toCommands, useAcpSessions, type AcpSessionInfo, type TurnResult } from '../useAcpSessions';
import type { ChatMessage, Session } from '../../types';
import type { EngineDeps } from './usePtyEngine';
import { parseAuthRequired, type AuthMethod } from '../../lib/acp-auth';

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

interface LaunchOptions {
  first?: FirstMessage;
  /** What the user picked in the composer before the agent ran. */
  choices: AcpChoices;
  /** False for a fork: it keeps the mode the user chose in the source session. */
  applySafeMode: boolean;
  /** "start" or "resume", for the error message. */
  action: string;
}

export interface AcpEngineDeps extends EngineDeps {
  /** The agent needs the user's answer, or ended its turn: worth a notification when the user is away. */
  onAttention?: (sessionId: string, reason: AttentionReason) => void;
  /** The agent refused to start, or to answer, until the user signs in: the ways it offers and the unsent message. */
  onAuthRequired: (session: Pick<Session, 'id' | 'profileId' | 'cwd'>, methods: AuthMethod[], unsent?: FirstMessage) => void;
  /** Called with what an agent offers when one of its sessions opens or its commands change. */
  rememberOptions: (profileId: string, options: Partial<AgentOptions>) => void;
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
}: AcpEngineDeps) {
  const [starting, setStarting] = useState<ReadonlySet<string>>(new Set());
  // Sessions the app stopped (deleted, or stopped while starting): their late
  // events must not write a transcript back, and a start still in flight must
  // end the agent as soon as it is up.
  const stoppedRef = useRef(new Set<string>());
  // Each session's latest prompt: an agent that refuses it for a sign-in hands it back to the composer.
  const lastPromptRef = useRef(new Map<string, { message: ChatMessage; context?: string }>());
  // Hidden context a refused prompt carried (a rewound session's conversation): it goes out with the next message.
  const unsentContextRef = useRef(new Map<string, string>());
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
      updateMessages(sessionId, (prev) => applyAcpUpdate(prev, update, ctx(sessionId)));
    }),
    onPermission: unlessStopped((sessionId, request: PermissionRequestPayload) => {
      updateMessages(sessionId, (prev) => applyPermissionRequest(prev, request, ctx(sessionId)));
      onAttention?.(sessionId, 'needs-answer');
    }),
    onTurnEnd: unlessStopped((sessionId, { stopReason, error }: TurnResult) => {
      updateMessages(sessionId, closeTurn);
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
      updateMessages(sessionId, closeTurn);
      patchSession(sessionId, { status: 'terminated', endedAt: Date.now(), exitCode: code });
    }),
    onError: reportError,
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
    if (message) updateMessages(sessionId, (prev) => withoutMessage(prev, message.id));
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
      updateMessages(sessionId, (prev) => withoutMessage(prev, message.id));
      reportError(`Failed to send the message: ${String(error)}`);
      return false;
    }
  };

  /** Resolves to whether the agent took the message. */
  const send = async (sessionId: string, text: string, attachments: readonly string[] = []): Promise<boolean> => {
    // Shown before the prompt goes out, so the agent's reply always lands after it.
    const message = userMessage(text, attachments);
    updateMessages(sessionId, (prev) => [...prev, message]);
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

  /** Opens an already recorded session in its agent, then applies the picks and the first prompt. */
  const launch = async (session: Session, open: () => Promise<AcpSessionInfo>, options: LaunchOptions) => {
    // A session ended earlier and now resumed must hear from its agent again.
    stoppedRef.current.delete(session.id);
    const message = options.first ? userMessage(options.first.text, options.first.attachments) : null;
    if (message) updateMessages(session.id, (prev) => [...prev, message]);
    // Busy until the first prompt is out: a message sent meanwhile would race it.
    markStarting(session.id, true);
    try {
      let info: AcpSessionInfo;
      try {
        info = await open();
      } catch (error) {
        if (isStopped(session.id)) return;
        if (message) updateMessages(session.id, (prev) => withoutMessage(prev, message.id));
        patchSession(session.id, { status: 'terminated', endedAt: Date.now() });
        const authMethods = parseAuthRequired(error);
        if (authMethods) {
          onAuthRequired(session, authMethods, options.first);
          return;
        }
        const name = agents.find((a) => a.id === session.profileId)?.name ?? session.profileId;
        reportError(`Failed to ${options.action} ${name}: ${String(error)}`);
        return;
      }
      if (isStopped(session.id)) {
        // Stopped while starting: the backend could not end an agent it did not know yet.
        acp.stop(session.id).catch(reportFailure('Failed to stop the agent'));
        return;
      }
      rememberOptions(session.profileId, { modes: info.modes, configOptions: info.configOptions });
      if (info.acpSessionId) patchSession(session.id, { acpSessionId: info.acpSessionId });
      const settled = await applyChanges(session.id, info, options);
      // What the agent offers now, after the picks: an effort list follows its model,
      // and the next draft should offer what this session ended up with.
      if (settled.configOptions !== info.configOptions) {
        rememberOptions(session.profileId, { configOptions: settled.configOptions });
      }
      if (message && !isStopped(session.id)) {
        // A launch's own context (a rewind's) is newer than one a refused prompt left behind.
        const leftOver = takeUnsentContext(session.id);
        await prompt(session.id, message, options.first?.context ?? leftOver);
      }
    } finally {
      markStarting(session.id, false);
    }
  };

  const start = (session: Session, first?: FirstMessage, choices: AcpChoices = NO_CHOICES) =>
    launch(session, () => acp.start(session.id, session.cwd, session.profileId), {
      first,
      choices,
      applySafeMode: true,
      action: 'start',
    });

  /** Continues an ended session in a fresh agent process through the agent's own session/load. */
  const resume = (session: Session, acpSessionId: string, first?: FirstMessage, choices: AcpChoices = NO_CHOICES) =>
    launch(session, () => acp.load(session.id, session.cwd, session.profileId, acpSessionId), {
      first,
      choices,
      applySafeMode: true,
      action: 'resume',
    });

  /**
   * After a sign-in: sends a refused message in a fresh agent, which picks up
   * the new credentials. The session is reopened through the agent's own
   * session/load when it has one to reopen, else started anew.
   */
  const retryAfterSignIn = async (sessionId: string, message: FirstMessage) => {
    const session = sessions.find((s) => s.id === sessionId);
    if (!session) return;
    const canLoad = acp.info[sessionId]?.canLoad === true;
    // Taken before stop, which forgets it.
    const context = takeUnsentContext(sessionId);
    const wasTerminated = session.status === 'terminated';
    if (!wasTerminated && !(await stop(sessionId))) return;
    const first = { ...message, context: message.context ?? context };
    if (session.acpSessionId && (wasTerminated || canLoad)) await resume(session, session.acpSessionId, first);
    else await start(session, first);
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
    updateMessages(sessionId, (prev) => resolvePermissionCard(prev, cardId, optionId));
    acp.respondPermission(sessionId, card.requestId, optionId).catch((error) => {
      // The agent is still waiting, so the card must stay answerable.
      updateMessages(sessionId, (prev) => reopenPermissionCard(prev, cardId));
      reportError(`Could not answer the agent: ${String(error)}`);
    });
  };

  /**
   * Ends the agent process (deleted session, or a start the user stopped);
   * later events from it are ignored. Resolves with whether it stopped, after
   * the backend has done it.
   */
  const stop = (sessionId: string): Promise<boolean> => {
    stoppedRef.current.add(sessionId);
    lastPromptRef.current.delete(sessionId);
    unsentContextRef.current.delete(sessionId);
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
    acp.cancel(sessionId).catch(reportFailure('Failed to stop the agent'));
  };

  const setMode = (sessionId: string, modeId: string) => {
    acp.setMode(sessionId, modeId).catch(reportFailure('Could not change the mode'));
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
    retryAfterSignIn,
    fork,
    send,
    chooseOption,
    interrupt,
    setMode,
    setConfigOption,
    stop,
    isBusy,
    busySinceOf: acp.busySinceOf,
    canFork: acp.canFork,
  };
}

export type AcpEngine = ReturnType<typeof useAcpEngine>;
