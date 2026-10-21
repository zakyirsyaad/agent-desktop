import { Button } from '../ui/Button';
import { formatRelativeTime } from '../../lib/relative-time';
import type { SessionListState } from '../../hooks/useAgentSessionList';
import type { ListedSession } from '../../lib/session-list';

export interface AgentSessionListProps {
  /** The agent the draft would start, named in every line. */
  agentName: string;
  state: SessionListState;
  /** Why the last import failed; kept apart from the list's own state. */
  importError: string | null;
  onLoad: () => void;
  onImport: (listed: ListedSession) => void;
}

/** A session's `updatedAt` as how long ago it was; nothing when it has no readable date. */
function relativeTime(updatedAt: string | undefined): string | null {
  if (!updatedAt) return null;
  const time = Date.parse(updatedAt);
  return Number.isNaN(time) ? null : formatRelativeTime(time);
}

/**
 * The new-session draft's list of the agent's other sessions in the folder:
 * the button that asks for them, the states while it does, and one row per
 * session that opens it.
 */
export function AgentSessionList({ agentName, state, importError, onLoad, onImport }: AgentSessionListProps) {
  return (
    <div className="space-y-2">
      {state.kind === 'idle' && <Button onClick={onLoad}>Continue a session from {agentName}</Button>}

      {state.kind === 'loading' && (
        <p role="status" className="text-sm text-fg-muted">
          Asking {agentName} for its sessions…
        </p>
      )}

      {state.kind === 'loaded' && (
        <>
          {state.sessions.length === 0 ? (
            <p className="text-sm text-fg-muted">{agentName} has no other sessions in this folder.</p>
          ) : (
            <ul className="space-y-1">
              {state.sessions.map((listed) => {
                const time = relativeTime(listed.updatedAt);
                return (
                  <li key={listed.acpSessionId}>
                    <Button variant="outline" className="w-full text-left" onClick={() => onImport(listed)}>
                      <span className="flex w-full items-baseline justify-between gap-3">
                        <span className="truncate min-w-0">{listed.title ?? 'Untitled session'}</span>
                        {time && <span className="shrink-0 text-fg-subtle">{time}</span>}
                      </span>
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
          {state.truncated && <p className="text-xs text-fg-subtle">Showing the 200 most recent sessions.</p>}
          {state.incomplete && <p className="text-xs text-fg-subtle">Some sessions could not be listed.</p>}
        </>
      )}

      {state.kind === 'failed' && (
        <div className="space-y-2">
          <p role="alert" className="text-sm text-danger">
            {state.message}
          </p>
          <Button onClick={onLoad}>Try again</Button>
        </div>
      )}

      {importError && (
        <p role="alert" className="text-sm text-danger">
          {importError}
        </p>
      )}
    </div>
  );
}