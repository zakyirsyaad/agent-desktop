import { useEffect } from 'react';
import { useAgentProbe } from './useAgentProbe';
import type { AgentAuth } from './useAgentAuth';
import { hasReportedOptions, type AgentOptions, type ProbedOptions } from '../lib/acp-draft';
import type { AgentProfile } from '../types';

export interface DraftAgentCheckDeps {
  /** The agent the next message starts, or undefined while a session runs. */
  agent: AgentProfile | undefined;
  cwd: string | undefined;
  agentOptions: Readonly<Record<string, AgentOptions>> | undefined;
  /** Remembers what the probe learned about an agent's options. */
  rememberProbed: (profileId: string, probed: ProbedOptions) => void;
  auth: AgentAuth;
}

/**
 * Checks a new session's agent before the first message: what it offers, and
 * whether someone is signed in. Keeps the sign-in panel in step with it: the
 * panel opens when the agent needs a sign-in, closes once the agent shows
 * someone signed in (in the app or in a terminal), and the agent is asked
 * again after a sign-in and whenever the user comes back to the window.
 */
export function useDraftAgentCheck({ agent, cwd, agentOptions, rememberProbed, auth }: DraftAgentCheckDeps) {
  const { authRequest, requestSignIn, dismiss } = auth;
  const probe = useAgentProbe({
    agent,
    cwd,
    isKnown: (profileId) => hasReportedOptions(agentOptions?.[profileId]),
    onProbed: (profileId, probed, signInChecked) => {
      rememberProbed(profileId, probed);
      // Only an answer that shows someone signed in closes the panel; silence proves nothing.
      if (signInChecked && authRequest?.profileId === profileId && authRequest.status !== 'signing-in') dismiss();
    },
    onAuthRequired: (profileId, probeCwd, methods) => {
      // A sign-in already under way for this agent (a refused start) is not reset by the probe's own answer.
      if (authRequest?.profileId !== profileId) requestSignIn(profileId, probeCwd, methods);
    },
  });
  const { reprobe } = probe;

  // Signed in through the panel: the agent can now be asked what it offers.
  const signedInAgentId = authRequest?.status === 'signed-in' ? authRequest.profileId : undefined;
  useEffect(() => {
    if (signedInAgentId) reprobe(signedInAgentId);
  }, [signedInAgentId, reprobe]);

  // An agent whose sign-in runs in a terminal is signed in outside the app: ask it again when the user comes back.
  const awaitingAgentId =
    authRequest && authRequest.status !== 'signing-in' && authRequest.status !== 'signed-in'
      ? authRequest.profileId
      : undefined;
  useEffect(() => {
    if (!awaitingAgentId) return;
    const askAgain = () => reprobe(awaitingAgentId);
    window.addEventListener('focus', askAgain);
    return () => window.removeEventListener('focus', askAgain);
  }, [awaitingAgentId, reprobe]);

  return { isProbing: probe.isProbing };
}
