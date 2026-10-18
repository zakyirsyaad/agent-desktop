import { Folder, GitBranch } from "lucide-react";
import type { WorkspaceDetails } from "../../hooks/useWorkspaceDetails";

export interface WorkspaceSummaryProps {
  name: string;
  path: string;
  details: WorkspaceDetails | null;
}

/** The folder a session works in, where it lives, and its git branch. */
export function WorkspaceSummary({ name, path, details }: WorkspaceSummaryProps) {
  return (
    <div role="group" aria-label="Workspace" className="space-y-1.5 text-sm">
      <p className="flex items-center gap-2" title={path}>
        <Folder size={15} aria-hidden="true" className="shrink-0 text-fg-muted" />
        <span className="truncate text-fg-secondary">
          {name}
          {details && <span className="text-fg-subtle"> · {details.location}</span>}
        </span>
      </p>
      {details?.branch && (
        <p className="flex items-center gap-2" aria-label={`Branch ${details.branch}`}>
          <GitBranch size={15} aria-hidden="true" className="shrink-0 text-fg-muted" />
          <span className="truncate font-mono text-[13px] text-fg-secondary">{details.branch}</span>
        </p>
      )}
    </div>
  );
}
