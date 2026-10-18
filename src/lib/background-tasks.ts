import type { Session } from '../types';

export type BackgroundTaskKind = 'agent' | 'terminal' | 'process';

/** A shell process an agent started, as the backend reports it. */
export interface BackgroundProcess {
  pid: number;
  sessionId: string;
  command: string;
  elapsedSecs: number;
  ports: number[];
}

export interface BackgroundTask {
  id: string;
  kind: BackgroundTaskKind;
  name: string;
  detail?: string;
  status: 'Working' | 'Needs approval' | 'Running';
  startedAt: number;
  sessionId: string;
  pid?: number;
}

export interface BackgroundTasksInput {
  sessions: readonly Session[];
  isAcp: (session: Session) => boolean;
  isBusy: (sessionId: string) => boolean;
  busySince: (sessionId: string) => number | undefined;
  needsApproval: (sessionId: string) => boolean;
  processes: readonly BackgroundProcess[];
  /** When `processes` was read; process start times are anchored to it. */
  processesReadAt: number;
}

/** Everything running in the background, oldest first. */
export function backgroundTasksOf(input: BackgroundTasksInput): BackgroundTask[] {
  const { sessions, isAcp, isBusy, busySince, needsApproval, processes, processesReadAt } = input;
  const names = new Map(sessions.map((s) => [s.id, s.name]));

  const sessionTasks = sessions.flatMap((session): BackgroundTask[] => {
    if (isAcp(session)) {
      if (!isBusy(session.id)) return [];
      return [
        {
          id: `agent:${session.id}`,
          kind: 'agent',
          name: session.name,
          status: needsApproval(session.id) ? 'Needs approval' : 'Working',
          startedAt: busySince(session.id) ?? session.createdAt,
          sessionId: session.id,
        },
      ];
    }
    if (session.status !== 'running') return [];
    return [
      {
        id: `terminal:${session.id}`,
        kind: 'terminal',
        name: session.name,
        status: 'Running',
        startedAt: session.createdAt,
        sessionId: session.id,
      },
    ];
  });

  const processTasks = processes.map((process): BackgroundTask => {
    const sessionName = names.get(process.sessionId);
    const ports = process.ports.map((port) => `localhost:${port}`);
    const detail = [sessionName, ...ports].filter((part): part is string => Boolean(part)).join(' · ');
    return {
      id: `process:${process.pid}`,
      kind: 'process',
      name: process.command,
      ...(detail ? { detail } : {}),
      status: 'Running',
      startedAt: processesReadAt - process.elapsedSecs * 1000,
      sessionId: process.sessionId,
      pid: process.pid,
    };
  });

  return [...sessionTasks, ...processTasks].sort((a, b) => a.startedAt - b.startedAt);
}

/** "45s", "2m 13s" or "1h 04m". */
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  return `${seconds}s`;
}
