import { diffLines } from 'diff';

export type DiffRowKind = 'added' | 'removed' | 'context' | 'skipped';

export interface DiffRow {
  kind: DiffRowKind;
  /** The line, or for `skipped` how many unchanged lines were folded. */
  text: string;
}

/** Unchanged lines kept on each side of a change; longer unchanged runs are folded. */
const CONTEXT_LINES = 3;
/** Rows rendered at most, so a rewritten big file cannot freeze the chat. */
const MAX_ROWS = 1500;

function linesOf(value: string): string[] {
  const lines = value.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Folds the middle of an unchanged run, keeping context next to the changes around it. */
function foldContext(lines: string[], isFirst: boolean, isLast: boolean): DiffRow[] {
  const keepBefore = isFirst ? 0 : CONTEXT_LINES;
  const keepAfter = isLast ? 0 : CONTEXT_LINES;
  if (lines.length <= keepBefore + keepAfter + 1) return lines.map((text) => ({ kind: 'context', text }));
  const folded = lines.length - keepBefore - keepAfter;
  return [
    ...lines.slice(0, keepBefore).map((text): DiffRow => ({ kind: 'context', text })),
    { kind: 'skipped', text: `${folded} unchanged line${folded === 1 ? '' : 's'}` },
    ...lines.slice(lines.length - keepAfter).map((text): DiffRow => ({ kind: 'context', text })),
  ];
}

/** Line-by-line rows for a file change; `oldText` null means a new file. */
export function diffRows(oldText: string | null, newText: string): DiffRow[] {
  const parts = diffLines(oldText ?? '', newText);
  const rows = parts.flatMap((part, index) => {
    const lines = linesOf(part.value);
    if (part.added) return lines.map((text): DiffRow => ({ kind: 'added', text }));
    if (part.removed) return lines.map((text): DiffRow => ({ kind: 'removed', text }));
    return foldContext(lines, index === 0, index === parts.length - 1);
  });
  if (rows.length <= MAX_ROWS) return rows;
  const left = rows.length - MAX_ROWS;
  return [...rows.slice(0, MAX_ROWS), { kind: 'skipped', text: `${left} more lines not shown` }];
}

export function countChanges(rows: readonly DiffRow[]): { added: number; removed: number } {
  return {
    added: rows.filter((r) => r.kind === 'added').length,
    removed: rows.filter((r) => r.kind === 'removed').length,
  };
}
