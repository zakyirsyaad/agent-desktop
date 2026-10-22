import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { summarizeTools } from "../../lib/tool-summary";
import type { ToolExecution } from "../../types";
import { ToolCallList } from "./ToolCallList";

export interface ToolsPartProps {
  tools: ToolExecution[];
  /** Opens a part that shows a file change, so the diff is readable without a click. */
  defaultOpen: boolean;
}

/** One compact row for a stretch of tool calls; opens into the full tool list. */
export function ToolsPart({ tools, defaultOpen }: ToolsPartProps) {
  const hasDiff = tools.some((tool) => tool.details?.some((detail) => detail.kind === "diff"));
  const [isOpen, setOpen] = useState(defaultOpen);
  const [hadDiff, setHadDiff] = useState(hasDiff);
  // A diff can arrive after the tool started: show it once, without reopening a part the user closed.
  if (hasDiff !== hadDiff) {
    setHadDiff(hasDiff);
    if (hasDiff) setOpen(true);
  }

  const running = [...tools].reverse().find((tool) => tool.status === "running");
  const failed = tools.filter((tool) => tool.status === "failed").length;
  const label = running ? running.name : summarizeTools(tools);
  const Chevron = isOpen ? ChevronDown : ChevronRight;

  return (
    <div>
      <button
        type="button"
        aria-expanded={isOpen}
        onClick={() => setOpen((open) => !open)}
        title={label}
        className="focus-ring flex w-full items-center gap-2 rounded-lg border border-border bg-bg px-3 py-1.5 text-left font-mono text-xs text-fg-secondary transition-colors hover:bg-surface-hover"
      >
        <Chevron size={14} aria-hidden="true" className="shrink-0 text-fg-subtle" />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {running && (
          <span className="shrink-0 text-[11px] text-fg-muted motion-safe:animate-pulse">Running</span>
        )}
        {running && failed > 0 && <span className="shrink-0 text-[11px] text-danger">{failed} failed</span>}
      </button>
      {isOpen && (
        <div className="mt-2">
          <ToolCallList tools={tools} />
        </div>
      )}
    </div>
  );
}