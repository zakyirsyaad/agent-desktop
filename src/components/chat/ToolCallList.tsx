import { Check, Clock, Wrench } from "lucide-react";
import type { ToolExecution } from "../../types";

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

export function ToolCallList({ tools }: { tools: ToolExecution[] }) {
  return (
    <div className="mb-4 space-y-2">
      {tools.map((tool) => (
        <div
          key={tool.id}
          className="flex items-center justify-between gap-2 rounded-lg border border-neutral-800/80 bg-neutral-950/60 px-3 py-1.5 font-mono text-xs text-neutral-300"
        >
          <div className="flex items-center gap-2 overflow-hidden">
            <Wrench className="h-3.5 w-3.5 text-neutral-500 shrink-0" />
            <span className="truncate">{toolLabel(tool)}</span>
          </div>
          <div className="shrink-0">
            <ToolStatus status={tool.status} />
          </div>
        </div>
      ))}
    </div>
  );
}
