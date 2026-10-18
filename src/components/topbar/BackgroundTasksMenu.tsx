import { useEffect, useRef, useState } from "react";
import { Bot, Cog, ListChecks, Terminal, type LucideIcon } from "lucide-react";
import { Button } from "../ui/Button";
import { IconButton } from "../ui/IconButton";
import { useDismiss } from "../../hooks/useDismiss";
import { formatElapsed, type BackgroundTask, type BackgroundTaskKind } from "../../lib/background-tasks";

export interface BackgroundTasksMenuProps {
  tasks: BackgroundTask[];
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenTask: (task: BackgroundTask) => void;
  onStopTask: (task: BackgroundTask) => Promise<boolean>;
}

const TICK_MS = 1000;

const KIND_ICONS: Record<BackgroundTaskKind, LucideIcon> = {
  agent: Bot,
  terminal: Terminal,
  process: Cog,
};

const STATUS_CLASSES: Record<BackgroundTask["status"], string> = {
  Working: "text-status-running",
  Running: "text-status-running",
  "Needs approval": "text-status-attention",
};

/** The current time, refreshed every second while `isActive`. */
function useNow(isActive: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!isActive) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [isActive]);
  return now;
}

export function BackgroundTasksMenu({ tasks, isOpen, onOpenChange, onOpenTask, onStopTask }: BackgroundTasksMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const now = useNow(isOpen);
  const [stoppingIds, setStoppingIds] = useState<ReadonlySet<string>>(new Set());
  useDismiss(ref, isOpen, () => onOpenChange(false));

  // A task that is gone is no longer stopping; if it comes back it is a new run.
  useEffect(() => {
    setStoppingIds((current) => {
      const present = new Set(tasks.map((t) => t.id));
      const kept = [...current].filter((id) => present.has(id));
      return kept.length === current.size ? current : new Set(kept);
    });
  }, [tasks]);

  const stop = (task: BackgroundTask) => {
    setStoppingIds((current) => new Set(current).add(task.id));
    void onStopTask(task).then((isStopped) => {
      if (isStopped) return;
      setStoppingIds((current) => {
        const next = new Set(current);
        next.delete(task.id);
        return next;
      });
    });
  };

  const count = tasks.length;
  const label = count > 0 ? `Background tasks (${count} running)` : "Background tasks";

  return (
    <div ref={ref} className="relative">
      <IconButton label={label} aria-expanded={isOpen} onClick={() => onOpenChange(!isOpen)} className="relative">
        <ListChecks size={14} aria-hidden="true" className={isOpen ? "text-fg" : undefined} />
        {count > 0 && (
          <span
            aria-hidden="true"
            className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-primary px-1 text-[9px] font-medium text-on-primary"
          >
            {count}
          </span>
        )}
      </IconButton>

      {isOpen && (
        <div className="absolute right-0 top-full z-50 mt-1 w-96 rounded-lg border border-border bg-surface-3 p-1 shadow-popover">
          {count === 0 ? (
            <p className="px-3 py-4 text-center text-xs text-fg-muted">Nothing running.</p>
          ) : (
            <ul aria-label="Running tasks" className="max-h-80 overflow-y-auto">
              {tasks.map((task) => {
                const Icon = KIND_ICONS[task.kind];
                const isStopping = stoppingIds.has(task.id);
                return (
                  <li key={task.id} className="flex items-center gap-2.5 rounded-md px-2 py-2">
                    <Icon size={14} aria-hidden="true" className="shrink-0 text-fg-muted" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-medium text-fg" title={task.name}>
                        {task.name}
                      </p>
                      <p className="flex items-center gap-1.5 text-[11px] text-fg-subtle">
                        <span className={STATUS_CLASSES[task.status]}>{task.status}</span>
                        <span className="tabular-nums">{formatElapsed(now - task.startedAt)}</span>
                      </p>
                      {task.detail && <p className="truncate text-[11px] text-fg-subtle">{task.detail}</p>}
                    </div>
                    <Button
                      variant="outline"
                      aria-label={`Open ${task.name}`}
                      className="shrink-0"
                      onClick={() => {
                        onOpenTask(task);
                        onOpenChange(false);
                      }}
                    >
                      Open
                    </Button>
                    <Button
                      variant="outline"
                      aria-label={`Stop ${task.name}`}
                      className="shrink-0"
                      disabled={isStopping}
                      onClick={() => stop(task)}
                    >
                      {isStopping ? "Stopping…" : "Stop"}
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
