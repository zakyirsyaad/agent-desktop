import { memo, useState } from "react";
import { Check, ChevronDown, ChevronRight, Clock, Wrench } from "lucide-react";
import type { ToolExecution } from "../../types";
import { ToolDetails } from "./ToolDetails";


function ToolStatus({ status }: { status: ToolExecution["status"] }) {
  if (status === "completed") {
    return (
      <span className="inline-flex items-center gap-1 rounded bg-diff-added border border-border px-2 py-0.5 text-[11px] text-status-running">
        <Check className="h-3 w-3" />
        Completed
      </span>
    );
  }
  if (status === "running") {
    return (
      <span className="inline-flex items-center gap-1 rounded bg-surface-2 border border-border px-2 py-0.5 text-[11px] text-fg-muted animate-pulse motion-reduce:animate-none">
        <Clock className="h-3 w-3" />
        Running
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded bg-danger-surface border border-border px-2 py-0.5 text-[11px] text-danger">
      Failed
    </span>
  );
}

const ROW =
  "flex items-center justify-between gap-2 px-3 py-1.5 font-mono text-xs text-fg-secondary";
const CARD = "rounded-lg border border-border bg-bg";

function ToolRow({ tool, isOpen }: { tool: ToolExecution; isOpen?: boolean }) {
  const Chevron = isOpen ? ChevronDown : ChevronRight;
  return (
    <>
      <div className="flex items-center gap-2 overflow-hidden">
        {isOpen !== undefined && (
          <Chevron size={12} aria-hidden="true" className="shrink-0 text-fg-subtle" />
        )}
        <Wrench className="h-3.5 w-3.5 text-fg-subtle shrink-0" />
        <span className="truncate" title={tool.locations?.join("\n")}>
          {tool.name}
        </span>
      </div>
      <div className="shrink-0">
        <ToolStatus status={tool.status} />
      </div>
    </>
  );
}

/**
 * One tool call. Its output and diff stay out of the DOM until the row is
 * opened, and a diff opens itself only where its turn is being watched.
 */
function ToolCallRow({ tool, defaultOpenDiffs }: { tool: ToolExecution; defaultOpenDiffs: boolean }) {
  const hasDiff = tool.details?.some((detail) => detail.kind === "diff") ?? false;
  // Only an explicit click overrides the turn rule: an auto-opened row closes
  // again when the user moves on, while a row they opened stays open.
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const isOpen = userOpen ?? (defaultOpenDiffs && hasDiff);

  return (
    <div className={CARD}>
      <button
        type="button"
        aria-expanded={isOpen}
        onClick={() => setUserOpen(!isOpen)}
        className={`${ROW} focus-ring w-full cursor-pointer text-left transition-colors hover:bg-surface-hover`}
      >
        <ToolRow tool={tool} isOpen={isOpen} />
      </button>
      {isOpen && <ToolDetails details={tool.details ?? []} />}
    </div>
  );
}

/**
 * The agent's tool calls. One that produced something can be expanded; a diff
 * starts open only in the turn being watched, text output starts closed.
 */
export const ToolCallList = memo(function ToolCallList({
  tools,
  defaultOpenDiffs,
}: {
  tools: ToolExecution[];
  /** Whether a tool with a diff starts open; false in earlier turns. */
  defaultOpenDiffs: boolean;
}) {
  return (
    <div className="mb-4 space-y-2">
      {tools.map((tool) =>
        tool.details?.length ? (
          <ToolCallRow key={tool.id} tool={tool} defaultOpenDiffs={defaultOpenDiffs} />
        ) : (
          <div key={tool.id} className={`${CARD} ${ROW}`}>
            <ToolRow tool={tool} />
          </div>
        ),
      )}
    </div>
  );
});
