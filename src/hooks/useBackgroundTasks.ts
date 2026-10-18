import { useCallback, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useBackgroundProcesses } from './useBackgroundProcesses';
import { backgroundTasksOf, type BackgroundTask } from '../lib/background-tasks';
import type { Session } from '../types';

export interface BackgroundTasksArgs {
  sessions: readonly Session[];
  isAcp: (session: Session) => boolean;
  isBusy: (sessionId: string) => boolean;
  busySince: (sessionId: string) => number | undefined;
  needsApproval: (sessionId: string) => boolean;
  onOpenSession: (sessionId: string) => void;
  onError: (message: string) => void;
}

function stopCall(task: BackgroundTask): Promise<unknown> {
  switch (task.kind) {
    case 'agent':
      return invoke('acp_cancel', { sessionId: task.sessionId });
    case 'terminal':
      return invoke('terminate_session', { sessionId: task.sessionId });
    case 'process':
      return invoke('stop_background_process', { pid: task.pid });
  }
}

/** What is running in the background, for the TopBar menu, with Open and Stop. */
export function useBackgroundTasks(args: BackgroundTasksArgs) {
  const { sessions, isAcp, isBusy, busySince, needsApproval, onOpenSession, onError } = args;
  const [isMenuOpen, setMenuOpen] = useState(false);
  const hasLiveSessions = sessions.some((s) => s.status === 'running');
  const { processes, reload } = useBackgroundProcesses(hasLiveSessions, isMenuOpen, onError);

  const tasks = useMemo(
    () => backgroundTasksOf({ sessions, isAcp, isBusy, busySince, needsApproval, processes, now: Date.now() }),
    [sessions, isAcp, isBusy, busySince, needsApproval, processes],
  );

  const open = useCallback((task: BackgroundTask) => onOpenSession(task.sessionId), [onOpenSession]);

  const stop = useCallback(
    async (task: BackgroundTask) => {
      try {
        await stopCall(task);
      } catch (error) {
        onError(`Could not stop ${task.name}: ${String(error)}`);
      }
      reload();
    },
    [onError, reload],
  );

  return { tasks, isMenuOpen, setMenuOpen, open, stop };
}
