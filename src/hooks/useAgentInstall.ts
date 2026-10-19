import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { InstallPhase } from '../lib/install-plan';
import type { InstallStep } from '../types';

/** The rejection `install_agent` gives when the user cancelled: not a failure. */
const INSTALL_CANCELLED = 'INSTALL_CANCELLED';

/** The `agent-install-progress` event's payload. */
export interface InstallProgress {
  agentId: string;
  stepIndex: number;
  stepCount: number;
  kind: InstallStep['kind'];
  name: string;
  phase: InstallPhase;
  receivedBytes: number;
  totalBytes: number | null;
}

export type InstallStatus = 'idle' | 'installing' | 'failed';

export interface AgentInstall {
  status: InstallStatus;
  progress: InstallProgress | null;
  error: string | null;
  install: () => void;
  cancel: () => void;
}

interface InstallState {
  /** The agent this state is about; another agent's state reads as idle. */
  agentId: string | undefined;
  status: InstallStatus;
  progress: InstallProgress | null;
  error: string | null;
}

function idleFor(agentId: string | undefined): InstallState {
  return { agentId, status: 'idle', progress: null, error: null };
}

/**
 * Installs one agent and follows its progress. On success the backend emits
 * `agent-profiles-changed`, which reloads the profiles; this hook does not.
 * Results of an install started for another agent, or before an unmount, are ignored.
 */
export function useAgentInstall(agentId: string | undefined): AgentInstall {
  const [state, setState] = useState<InstallState>(() => idleFor(agentId));
  /** Bumped by each install and each agent change, so only the latest install's answer lands. */
  const attemptRef = useRef(0);

  useEffect(() => {
    if (!agentId) return;
    const unlisten = listen<InstallProgress>('agent-install-progress', (event) => {
      if (event.payload.agentId !== agentId) return;
      setState((prev) =>
        prev.agentId === agentId && prev.status === 'installing' ? { ...prev, progress: event.payload } : prev,
      );
    });
    return () => {
      attemptRef.current += 1;
      void unlisten.then((stop) => stop());
    };
  }, [agentId]);

  const install = useCallback(() => {
    if (!agentId) return;
    attemptRef.current += 1;
    const attempt = attemptRef.current;
    setState({ agentId, status: 'installing', progress: null, error: null });
    invoke('install_agent', { agentId }).then(
      () => {
        if (attemptRef.current === attempt) setState(idleFor(agentId));
      },
      (error: unknown) => {
        if (attemptRef.current !== attempt) return;
        const message = String(error);
        setState(
          message === INSTALL_CANCELLED
            ? idleFor(agentId)
            : { agentId, status: 'failed', progress: null, error: message },
        );
      },
    );
  }, [agentId]);

  const cancel = useCallback(() => {
    if (!agentId) return;
    invoke<boolean>('cancel_agent_install', { agentId }).catch((error: unknown) => {
      const message = `Could not cancel the install: ${String(error)}`;
      setState((prev) => (prev.agentId === agentId ? { ...prev, error: message } : prev));
    });
  }, [agentId]);

  const current = state.agentId === agentId ? state : idleFor(agentId);
  return { status: current.status, progress: current.progress, error: current.error, install, cancel };
}
