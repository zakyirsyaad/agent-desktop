import type { ChatMessage, Session, ToolExecution } from '../types';

/** What a background row stands for. */
export type BackgroundTaskKind = 'agent' | 'shell' | 'subagent';

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
  /** The OS process a shell task can be stopped through. */
  pid?: number;
  /** The tool call a running-tool task points at. */
  toolId?: string;
}

export interface BackgroundTasksInput {
  sessions: readonly Session[];
  isBusy: (sessionId: string) => boolean;
  busySince: (sessionId: string) => number | undefined;
  needsApproval: (sessionId: string) => boolean;
  transcripts: Readonly<Record<string, readonly ChatMessage[]>>;
  processes: readonly BackgroundProcess[];
  /** When `processes` was read; process start times are anchored to it. */
  processesReadAt: number;
}

/** Tool names an agent uses for a subagent run: Claude's Task/Agent, Qwen's agent. */
const SUBAGENT_TOOLS = new Set(['task', 'agent']);

/**
 * Whether a running tool is a subagent. Kind alone cannot say: Claude and Codex
 * report plain reasoning as `think` too, so the adapter's own tool name decides,
 * with a title that names the subagent as the fallback for older adapters.
 */
function isSubagent(tool: ToolExecution): boolean {
  const provider = tool.providerToolName?.toLowerCase();
  if (provider && SUBAGENT_TOOLS.has(provider)) return true;
  return /^(task|agent|subagent)\b/i.test(tool.name);
}

function toolKind(tool: ToolExecution): 'shell' | 'subagent' | undefined {
  if (isSubagent(tool)) return 'subagent';
  return tool.kind === 'execute' ? 'shell' : undefined;
}

/** Every running tool call that is work of its own: a shell command or a subagent. */
export function runningToolTasks(
  transcripts: Readonly<Record<string, readonly ChatMessage[]>>,
  sessions: readonly Session[],
): BackgroundTask[] {
  return sessions.flatMap((session) =>
    (transcripts[session.id] ?? []).flatMap((message) =>
      message.role !== 'agent'
        ? []
        : (message.tools ?? []).flatMap((tool): BackgroundTask[] => {
            const kind = toolKind(tool);
            if (tool.status !== 'running' || !kind) return [];
            return [
              {
                id: `tool:${session.id}:${tool.id}`,
                kind,
                name: tool.name,
                detail: session.name,
                status: 'Running',
                startedAt: tool.startedAt ?? message.timestamp,
                sessionId: session.id,
                toolId: tool.id,
              },
            ];
          }),
    ),
  );
}

function normalized(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** A tool's title and a process's command describe the same work when one contains the other. */
function namesSameWork(tool: BackgroundTask, process: BackgroundTask): boolean {
  const title = normalized(tool.name);
  const command = normalized(process.name);
  return title.includes(command) || command.includes(title);
}

/**
 * Drops the tool row for each process already listed, preferring the process:
 * it carries the ports and can be stopped. A process matches its tool by
 * command text, or by having started while that tool was the latest one running.
 */
function dedupeToolTasks(
  tools: readonly BackgroundTask[],
  processes: readonly BackgroundTask[],
): BackgroundTask[] {
  const newestFirst = [...tools].sort((a, b) => b.startedAt - a.startedAt);
  const claimed = new Set<string>();
  for (const process of processes) {
    const match = newestFirst.find(
      (tool) =>
        !claimed.has(tool.id) &&
        tool.sessionId === process.sessionId &&
        (namesSameWork(tool, process) || process.startedAt >= tool.startedAt),
    );
    if (match) claimed.add(match.id);
  }
  return tools.filter((tool) => !claimed.has(tool.id));
}

/** Everything running in the background, oldest first. */
export function backgroundTasksOf(input: BackgroundTasksInput): BackgroundTask[] {
  const { sessions, isBusy, busySince, needsApproval, transcripts, processes, processesReadAt } = input;
  const names = new Map(sessions.map((s) => [s.id, s.name]));

  const sessionTasks = sessions
    .filter((session) => isBusy(session.id))
    .map(
      (session): BackgroundTask => ({
        id: `agent:${session.id}`,
        kind: 'agent',
        name: session.name,
        status: needsApproval(session.id) ? 'Needs approval' : 'Working',
        startedAt: busySince(session.id) ?? session.createdAt,
        sessionId: session.id,
      }),
    );

  const processTasks = processes.map((process): BackgroundTask => {
    const sessionName = names.get(process.sessionId);
    const ports = process.ports.map((port) => `localhost:${port}`);
    const detail = [sessionName, ...ports].filter((part): part is string => Boolean(part)).join(' · ');
    return {
      id: `process:${process.pid}`,
      kind: 'shell',
      name: process.command,
      ...(detail ? { detail } : {}),
      status: 'Running',
      startedAt: processesReadAt - process.elapsedSecs * 1000,
      sessionId: process.sessionId,
      pid: process.pid,
    };
  });

  const toolTasks = dedupeToolTasks(runningToolTasks(transcripts, sessions), processTasks);

  return [...sessionTasks, ...processTasks, ...toolTasks].sort((a, b) => a.startedAt - b.startedAt);
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