import { ChevronRight, File } from "lucide-react";
import { FileDiff } from "./FileDiff";
import { formatLineCount, MINUS, type DiffTargetId, type FileStat } from "../../lib/diff-stats";

/** One file in the diff view: a header with its counts, and the diff read on first open. */
export function DiffFileSection({ rootPath, stat, target, version, isOpen, onToggle }: {
  rootPath: string;
  stat: FileStat;
  target: DiffTargetId;
  /** The diff is read again whenever this changes. */
  version: number | string;
  isOpen: boolean;
  onToggle: () => void;
}) {
  const slash = stat.path.lastIndexOf("/");
  const name = stat.path.slice(slash + 1);
  const folder = slash > 0 ? stat.path.slice(0, slash) : "";
  return (
    <section>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={isOpen}
        title={stat.oldPath ? `${stat.oldPath} → ${stat.path}` : stat.path}
        className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-fg-muted hover:bg-surface-hover hover:text-fg-secondary focus-ring"
      >
        <ChevronRight size={11} aria-hidden="true" className={`shrink-0 transition-transform ${isOpen ? "rotate-90" : ""}`} />
        <File size={11} aria-hidden="true" className="shrink-0" />
        <span className="min-w-0 truncate text-fg-secondary">{name}</span>
        {folder && <span className="min-w-0 flex-1 truncate text-[10px] text-fg-subtle">{folder}</span>}
        <span className="ml-auto shrink-0 text-[11px] tabular-nums text-status-running">+{formatLineCount(stat.added)}</span>
        <span className="shrink-0 text-[11px] tabular-nums text-danger">
          {MINUS}
          {formatLineCount(stat.removed)}
        </span>
      </button>
      {isOpen &&
        (stat.isBinary ? (
          <p className="px-3 py-1.5 text-[11px] text-fg-subtle">Binary file</p>
        ) : (
          <FileDiff rootPath={rootPath} change={stat} target={target} version={version} />
        ))}
    </section>
  );
}
