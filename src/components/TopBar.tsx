import {
  ChevronLeft,
  ChevronRight,
  Folder,
  GitBranch,
  GitCompare,
  ExternalLink,
  MoreHorizontal,
} from "lucide-react";
import { IconButton } from "./ui/IconButton";
import { DiffStatChip } from "./changes/DiffStatChip";
import { BackgroundTasksMenu, type BackgroundTasksMenuProps } from "./topbar/BackgroundTasksMenu";
import { PlanMenu } from "./topbar/PlanMenu";
import { PullRequestChip } from "./topbar/PullRequestChip";
import type { PullRequestStatus } from "../hooks/usePullRequest";
import type { PlanEntry } from "../types";

/**
 * Left inset reserved for the native macOS traffic lights.
 *
 * The window uses `titleBarStyle: Overlay` with a hidden title, so the real
 * close/minimise/zoom buttons float over this header. Nothing may be rendered
 * under them, and the inset replaces the fake circles that used to stand in for
 * them. The value is wider than the buttons themselves so a click just past
 * them does not hit an interactive control.
 */
export const TOP_BAR_TRAFFIC_LIGHT_INSET_PX = 78;

export interface TopBarProps {
  sessionName?: string;
  workspaceName?: string;
  /** Shown as the workspace badge's tooltip. */
  workspacePath?: string;
  /** The workspace's git branch, shown next to it when it is a repository. */
  branch?: string;
  /** The branch's pull request, with a chip that opens it; none when absent. */
  pullRequest?: PullRequestStatus | null;
  onOpenPullRequest?: (url: string) => void;
  canGoBack?: boolean;
  canGoForward?: boolean;
  onBack?: () => void;
  onForward?: () => void;
  /** Opens this session in its own window; the button is hidden when absent. */
  onPopout?: () => void;
  /** Shows or hides the workspace's files; the button is hidden when absent. */
  onToggleFiles?: () => void;
  isFilesOpen?: boolean;
  /** Shows or hides the session's uncommitted changes; the button is hidden when absent. */
  onToggleChanges?: () => void;
  isChangesOpen?: boolean;
  /** Lines added and removed against HEAD, shown as a chip beside the button once known. */
  diffStats?: { added: number; removed: number };
  /** Opens the diff view; the chip opens it. */
  onOpenDiff?: () => void;
  onOpenSettings?: () => void;
  /** What is running in the background; the menu is hidden when absent. */
  backgroundTasks?: BackgroundTasksMenuProps;
  /** The session's current plan; the menu is hidden when it has none. */
  plan?: readonly PlanEntry[];
}

export function TopBar({
  sessionName,
  workspaceName,
  workspacePath,
  branch,
  pullRequest,
  onOpenPullRequest,
  canGoBack = false,
  canGoForward = false,
  onBack,
  onForward,
  onPopout,
  onToggleFiles,
  isFilesOpen = false,
  onToggleChanges,
  isChangesOpen = false,
  diffStats,
  onOpenDiff,
  onOpenSettings,
  backgroundTasks,
  plan,
}: TopBarProps) {
  return (
    <header
      data-tauri-drag-region
      style={{ paddingLeft: TOP_BAR_TRAFFIC_LIGHT_INSET_PX }}
      className="flex h-11 w-full items-center justify-between border-b border-border bg-bg px-3.5 text-xs select-none"
    >
      {/* Left: session navigation. The traffic lights above are the OS's own. */}
      <div data-tauri-drag-region className="flex items-center space-x-0.5 text-fg-subtle">
        <IconButton
          label="Back"
          onClick={canGoBack ? onBack : undefined}
          disabled={!canGoBack}
        >
          <ChevronLeft size={15} />
        </IconButton>
        <IconButton
          label="Forward"
          onClick={canGoForward ? onForward : undefined}
          disabled={!canGoForward}
        >
          <ChevronRight size={15} />
        </IconButton>
      </div>

      {/* Center: what is open, or the app name when nothing is. */}
      <div
        data-tauri-drag-region
        className="flex items-center space-x-2 text-center overflow-hidden max-w-md"
      >
        {sessionName && (
          <>
            <span data-tauri-drag-region className="truncate font-medium text-fg-secondary">
              {sessionName}
            </span>
            {workspaceName && (
              <span data-tauri-drag-region className="text-fg-subtle">
                /
              </span>
            )}
          </>
        )}
        {workspaceName && (
          <span
            data-tauri-drag-region
            title={workspacePath}
            className="rounded-md bg-surface-2 border border-border px-2 py-0.5 text-[11px] font-mono text-fg-muted truncate"
          >
            {workspaceName}
          </span>
        )}
        {workspaceName && branch && (
          <span
            data-tauri-drag-region
            aria-label={`Branch ${branch}`}
            className="flex shrink-0 items-center gap-1 text-[11px] font-mono text-fg-subtle"
          >
            <GitBranch size={11} aria-hidden="true" />
            <span className="max-w-[140px] truncate">{branch}</span>
          </span>
        )}
        {workspaceName && branch && pullRequest && onOpenPullRequest && (
          <PullRequestChip pullRequest={pullRequest} onOpen={onOpenPullRequest} />
        )}
        {!sessionName && !workspaceName && (
          <span data-tauri-drag-region className="font-medium text-fg-muted">
            Zorvo
          </span>
        )}
      </div>

      {/* Right: Actions (popout, folder, overflow) */}
      <div className="flex items-center space-x-1 text-fg-muted">
        {plan && plan.length > 0 && <PlanMenu plan={plan} />}

        {backgroundTasks && <BackgroundTasksMenu {...backgroundTasks} />}

        {onToggleChanges && diffStats && onOpenDiff && (
          <DiffStatChip added={diffStats.added} removed={diffStats.removed} onOpen={onOpenDiff} />
        )}

        {onToggleChanges && (
          <button
            type="button"
            onClick={onToggleChanges}
            className="flex items-center rounded-md p-1.5 text-fg-muted hover:bg-surface-hover hover:text-fg-secondary focus-ring"
            aria-label="Toggle changes panel"
            aria-pressed={isChangesOpen}
            title="Changes"
          >
            <GitCompare size={14} className={isChangesOpen ? "text-fg" : undefined} />
          </button>
        )}

        {onToggleFiles && (
          <IconButton
            label="Toggle files panel"
            onClick={onToggleFiles}
            aria-pressed={isFilesOpen}
            title="Files"
          >
            <Folder size={14} className={isFilesOpen ? "text-fg" : undefined} />
          </IconButton>
        )}

        {onPopout && (
          <IconButton
            label="Popout window"
            onClick={onPopout}
          >
            <ExternalLink size={14} />
          </IconButton>
        )}

        {onOpenSettings && (
          <IconButton
            label="More options"
            onClick={onOpenSettings}
          >
            <MoreHorizontal size={15} />
          </IconButton>
        )}
      </div>
    </header>
  );
}
