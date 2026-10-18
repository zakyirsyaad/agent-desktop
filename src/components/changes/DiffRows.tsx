import { MINUS } from "../../lib/diff-stats";
import type { UnifiedRow, UnifiedRowKind } from "../../lib/git-changes";

const ROW_STYLE: Record<UnifiedRowKind, string> = {
  added: "bg-diff-added text-status-running",
  removed: "bg-diff-removed text-danger",
  context: "text-fg-muted",
  hunk: "bg-surface-2 text-fg-muted",
  note: "text-fg-subtle italic",
};

const ROW_SIGN: Record<UnifiedRowKind, string> = { added: "+", removed: MINUS, context: " ", hunk: "", note: "" };

const GUTTER = "w-10 shrink-0 select-none text-right tabular-nums text-fg-subtle";

/** A unified diff as rows with old and new line numbers. */
export function DiffRows({ rows, label }: { rows: UnifiedRow[]; label: string }) {
  return (
    <div
      aria-label={label}
      className="mx-1.5 mb-1.5 max-h-80 overflow-auto rounded-md border border-border bg-bg py-1 font-mono text-[11px] leading-5"
    >
      {rows.map((row, index) => (
        <div key={index} data-line={row.kind} className={`flex whitespace-pre pr-2 ${ROW_STYLE[row.kind]}`}>
          <span aria-hidden="true" className={GUTTER}>
            {row.oldLine}
          </span>
          <span aria-hidden="true" className={`${GUTTER} ml-1`}>
            {row.newLine}
          </span>
          <span aria-hidden="true" className="w-3.5 shrink-0 select-none text-center opacity-60">
            {ROW_SIGN[row.kind]}
          </span>
          <span>{row.text}</span>
        </div>
      ))}
    </div>
  );
}
