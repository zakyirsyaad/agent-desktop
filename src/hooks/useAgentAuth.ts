import { useCallback, useState } from 'react';
import type { AuthStatus } from '../components/AuthPanel';
import type { AuthMethod } from '../lib/acp-auth';
import type { FirstMessage } from './session-engine/useAcpEngine';

/** An agent waiting for the user to sign in, and how far that got. */
export interface AuthRequest {
  profileId: string;
  cwd: string;
  methods: AuthMethod[];
  status: AuthStatus;
  error?: string;
  /** The refused message, put back into its session's composer: sent again after the sign-in. */
  pending?: FirstMessage & { sessionId: string };
}

export interface AgentAuth {
  authRequest: AuthRequest | null;
  /** Asks the user to sign in to an agent that refused to start without it. */
  requestSignIn: (
    profileId: string,
    cwd: string,
    methods: AuthMethod[],
    pending?: FirstMessage & { sessionId: string },
  ) => void;
  /** Signs in with one of the agent's methods, checks it took, and sends the refused message again. */
  signIn: (methodId: string) => void;
  dismiss: () => void;
}

/** The sign-in panel's state; `useAgentSignIn` does the signing in. */
export function useAgentAuth() {
  const [authRequest, setAuthRequest] = useState<AuthRequest | null>(null);

  const requestSignIn = useCallback<AgentAuth['requestSignIn']>(
    (profileId, cwd, methods, pending) =>
      setAuthRequest({ profileId, cwd, methods, status: 'idle', ...(pending ? { pending } : {}) }),
    [],
  );

  const dismiss = useCallback(() => setAuthRequest(null), []);

  /** Moves the panel on; the error goes with `failed` only, and new methods replace the old. */
  const setStatus = useCallback((status: AuthStatus, error?: string, methods?: AuthMethod[]) => {
    setAuthRequest(
      (prev) =>
        prev && {
          ...prev,
          status,
          error: status === 'failed' ? error : undefined,
          ...(methods ? { methods } : {}),
        },
    );
  }, []);

  /** Back to idle, but only from a sign-in under way: a failure stays on show. */
  const stopSigningIn = useCallback(() => {
    setAuthRequest((prev) => (prev?.status === 'signing-in' ? { ...prev, status: 'idle', error: undefined } : prev));
  }, []);

  return { authRequest, requestSignIn, dismiss, setStatus, stopSigningIn };
}
