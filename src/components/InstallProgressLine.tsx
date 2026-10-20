import { Button } from "./ui/Button";
import type { InstallProgress } from "../hooks/useAgentInstall";
import { describePhase } from "../lib/install-plan";

const PROGRESS_BAR =
  "h-1.5 w-full appearance-none overflow-hidden rounded-full bg-surface-2 " +
  "[&::-webkit-progress-bar]:bg-surface-2 [&::-webkit-progress-value]:bg-primary";

export interface InstallProgressLineProps {
  progress: InstallProgress | null;
  onCancel: () => void;
  /** What the job is, for the line shown before the first progress report. */
  action?: "install" | "update";
}

export function InstallProgressLine({ progress, onCancel, action = "install" }: InstallProgressLineProps) {
  return (
    <div className="mt-2 space-y-1.5">
      {progress && (
        <progress
          aria-label={`${progress.name} download`}
          className={PROGRESS_BAR}
          max={progress.totalBytes || undefined}
          value={progress.totalBytes ? progress.receivedBytes : undefined}
        />
      )}
      <div className="flex items-center justify-between gap-3">
        <p className="text-fg-muted">
          {progress ? describePhase(progress.phase, progress.name) : `Starting the ${action}…`}
        </p>
        <Button onClick={onCancel} className="shrink-0">
          Cancel
        </Button>
      </div>
    </div>
  );
}
