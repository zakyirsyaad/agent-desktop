import type { Workspace } from "../../types";
import type { WorkspaceDetails } from "../../hooks/useWorkspaceDetails";
import { WorkspaceSummary } from "./WorkspaceSummary";

export interface NewSessionViewProps {
  workspace?: Workspace;
  details: WorkspaceDetails | null;
  agentName?: string;
}

/** A session that has not started: where it will run, and with which agent. */
export function NewSessionView({ workspace, details, agentName }: NewSessionViewProps) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center overflow-y-auto p-6">
      <div className="w-full max-w-md">
        <h1 className="text-xl font-medium text-fg">New session</h1>
        <p className="mt-1 text-sm text-fg-muted">
          {workspace
            ? `Send a message to start ${agentName ?? "the agent"} here. The folder and agent can still be changed below.`
            : "Open a project folder to start a session in it."}
        </p>
        {workspace && (
          <div className="mt-5 rounded-xl border border-border bg-surface-1 px-4 py-3">
            <WorkspaceSummary name={workspace.name} path={workspace.path} details={details} />
          </div>
        )}
      </div>
    </div>
  );
}
