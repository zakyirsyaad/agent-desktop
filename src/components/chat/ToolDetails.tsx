import { useMemo } from "react";
import type { ToolDetail } from "../../types";
import { countChanges, diffRows, type DiffRowKind } from "../../lib/diff-rows";

const ROW_STYLE: Record<DiffRowKind, string> = {
  added: "bg-emerald-950/50 text-emerald-200",
  removed: "bg-rose-950/50 text-rose-200",
  context: "text-neutral-400",
  skipped: "text-neutral-600 italic",
};

const ROW_SIGN: Record<DiffRowKind, string> = { added: "+", removed: "-", context: " ", skipped: "⋯" };

function DiffView({ path, oldText, newText }: { path: string; oldText: string | null; newText: string }) {
  const rows = useMemo(() => diffRows(oldText, newText), [oldText, newText]);
  const { added, removed } = countChanges(rows);
  return (
    <section aria-label={`Changes to ${path}`} className="overflow-hidden rounded-md border border-neutral-800">
      <header className="flex items-center gap-2 border-b border-neutral-800 bg-neutral-900/60 px-2.5 py-1 text-[11px]">
        <span className="truncate text-neutral-300" title={path}>
          {path}
        </span>
        {oldText === null && <span className="rounded bg-neutral-800 px-1.5 text-neutral-400">New file</span>}
        <span className="ml-auto shrink-0 text-emerald-400">+{added}</span>
        {removed > 0 && <span className="shrink-0 text-rose-400">-{removed}</span>}
      </header>
      <div className="max-h-80 overflow-auto py-1 font-mono text-[11px] leading-5">
        {rows.map((row, index) => (
          <div key={index} data-line={row.kind} className={`flex whitespace-pre px-2.5 ${ROW_STYLE[row.kind]}`}>
            <span aria-hidden="true" className="w-4 shrink-0 select-none opacity-60">
              {ROW_SIGN[row.kind]}
            </span>
            <span>{row.text}</span>
          </div>
        ))}
      </div>
    </section>
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
          <pre
            key={index}
            className="max-h-60 overflow-auto whitespace-pre-wrap rounded-md border border-neutral-800 bg-neutral-950 px-2.5 py-1.5 font-mono text-[11px] text-neutral-300"
          >
            {detail.text}
          </pre>
        ),
      )}
    </div>
  );
}
