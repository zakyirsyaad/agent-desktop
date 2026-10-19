import { useCallback, type RefObject } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useAgentAuth, type AgentAuth, type AuthRequest } from './useAgentAuth';
import { useLatest } from './useLatest';
import { useTerminalSignIn } from './useTerminalSignIn';
import type { FirstMessage } from './session-engine/useAcpEngine';
import type { ComposerHandle } from '../components/ComposerDock';
import type { AuthMethod } from '../lib/acp-auth';
import { checkSignIn } from '../lib/sign-in-check';
import type { AgentProfile, Session } from '../types';

export interface AgentSignInDeps {
  agents: AgentProfile[];
  composerRef: RefObject<ComposerHandle | null>;
  activeSessionIdRef: { readonly current: string | undefined };
  retryAfterSignIn: (sessionId: string, message: FirstMessage) => void;
}

/**
 * Signs in to an agent that refused to work without it: in the agent itself
 * or through its terminal login, then asks the agent whether it took, and
 * sends the refused message again when it still waits untouched in its own
 * session's composer.
 */
export function useAgentSignIn(deps: AgentSignInDeps) {
  const { authRequest, setAuthRequest, requestSignIn, dismiss } = useAgentAuth();
  const terminal = useTerminalSignIn();
  // Read when a sign-in ends, renders after it began.
  const depsRef = useLatest(deps);

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

  /** Runs the method; true once it ended well and the agent can be asked. */
  const runMethod = async ({ profileId, cwd }: AuthRequest, method: AuthMethod, agentName: string) => {
    if (method.kind === 'agent') {
      try {
        await invoke('acp_authenticate', { profileId, cwd, methodId: method.id });
        return true;
      } catch (error) {
        fail(String(error));
        return false;
      }
    }
    // A failed login's dialog gives way to the new one.
    terminal.close();
    const outcome = await terminal.run({ profileId, cwd, agentName, method });
    if (outcome.ok) {
      terminal.showChecking();
      return true;
    }
    if (outcome.cancelled) setAuthRequest((prev) => prev && { ...prev, status: 'idle' });
    else fail(outcome.reason, outcome.methods);
    return false;
  };

  /** Sends the refused message again, but only into its own session and only as the user left it. */
  const sendRefused = (pending: AuthRequest['pending']) => {
    const { composerRef, activeSessionIdRef, retryAfterSignIn } = depsRef.current;
    const composer = composerRef.current;
    if (!pending || activeSessionIdRef.current !== pending.sessionId || !composer?.holdsRestored()) return false;
    composer.clear();
    dismiss();
    retryAfterSignIn(pending.sessionId, { text: pending.text, attachments: pending.attachments });
    return true;
  };

  const signInWith = async (methodId: string) => {
    const request = authRequest;
    const method = request?.methods.find((m) => m.id === methodId);
    if (!request || !method || method.kind === 'explain') return;
    setAuthRequest({ ...request, status: 'signing-in', error: undefined });
    const agentName = depsRef.current.agents.find((a) => a.id === request.profileId)?.name ?? request.profileId;
    if (!(await runMethod(request, method, agentName))) return;

    if ((await checkSignIn(request.profileId, request.cwd)) === 'signed-out') {
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

  return { auth, handBack, terminal };
}
