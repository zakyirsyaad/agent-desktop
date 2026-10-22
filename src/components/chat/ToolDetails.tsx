import { useMemo, useState } from "react";
import type { ToolDetail } from "../../types";
import { countChanges, diffRows, type DiffRowKind } from "../../lib/diff-rows";

const ROW_STYLE: Record<DiffRowKind, string> = {
  added: "bg-diff-added text-fg",
  removed: "bg-diff-removed text-fg",
  context: "text-fg-muted",
  skipped: "text-fg-subtle italic",
};

const ROW_SIGN: Record<DiffRowKind, string> = { added: "+", removed: "-", context: " ", skipped: "⋯" };

/** Rows of a diff, or lines of an output, rendered before offering the rest. */
const MAX_DETAIL_ROWS = 400;

function ShowAllButton({
  count,
  expanded,
  onToggle,
}: {
  count: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-expanded={expanded}
      onClick={onToggle}
      className="focus-ring w-full border-t border-border px-2.5 py-1 text-left text-[11px] text-fg-muted transition-colors hover:bg-surface-hover"
    >
      {expanded ? "Show fewer lines" : `Show all ${count} lines`}
    </button>
  );
}

function DiffView({ path, oldText, newText }: { path: string; oldText: string | null; newText: string }) {
  const rows = useMemo(() => diffRows(oldText, newText), [oldText, newText]);
  const { added, removed } = countChanges(rows);
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? rows : rows.slice(0, MAX_DETAIL_ROWS);
  return (
    <section aria-label={`Changes to ${path}`} className="overflow-hidden rounded-md border border-border">
      <header className="flex items-center gap-2 border-b border-border bg-surface-2 px-2.5 py-1 text-[11px]">
        <span className="truncate text-fg-secondary" title={path}>
          {path}
        </span>
        {oldText === null && <span className="rounded bg-surface-hover px-1.5 text-fg-muted">New file</span>}
        <span className="ml-auto shrink-0 text-status-running">+{added}</span>
        {removed > 0 && <span className="shrink-0 text-danger">-{removed}</span>}
      </header>
      <div className="max-h-80 overflow-auto py-1 font-mono text-[11px] leading-5">
        {shown.map((row, index) => (
          <div key={index} data-line={row.kind} className={`flex whitespace-pre px-2.5 ${ROW_STYLE[row.kind]}`}>
            <span aria-hidden="true" className="w-4 shrink-0 select-none opacity-60">
              {ROW_SIGN[row.kind]}
            </span>
            <span>{row.text}</span>
          </div>
        ))}
      </div>
      {rows.length > MAX_DETAIL_ROWS && (
        <ShowAllButton
          count={rows.length}
          expanded={showAll}
          onToggle={() => setShowAll((open) => !open)}
        />
      )}
    </section>
  );
}

function TextOutput({ text }: { text: string }) {
  const lines = useMemo(() => {
    const split = text.split("\n");
    if (split[split.length - 1] === "") split.pop();
    return split;
  }, [text]);
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? lines : lines.slice(0, MAX_DETAIL_ROWS);
  return (
    <div className="overflow-hidden rounded-md border border-border bg-bg">
      <pre className="max-h-60 overflow-auto whitespace-pre-wrap px-2.5 py-1.5 font-mono text-[11px] text-fg-secondary">
        {shown.join("\n")}
      </pre>
      {lines.length > MAX_DETAIL_ROWS && (
        <ShowAllButton
          count={lines.length}
          expanded={showAll}
          onToggle={() => setShowAll((open) => !open)}
        />
      )}
    </div>
  );
}

/** What a tool produced: file diffs and text output. */
export function ToolDetails({ details }: { details: ToolDetail[] }) {
  return (
    <div className="space-y-2 px-3 pb-2.5 pt-1">
      {details.map((detail, index) =>
        detail.kind === "diff" ? (
          <DiffView key={index} path={detail.path} oldText={detail.oldText} newText={detail.newText} />
        ) : (
          <TextOutput key={index} text={detail.text} />
        ),
      )}
    </div>
  );
}
