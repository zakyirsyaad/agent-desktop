import type { CatalogAgent } from '../types';
import { Button } from './ui/Button';

export interface UpdateNoticeProps {
  agents: readonly CatalogAgent[];
  onShow: () => void;
  onDismiss: () => void;
}

function messageFor(agents: readonly CatalogAgent[]): string {
  if (agents.length === 1) return `${agents[0].name} ${agents[0].updateVersion} is available.`;
  return `${agents.length} agent updates are available.`;
}

/** Tells the user once per new version that agent updates are waiting in Settings. */
export function UpdateNotice({ agents, onShow, onDismiss }: UpdateNoticeProps) {
  if (agents.length === 0) return null;
  return (
    <div
      role="status"
      className="bg-surface-2 text-fg-secondary text-xs rounded-lg px-3 py-2 mx-6 mt-3 flex justify-between items-center"
    >
      <span className="break-words">{messageFor(agents)}</span>
      <span className="ml-3 flex shrink-0 gap-2">
        <Button variant="outline" onClick={onShow}>Show</Button>
        <Button variant="ghost" onClick={onDismiss}>Dismiss</Button>
      </span>
    </div>
  );
}
