import { formatLineCount, MINUS } from "../../lib/diff-stats";

/** The `+added −removed` totals; opens the diff view. Hidden when nothing changed. */
export function DiffStatChip({ added, removed, onOpen }: { added: number; removed: number; onOpen: () => void }) {
  if (added === 0 && removed === 0) return null;
  const addedText = formatLineCount(added);
  const removedText = formatLineCount(removed);
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`${addedText} lines added, ${removedText} removed. Open the diff`}
      className="flex items-center gap-1.5 rounded-md bg-surface-2 px-2 py-0.5 text-[11px] tabular-nums hover:bg-surface-hover focus-ring"
    >
      <span className="text-status-running">+{addedText}</span>
      <span className="text-danger">
        {MINUS}
        {removedText}
      </span>
    </button>
  );
}
