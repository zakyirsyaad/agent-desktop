import { useCallback, useRef, useState } from 'react';
import {
  applyAcpUpdate,
  applyPermissionRequest,
  closeTurn,
  pendingPermissionCards,
  reopenPermissionCard,
  resolvePermissionCard,
  type PermissionRequestPayload,
} from '../../lib/acp-events';
import { safeModeToApply } from '../../lib/acp-modes';
import { findCard, userMessage, withoutMessage } from '../../lib/session-helpers';
import { createId } from '../../lib/ids';
import { useAcpSessions, type AcpSessionInfo, type TurnResult } from '../useAcpSessions';
import type { ChatMessage, Session } from '../../types';
import type { EngineDeps } from './usePtyEngine';

const NOT_ENDED_NORMALLY = new Set(['refusal', 'max_tokens', 'max_turn_requests']);

function turnEndNotice(stopReason: string | undefined, error: string | undefined): string | null {
  if (error) return `The agent's turn failed: ${error}`;
  if (stopReason && NOT_ENDED_NORMALLY.has(stopReason)) return `The agent stopped early (${stopReason}).`;
  return null;
}

interface LaunchOptions {
  firstPrompt?: string;
  /** False for a fork: it keeps the mode the user chose in the source session. */
  applySafeMode: boolean;
}

/**
 * Sessions whose agent speaks the Agent Client Protocol: structured updates
 * become chat messages, permission requests become cards with the agent's own
 * choices, and modes and config options are changed live.
 */
export function useAcpEngine({ agents, updateMessages, patchSession, reportError }: Omit<EngineDeps, 'sessions'>) {
  const [starting, setStarting] = useState<ReadonlySet<string>>(new Set());
  // Sessions the app stopped (deleted, or stopped while starting): their late
  // events must not write a transcript back, and a start still in flight must
  // end the agent as soon as it is up.
  const stoppedRef = useRef(new Set<string>());
  const ctx = (sessionId: string) => ({ sessionId, now: Date.now(), createId });
  const isStopped = (sessionId: string) => stoppedRef.current.has(sessionId);
  const unlessStopped =
    <A extends unknown[]>(handle: (sessionId: string, ...args: A) => void) =>
    (sessionId: string, ...args: A) => {
      if (!isStopped(sessionId)) handle(sessionId, ...args);
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

  const reportFailure = (what: string) => (error: unknown) => reportError(`${what}: ${String(error)}`);

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

  /** A failed switch leaves the agent in its starting mode, which the composer shows; the session stays usable. */
  const applySafeMode = async (sessionId: string, info: AcpSessionInfo) => {
    const change = safeModeToApply(info);
    if (!change) return;
    try {
      if (change.kind === 'mode') await acp.setMode(sessionId, change.modeId);
      else await acp.setConfigOption(sessionId, change.configId, change.value);
    } catch (error) {
      reportError(`Could not switch the agent to ask before acting: ${String(error)}`);
    }
  };

  /** Starts (or forks into) an already recorded session, then applies the safe mode and the first prompt. */
  const launch = async (session: Session, open: () => Promise<AcpSessionInfo>, options: LaunchOptions) => {
    const message = options.firstPrompt ? userMessage(options.firstPrompt) : null;
    if (message) updateMessages(session.id, (prev) => [...prev, message]);
    markStarting(session.id, true);
    let info: AcpSessionInfo;
    try {
      info = await open();
    } catch (error) {
      if (isStopped(session.id)) return;
      patchSession(session.id, { status: 'terminated', endedAt: Date.now() });
      const name = agents.find((a) => a.id === session.profileId)?.name ?? session.profileId;
      reportError(`Failed to start ${name}: ${String(error)}`);
      return;
    } finally {
      markStarting(session.id, false);
    }
    if (isStopped(session.id)) {
      // Stopped while starting: the backend could not end an agent it did not know yet.
      acp.stop(session.id).catch(reportFailure('Failed to stop the agent'));
      return;
    }
    if (info.acpSessionId) patchSession(session.id, { acpSessionId: info.acpSessionId });
    if (options.applySafeMode) await applySafeMode(session.id, info);
    if (message && !isStopped(session.id)) await prompt(session.id, message);
  };

  const start = (session: Session, firstPrompt?: string) =>
    launch(session, () => acp.start(session.id, session.cwd, session.profileId), {
      firstPrompt,
      applySafeMode: true,
    });

  const fork = (sourceSessionId: string, session: Session) =>
    launch(session, () => acp.fork(sourceSessionId, session.id, session.cwd), { applySafeMode: false });

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

  /** Ends the agent process (deleted session, or a start the user stopped); later events from it are ignored. */
  const stop = (sessionId: string) => {
    stoppedRef.current.add(sessionId);
    acp.stop(sessionId).catch(reportFailure('Failed to stop the agent'));
  };

  /**
   * Stops the agent's current turn. ACP asks the client to answer the
   * permission requests it is still waiting on as cancelled; an agent blocked
   * on one would otherwise never end the turn. While the agent is still
   * starting, stopping ends the session instead.
   */
  const interrupt = (sessionId: string, messages: ChatMessage[] | undefined) => {
    if (starting.has(sessionId)) {
      stop(sessionId);
      patchSession(sessionId, { status: 'terminated', endedAt: Date.now() });
      return;
    }
    for (const card of pendingPermissionCards(messages ?? [])) {
      if (card.requestId === undefined) continue;
      acp.respondPermission(sessionId, card.requestId, null).catch(reportFailure('Could not answer the agent'));
    }
    acp.cancel(sessionId).catch(reportFailure('Failed to stop the agent'));
  };

  const setMode = (sessionId: string, modeId: string) => {
    acp.setMode(sessionId, modeId).catch(reportFailure('Could not change the mode'));
  };

  const setConfigOption = (sessionId: string, configId: string, value: string) => {
    acp.setConfigOption(sessionId, configId, value).catch(reportFailure('Could not change the setting'));
  };

  const isBusy = (sessionId: string) => starting.has(sessionId) || acp.isBusy(sessionId);

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
    canFork: acp.canFork,
  };
}

export type AcpEngine = ReturnType<typeof useAcpEngine>;
