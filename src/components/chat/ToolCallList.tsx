import { memo, useState } from "react";
import { Check, ChevronDown, ChevronRight, Wrench } from "lucide-react";
import type { ToolExecution } from "../../types";
import { ToolDetails } from "./ToolDetails";

function ToolStatus({ status }: { status: ToolExecution["status"] }) {
  if (status === "completed") {
    return (
      <span className="inline-flex items-center text-status-running">
        <Check className="h-3.5 w-3.5" aria-hidden="true" />
        <span className="sr-only">Completed</span>
      </span>
    );
  }
  if (status === "running") {
    return <span className="text-[11px] text-fg-muted motion-safe:animate-pulse">Running</span>;
  }
  return <span className="text-[11px] text-danger">Failed</span>;
}

const ROW =
  "flex items-center justify-between gap-2 px-3 py-1.5 font-mono text-xs text-fg-secondary";

function ToolRow({ tool, isOpen }: { tool: ToolExecution; isOpen?: boolean }) {
  const Chevron = isOpen ? ChevronDown : ChevronRight;
  return (
    <>
      <div className="flex min-w-0 items-center gap-2 overflow-hidden">
        {isOpen !== undefined && (
          <Chevron size={12} aria-hidden="true" className="shrink-0 text-fg-subtle" />
        )}
        <Wrench className="h-3.5 w-3.5 shrink-0 text-fg-subtle" />
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
    <div>
      <button
        type="button"
        aria-expanded={isOpen}
        onClick={() => setUserOpen(!isOpen)}
        className={`${ROW} focus-ring w-full cursor-pointer text-left`}
      >
        <ToolRow tool={tool} isOpen={isOpen} />
      </button>
      {isOpen && (
        <div className="pb-2.5 pl-12 pr-3 pt-1">
          <ToolDetails details={tool.details ?? []} />
        </div>
      )}
    </div>
  );
}

/**
 * The agent's tool calls as flat rows inside their group's card. One that
 * produced something can be expanded; a diff starts open only in the turn
 * being watched, text output starts closed.
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
    <div>
      {tools.map((tool, index) => (
        <div key={tool.id}>
          {index > 0 && <div className="h-px bg-border" aria-hidden="true" />}
          {tool.details?.length ? (
            <ToolCallRow tool={tool} defaultOpenDiffs={defaultOpenDiffs} />
          ) : (
            <div className={ROW}>
              <ToolRow tool={tool} />
            </div>
          )}
        </div>
      ))}
    </div>
  );
});
