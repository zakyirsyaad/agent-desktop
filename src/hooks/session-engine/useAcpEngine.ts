import { useCallback, useRef, useState } from 'react';
import { applyAcpUpdate, applyPermissionRequest, closeTurn, resolvePermissionCard } from '../../lib/acp-events';
import { safeModeToApply } from '../../lib/acp-modes';
import { findCard, userMessage, withoutMessage } from '../../lib/session-helpers';
import { createId } from '../../lib/ids';
import { useAcpSessions, type AcpSessionInfo, type TurnResult } from '../useAcpSessions';
import type { PermissionRequestPayload } from '../../lib/acp-events';
import type { ChatMessage, Session } from '../../types';
import type { EngineDeps } from './usePtyEngine';

const NOT_ENDED_NORMALLY = new Set(['refusal', 'max_tokens', 'max_turn_requests']);

function turnEndNotice(stopReason: string | undefined, error: string | undefined): string | null {
  if (error) return `The agent's turn failed: ${error}`;
  if (stopReason && NOT_ENDED_NORMALLY.has(stopReason)) return `The agent stopped early (${stopReason}).`;
  return null;
}

/**
 * Sessions whose agent speaks the Agent Client Protocol: structured updates
 * become chat messages, permission requests become cards with the agent's own
 * choices, and modes and config options are changed live.
 */
export function useAcpEngine({ agents, updateMessages, patchSession, reportError }: Omit<EngineDeps, 'sessions'>) {
  const [starting, setStarting] = useState<ReadonlySet<string>>(new Set());
  // Sessions the app stopped (deleted): their late events must not write a transcript back.
  const stoppedRef = useRef(new Set<string>());
  const ctx = (sessionId: string) => ({ sessionId, now: Date.now(), createId });
  const unlessStopped =
    <A extends unknown[]>(handle: (sessionId: string, ...args: A) => void) =>
    (sessionId: string, ...args: A) => {
      if (!stoppedRef.current.has(sessionId)) handle(sessionId, ...args);
    };

  const acp = useAcpSessions({
    onUpdate: unlessStopped((sessionId, update: unknown) =>
      updateMessages(sessionId, (prev) => applyAcpUpdate(prev, update, ctx(sessionId))),
    ),
    onPermission: unlessStopped((sessionId, request: PermissionRequestPayload) =>
      updateMessages(sessionId, (prev) => applyPermissionRequest(prev, request, ctx(sessionId))),
    ),
    onTurnEnd: unlessStopped((sessionId, { stopReason, error }: TurnResult) => {
      updateMessages(sessionId, closeTurn);
      const notice = turnEndNotice(stopReason, error);
      if (notice) reportError(notice);
    }),
    onExit: unlessStopped((sessionId, code: number | null) => {
      updateMessages(sessionId, closeTurn);
      patchSession(sessionId, { status: 'terminated', endedAt: Date.now(), exitCode: code });
    }),
  });

  const markStarting = useCallback((sessionId: string, isStarting: boolean) => {
    setStarting((prev) => {
      const next = new Set(prev);
      if (isStarting) next.add(sessionId);
      else next.delete(sessionId);
      return next;
    });
  }, []);

  /** Prompts the agent with a message already shown in the chat; removes it if the prompt is refused. */
  const prompt = async (sessionId: string, message: ChatMessage) => {
    try {
      await acp.prompt(sessionId, message.content);
    } catch (error) {
      updateMessages(sessionId, (prev) => withoutMessage(prev, message.id));
      reportError(`Failed to send the message: ${String(error)}`);
    }
  };

  const send = async (sessionId: string, text: string) => {
    // Shown before the prompt goes out, so the agent's reply always lands after it.
    const message = userMessage(text);
    updateMessages(sessionId, (prev) => [...prev, message]);
    await prompt(sessionId, message);
  };

  /** Starts (or forks into) an already recorded session, then applies the safe mode and the first prompt. */
  const launch = async (session: Session, open: () => Promise<AcpSessionInfo>, firstPrompt?: string) => {
    const message = firstPrompt ? userMessage(firstPrompt) : null;
    if (message) updateMessages(session.id, (prev) => [...prev, message]);
    markStarting(session.id, true);
    try {
      const info = await open();
      patchSession(session.id, { acpSessionId: info.acpSessionId });
      const safeMode = safeModeToApply(info.modes);
      if (safeMode) await acp.setMode(session.id, safeMode);
    } catch (error) {
      patchSession(session.id, { status: 'terminated', endedAt: Date.now() });
      const name = agents.find((a) => a.id === session.profileId)?.name ?? session.profileId;
      reportError(`Failed to start ${name}: ${String(error)}`);
      return;
    } finally {
      markStarting(session.id, false);
    }
    if (message) await prompt(session.id, message);
  };

  const start = (session: Session, firstPrompt?: string) =>
    launch(session, () => acp.start(session.id, session.cwd, session.profileId), firstPrompt);

  const fork = (sourceSessionId: string, session: Session) =>
    launch(session, () => acp.fork(sourceSessionId, session.id, session.cwd));

  const chooseOption = (sessionId: string, messages: ChatMessage[] | undefined, cardId: string, optionId: string) => {
    const card = findCard(messages, cardId);
    if (card?.requestId === undefined) return;
    updateMessages(sessionId, (prev) => resolvePermissionCard(prev, cardId, optionId));
    acp.respondPermission(sessionId, card.requestId, optionId).catch((error) => {
      reportError(`Could not answer the agent: ${String(error)}`);
    });
  };

  const reportFailure = (what: string) => (error: unknown) => reportError(`${what}: ${String(error)}`);

  const interrupt = (sessionId: string) => {
    acp.cancel(sessionId).catch(reportFailure('Failed to stop the agent'));
  };

  const setMode = (sessionId: string, modeId: string) => {
    acp.setMode(sessionId, modeId).catch(reportFailure('Could not change the mode'));
  };

  const setConfigOption = (sessionId: string, configId: string, value: string) => {
    acp.setConfigOption(sessionId, configId, value).catch(reportFailure('Could not change the setting'));
  };

  /** Ends the agent process of a session that is being deleted; later events from it are ignored. */
  const stop = (sessionId: string) => {
    stoppedRef.current.add(sessionId);
    void acp.stop(sessionId);
  };

  const isBusy = (sessionId: string) => starting.has(sessionId) || acp.isBusy(sessionId);
  const isLive = (sessionId: string) => acp.info[sessionId] !== undefined;

  return {
    info: acp.info,
    start,
    fork,
    send,
    chooseOption,
    interrupt,
    setMode,
    setConfigOption,
    stop,
    isBusy,
    isLive,
    canFork: acp.canFork,
  };
}

export type AcpEngine = ReturnType<typeof useAcpEngine>;
