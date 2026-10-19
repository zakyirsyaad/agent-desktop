import { useCallback, useRef, type RefObject } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useAgentAuth, type AgentAuth, type AuthRequest } from './useAgentAuth';
import { useLatest } from './useLatest';
import { useTerminalSignIn, type LoginOutcome } from './useTerminalSignIn';
import type { FirstMessage } from './session-engine/useAcpEngine';
import type { ComposerHandle } from '../components/ComposerDock';
import type { AuthMethod } from '../lib/acp-auth';
import { checkSignIn } from '../lib/sign-in-check';
import type { AgentProfile, Session } from '../types';

export interface AgentSignInDeps {
  agents: AgentProfile[];
  composerRef: RefObject<ComposerHandle | null>;
  activeSessionIdRef: { readonly current: string | undefined };
  /** Resolves to false when the message did not go out, for a reason other than a sign-in. */
  retryAfterSignIn: (sessionId: string, message: FirstMessage) => Promise<boolean>;
  /** Puts a message back in the composer of the session it was written for. */
  onRestore: (sessionId: string, text: string, attachments?: readonly string[]) => void;
}

/**
 * Signs in to an agent that refused to work without it: in the agent itself
 * or through its terminal login, then asks the agent whether it took, and
 * sends the refused message again when it still waits untouched in its own
 * session's composer.
 */
export function useAgentSignIn(deps: AgentSignInDeps) {
  const { authRequest, setAuthRequest, requestSignIn: openPanel, dismiss: closePanel } = useAgentAuth();
  const terminal = useTerminalSignIn();
  const closeTerminal = terminal.close;
  // Read when a sign-in ends, renders after it began.
  const depsRef = useLatest(deps);
  // The sign-in under way: one that was cancelled, dismissed or replaced by another request no longer acts.
  const attemptRef = useRef<object | null>(null);

  const requestSignIn = useCallback<AgentAuth['requestSignIn']>(
    (profileId, cwd, methods, pending) => {
      attemptRef.current = null;
      // A login of the request this one replaces ends with it, and so does its dialog.
      closeTerminal();
      openPanel(profileId, cwd, methods, pending);
    },
    [closeTerminal, openPanel],
  );

  const dismiss = useCallback(() => {
    attemptRef.current = null;
    closePanel();
  }, [closePanel]);

  /** The dialog's Cancel or Close: stops the login, or stops waiting for it, and sends nothing. */
  const cancel = useCallback(() => {
    attemptRef.current = null;
    closeTerminal();
    setAuthRequest((prev) => (prev?.status === 'signing-in' ? { ...prev, status: 'idle' } : prev));
  }, [closeTerminal, setAuthRequest]);

  /** The agent refused: puts the message back in its session's composer (when active) and opens the panel. */
  const handBack = useCallback(
    (session: Pick<Session, 'id' | 'profileId' | 'cwd'>, methods: AuthMethod[], unsent?: FirstMessage) => {
      const { composerRef, activeSessionIdRef } = depsRef.current;
      const composer = composerRef.current;
      // The composer on screen may be another session's by now: the message goes back only into its own.
      const isRestored = unsent !== undefined && composer !== null && session.id === activeSessionIdRef.current;
      if (isRestored) composer.restore(unsent.text, unsent.attachments);
      const pending = isRestored
        ? { sessionId: session.id, text: unsent.text, attachments: unsent.attachments }
        : undefined;
      requestSignIn(session.profileId, session.cwd, methods, pending);
    },
    [depsRef, requestSignIn],
  );

  const fail = (error: string, methods?: AuthMethod[]) =>
    setAuthRequest((prev) => prev && { ...prev, status: 'failed', error, ...(methods ? { methods } : {}) });

  /** Runs the method in the agent, or its login in a terminal. */
  const runMethod = async ({ profileId, cwd }: AuthRequest, method: AuthMethod, agentName: string) => {
    if (method.kind === 'agent') {
      return invoke('acp_authenticate', { profileId, cwd, methodId: method.id }).then(
        (): LoginOutcome => ({ ok: true }),
        (error: unknown): LoginOutcome => ({ ok: false, reason: String(error) }),
      );
    }
    // A failed login's dialog gives way to the new one.
    terminal.close();
    return terminal.run({ profileId, cwd, agentName, method });
  };

  /**
   * Sends the refused message again, but only into its own session and only as
   * the user left it. A message that still does not go out comes back.
   */
  const sendRefused = (pending: AuthRequest['pending']) => {
    const { composerRef, activeSessionIdRef, retryAfterSignIn } = depsRef.current;
    const composer = composerRef.current;
    if (!pending || activeSessionIdRef.current !== pending.sessionId || !composer?.holdsRestored()) return false;
    const { sessionId, text, attachments } = pending;
    composer.clear();
    dismiss();
    void retryAfterSignIn(sessionId, { text, attachments }).then((isHandled) => {
      if (!isHandled) depsRef.current.onRestore(sessionId, text, attachments);
    });
    return true;
  };

  const signInWith = async (methodId: string) => {
    const request = authRequest;
    const method = request?.methods.find((m) => m.id === methodId);
    if (!request || !method || method.kind === 'explain') return;
    const attempt = {};
    attemptRef.current = attempt;
    const isCurrent = () => attemptRef.current === attempt;
    setAuthRequest({ ...request, status: 'signing-in', error: undefined });
    const agentName = depsRef.current.agents.find((a) => a.id === request.profileId)?.name ?? request.profileId;

    const outcome = await runMethod(request, method, agentName);
    if (!isCurrent()) return;
    if (!outcome.ok) {
      if (outcome.cancelled) setAuthRequest((prev) => prev && { ...prev, status: 'idle' });
      else fail(outcome.reason, outcome.methods);
      return;
    }

    if (method.kind === 'terminal') terminal.showChecking();
    const signedIn = (await checkSignIn(request.profileId, request.cwd)) === 'signed-in';
    if (!isCurrent()) return;
    attemptRef.current = null;
    if (!signedIn) {
      const reason = `${agentName} still says you are signed out`;
      if (method.kind === 'terminal') terminal.fail(reason);
      fail(reason);
      return;
    }
    terminal.close();
    if (!sendRefused(request.pending)) setAuthRequest((prev) => prev && { ...prev, status: 'signed-in' });
  };

  const auth: AgentAuth = {
    authRequest,
    requestSignIn,
    signIn: (methodId) => void signInWith(methodId),
    dismiss,
  };

  return { auth, handBack, cancel, terminal };
}
