import { useCallback, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { AuthStatus } from '../components/AuthPanel';
import type { AuthMethod } from '../lib/acp-auth';

/** An agent waiting for the user to sign in, and how far that got. */
export interface AuthRequest {
  profileId: string;
  cwd: string;
  methods: AuthMethod[];
  status: AuthStatus;
  error?: string;
}

export interface AgentAuth {
  authRequest: AuthRequest | null;
  /** Asks the user to sign in to an agent that refused to start without it. */
  requestSignIn: (profileId: string, cwd: string, methods: AuthMethod[]) => void;
  /** Signs in in the agent itself (e.g. it opens a browser); the user then sends again. */
  signIn: (methodId: string) => void;
  dismiss: () => void;
}

export function useAgentAuth(): AgentAuth {
  const [authRequest, setAuthRequest] = useState<AuthRequest | null>(null);

  const requestSignIn = useCallback(
    (profileId: string, cwd: string, methods: AuthMethod[]) =>
      setAuthRequest({ profileId, cwd, methods, status: 'idle' }),
    [],
  );

  const signIn = (methodId: string) => {
    if (!authRequest) return;
    const { profileId, cwd } = authRequest;
    setAuthRequest({ ...authRequest, status: 'signing-in', error: undefined });
    invoke('acp_authenticate', { profileId, cwd, methodId })
      .then(() => setAuthRequest((prev) => prev && { ...prev, status: 'signed-in' }))
      .catch((error) => setAuthRequest((prev) => prev && { ...prev, status: 'failed', error: String(error) }));
  };

  const dismiss = useCallback(() => setAuthRequest(null), []);

  return { authRequest, requestSignIn, signIn, dismiss };
}
