import type { ReactNode } from "react";
import type { Workspace } from "../../types";
import type { WorkspaceDetails } from "../../hooks/useWorkspaceDetails";
import { WorkspaceSummary } from "./WorkspaceSummary";

export interface NewSessionViewProps {
  workspace?: Workspace;
  details: WorkspaceDetails | null;
  agentName?: string;
  /** Why no session can start in the folder (no agent is ready), shown instead of the hint to send a message. */
  unavailableReason?: string;
  /** The branch a worktree session will start from, while Worktree is on. */
  worktreeBaseBranch?: string;
  /** The agent's other sessions in the folder, below the workspace summary. */
  sessionList?: ReactNode;
}

/** A session that has not started: where it will run, and with which agent. */
export function NewSessionView({
  workspace,
  details,
  agentName,
  unavailableReason,
  worktreeBaseBranch,
  sessionList,
}: NewSessionViewProps) {
  const hint = !workspace
    ? "Open a project folder to start a session in it."
    : (unavailableReason ??
      `Send a message to start ${agentName ?? "the agent"} here. The folder and agent can still be changed below.`);
  // The card names the branch the session will really start from, not the one the folder is on.
  const shownDetails = details && worktreeBaseBranch ? { ...details, branch: worktreeBaseBranch } : details;
  return (
    <div className="flex flex-1 flex-col items-center justify-center overflow-y-auto p-6">
      <div className="w-full max-w-md">
        <h1 className="text-xl font-medium text-fg">New session</h1>
        <p className="mt-1 text-sm text-fg-muted">{hint}</p>
        {workspace && (
          <div className="mt-5 rounded-xl border border-border bg-surface-1 px-4 py-3">
            <WorkspaceSummary name={workspace.name} path={workspace.path} details={shownDetails} />
          </div>
        )}
        {sessionList && <div className="mt-5">{sessionList}</div>}
      </div>
    </div>
  );
}
