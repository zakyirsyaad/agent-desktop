import { memo } from "react";
import { Check, Clock, Wrench } from "lucide-react";
import type { ToolExecution } from "../../types";
import { ToolDetails } from "./ToolDetails";

/** Terminal agents report `Name(args)`; ACP agents give a ready-made title. */
function toolLabel(tool: ToolExecution): string {
  return tool.args ? `${tool.name}(${tool.args})` : tool.name;
}

function ToolStatus({ status }: { status: ToolExecution["status"] }) {
  if (status === "completed") {
    return (
      <span className="inline-flex items-center gap-1 rounded bg-emerald-950/60 border border-emerald-800/50 px-2 py-0.5 text-[11px] text-emerald-400">
        <Check className="h-3 w-3" />
        Completed
      </span>
    );
  }
  if (status === "running") {
    return (
      <span className="inline-flex items-center gap-1 rounded bg-amber-950/60 border border-amber-800/50 px-2 py-0.5 text-[11px] text-amber-400 animate-pulse">
        <Clock className="h-3 w-3" />
        Running
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded bg-rose-950/60 border border-rose-800/50 px-2 py-0.5 text-[11px] text-rose-400">
      Failed
    </span>
  );
}

const ROW =
  "flex items-center justify-between gap-2 px-3 py-1.5 font-mono text-xs text-neutral-300";
const CARD = "rounded-lg border border-neutral-800/80 bg-neutral-950/60";

function ToolRow({ tool }: { tool: ToolExecution }) {
  return (
    <>
      <div className="flex items-center gap-2 overflow-hidden">
        <Wrench className="h-3.5 w-3.5 text-neutral-500 shrink-0" />
        <span className="truncate" title={tool.locations?.join("\n")}>
          {toolLabel(tool)}
        </span>
      </div>
      <div className="shrink-0">
        <ToolStatus status={tool.status} />
      </div>
    </>
  );
}

/**
 * The agent's tool calls. One that produced something can be expanded: file
 * changes start open, so edits are visible without a click; text output
 * starts closed.
 */
export const ToolCallList = memo(function ToolCallList({ tools }: { tools: ToolExecution[] }) {
  return (
    <div className="mb-4 space-y-2">
      {tools.map((tool) => {
        if (!tool.details?.length) {
          return (
            <div key={tool.id} className={`${CARD} ${ROW}`}>
              <ToolRow tool={tool} />
            </div>
          );
        }
        const hasDiff = tool.details.some((d) => d.kind === "diff");
        return (
          <details key={tool.id} open={hasDiff} className={CARD}>
            <summary className={`${ROW} cursor-pointer list-none`}>
              <ToolRow tool={tool} />
            </summary>
            <ToolDetails details={tool.details} />
          </details>
        );
      })}
    </div>
  );
});
