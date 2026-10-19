import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { parseAuthRequired, type AuthMethod } from '../lib/acp-auth';
import { createId } from '../lib/ids';
import { createPtyOutputStore, type PtyOutputStore } from '../lib/pty-output-store';

export type LoginOutcome =
  | { ok: true }
  | { ok: false; reason: string; cancelled?: boolean; methods?: AuthMethod[] };

export type SignInPhase = 'starting' | 'running' | 'checking' | 'failed';

export interface TerminalSignInState {
  terminalId: string;
  agentName: string;
  methodName: string;
  phase: SignInPhase;
  error?: string;
}

export interface TerminalSignInRequest {
  profileId: string;
  cwd: string;
  agentName: string;
  method: AuthMethod;
}

type SignInTerminalEvent =
  | { terminalId: string; kind: 'output'; data: string }
  | { terminalId: string; kind: 'exit'; exitCode: number | null };

const CANCELLED: LoginOutcome = { ok: false, reason: 'Sign-in cancelled', cancelled: true };

interface Run {
  terminalId: string;
  isCancelled: boolean;
  isStarted: boolean;
  settle: (outcome: LoginOutcome) => void;
}

/**
 * Runs an agent's terminal sign-in and exposes its dialog state. The login
 * lives in a backend PTY; its screen goes to a store the dialog's terminal
 * replays, and nothing of it is kept once the dialog closes.
 */
export function useTerminalSignIn() {
  const [dialog, setDialog] = useState<TerminalSignInState | null>(null);
  const [output] = useState<PtyOutputStore>(() => createPtyOutputStore());
  const runRef = useRef<Run | null>(null);

  const patch = useCallback((terminalId: string, change: Partial<TerminalSignInState>) => {
    setDialog((current) => (current?.terminalId === terminalId ? { ...current, ...change } : current));
  }, []);

  const finish = useCallback(
    (run: Run, outcome: LoginOutcome) => {
      run.settle(outcome);
      if (!outcome.ok && !outcome.cancelled) patch(run.terminalId, { phase: 'failed', error: outcome.reason });
    },
    [patch],
  );

  useEffect(() => {
    const unlisten = listen<SignInTerminalEvent>('sign-in-terminal', ({ payload }) => {
      const run = runRef.current;
      if (!run || payload.terminalId !== run.terminalId) return;
      if (payload.kind === 'output') {
        output.append(payload.terminalId, payload.data);
        return;
      }
      if (run.isCancelled) finish(run, CANCELLED);
      else if (payload.exitCode === 0) finish(run, { ok: true });
      else finish(run, { ok: false, reason: `The sign-in ended with code ${payload.exitCode}` });
    });
    return () => {
      void unlisten.then((stop) => stop());
    };
  }, [output, finish]);

  const run = useCallback(
    ({ profileId, cwd, agentName, method }: TerminalSignInRequest) => {
      const terminalId = createId('signin');
      output.forget(terminalId);
      return new Promise<LoginOutcome>((resolve) => {
        let isSettled = false;
        const current: Run = {
          terminalId,
          isCancelled: false,
          isStarted: false,
          settle: (outcome) => {
            if (isSettled) return;
            isSettled = true;
            resolve(outcome);
          },
        };
        runRef.current = current;
        setDialog({ terminalId, agentName, methodName: method.name, phase: 'starting' });

        invoke('acp_start_terminal_sign_in', { profileId, cwd, methodId: method.id, terminalId }).then(
          () => {
            current.isStarted = true;
            if (current.isCancelled) {
              void invoke('terminate_session', { sessionId: terminalId }).catch(() => {});
              current.settle(CANCELLED);
              return;
            }
            patch(terminalId, { phase: 'running' });
          },
          (error: unknown) => {
            if (current.isCancelled) return current.settle(CANCELLED);
            const methods = parseAuthRequired(error);
            const reason = methods ? `${agentName} no longer offers this sign-in` : String(error);
            finish(current, methods ? { ok: false, reason, methods } : { ok: false, reason });
          },
        );
      });
    },
    [output, patch, finish],
  );

  const showChecking = useCallback(() => {
    if (runRef.current) patch(runRef.current.terminalId, { phase: 'checking', error: undefined });
  }, [patch]);

  const fail = useCallback(
    (reason: string) => {
      if (runRef.current) patch(runRef.current.terminalId, { phase: 'failed', error: reason });
    },
    [patch],
  );

  const close = useCallback(() => {
    const current = runRef.current;
    runRef.current = null;
    setDialog(null);
    if (!current) return;
    current.isCancelled = true;
    // While starting there is no login to end yet: the start handler does it.
    if (current.isStarted) {
      void invoke('terminate_session', { sessionId: current.terminalId }).catch(() => {});
      current.settle(CANCELLED);
    }
    output.forget(current.terminalId);
  }, [output]);

  const sendInput = useCallback((data: string) => {
    const current = runRef.current;
    if (current) void invoke('send_input', { sessionId: current.terminalId, data }).catch(() => {});
  }, []);

  const resize = useCallback((cols: number, rows: number) => {
    const current = runRef.current;
    if (current) void invoke('resize_session', { sessionId: current.terminalId, cols, rows }).catch(() => {});
  }, []);

  return { dialog, output, run, showChecking, fail, close, sendInput, resize };
}
