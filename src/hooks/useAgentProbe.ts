import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useLatest } from './useLatest';
import { toCommands, toConfigOptions, toModes } from './useAcpSessions';
import { parseAuthRequired, type AuthMethod } from '../lib/acp-auth';
import type { ProbedOptions } from '../lib/acp-draft';
import { TRANSPORT_ACP, type AgentProfile } from '../types';

export interface AgentProbeDeps {
  /** The agent the next message starts; only an ACP agent is asked. */
  agent: AgentProfile | undefined;
  /** The folder it would start in; nothing is asked before one is chosen. */
  cwd: string | undefined;
  /** Whether the agent's options are remembered: then no session is opened, only the sign-in is read. */
  isKnown: (profileId: string) => boolean;
  onProbed: (profileId: string, options: ProbedOptions) => void;
  onAuthRequired: (profileId: string, cwd: string, methods: AuthMethod[]) => void;
}

/**
 * Asks an ACP agent, as soon as it is picked for a new session, what it
 * offers (modes, models, efforts, slash commands) and whether it needs a
 * sign-in, so the composer shows its choices before the first message and
 * the user signs in before writing one. An agent whose options are known
 * is only asked whether someone is signed in. Each agent is asked once per run;
 * one that needs a sign-in is asked again when picked again, or through
 * `reprobe` once the user signed in.
 */
export function useAgentProbe({ agent, cwd, isKnown, onProbed, onAuthRequired }: AgentProbeDeps) {
  // Agents being asked now; several can be, when the user switches while one starts.
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const probedRef = useRef(new Set<string>());
  const pendingRef = useRef(new Set<string>());
  // Bumped by `reprobe`, so the agent in view is asked again.
  const [round, setRound] = useState(0);
  const callbacksRef = useLatest({ isKnown, onProbed, onAuthRequired });
  const agentId = agent?.transport === TRANSPORT_ACP ? agent.id : undefined;
  // The agent picked now: a sign-in is asked for only while it still is.
  const currentRef = useLatest(agentId);

  useEffect(() => {
    if (!agentId || !cwd) return;
    if (probedRef.current.has(agentId) || pendingRef.current.has(agentId)) return;
    pendingRef.current.add(agentId);
    setPending(new Set(pendingRef.current));
    // Opening a session can run the agent's own hooks and leaves it in its history: only for an agent never seen.
    const openSession = !callbacksRef.current.isKnown(agentId);
    invoke('acp_probe_agent', { profileId: agentId, cwd, openSession })
      .then((raw) => {
        // No answer to read: keep what is remembered rather than wipe it.
        if (typeof raw !== 'object' || raw === null) return;
        const probed = raw as { modes?: unknown; configOptions?: unknown; commands?: unknown };
        probedRef.current.add(agentId);
        callbacksRef.current.onProbed(agentId, {
          modes: toModes(probed.modes),
          configOptions: toConfigOptions(probed.configOptions),
          commands: toCommands(probed.commands),
        });
      })
      .catch((error: unknown) => {
        const methods = parseAuthRequired(error);
        if (methods && currentRef.current === agentId) callbacksRef.current.onAuthRequired(agentId, cwd, methods);
        // Any other failure (a missing npx, a crash) is the first message's to report: it starts the agent anyway.
      })
      .finally(() => {
        pendingRef.current.delete(agentId);
        setPending(new Set(pendingRef.current));
      });
  }, [agentId, cwd, round, callbacksRef, currentRef]);

  const isProbing = useCallback((id: string | undefined) => id !== undefined && pending.has(id), [pending]);

  /** Asks the agent again, e.g. after the user signed in to it. */
  const reprobe = useCallback((id: string) => {
    probedRef.current.delete(id);
    setRound((n) => n + 1);
  }, []);

  return { isProbing, reprobe };
}
