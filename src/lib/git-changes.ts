/** How a file differs from the last commit, as the backend's `ChangeKind`. */
export type ChangeKind = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked';

/** One uncommitted change; paths are relative to the repository's root. */
export interface FileChange {
  path: string;
  /** Where a renamed file came from. */
  oldPath: string | null;
  kind: ChangeKind;
}

export type UnifiedRowKind = 'added' | 'removed' | 'context' | 'hunk' | 'note';

export interface UnifiedRow {
  kind: UnifiedRowKind;
  text: string;
}

/** Rows rendered at most, so a huge diff cannot freeze the panel. */
const MAX_ROWS = 1500;
/** git's file header lines, which the panel already shows as the file's name. */
const FILE_HEADER = /^(diff --git |index |--- |\+\+\+ |new file mode |deleted file mode |similarity index |rename (from|to) |old mode |new mode )/;

/** Display rows for git's unified diff: its file header dropped, each line marked. */
export function unifiedDiffRows(diff: string): UnifiedRow[] {
  const lines = diff.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  // The header only comes before the first hunk; inside one, "--- x" is a removed "-- x".
  const firstHunk = lines.findIndex((line) => line.startsWith('@@'));
  const rows = lines
    .filter((line, index) => !(FILE_HEADER.test(line) && (firstHunk < 0 || index < firstHunk)))
    .map((line): UnifiedRow => {
      if (line.startsWith('@@')) return { kind: 'hunk', text: line };
      if (line.startsWith('+')) return { kind: 'added', text: line.slice(1) };
      if (line.startsWith('-')) return { kind: 'removed', text: line.slice(1) };
      if (line.startsWith(' ')) return { kind: 'context', text: line.slice(1) };
      // "\ No newline at end of file", "Binary files … differ", a cut notice.
      return { kind: 'note', text: line };
    });
  if (rows.length <= MAX_ROWS) return rows;
  const left = rows.length - MAX_ROWS;
  return [...rows.slice(0, MAX_ROWS), { kind: 'note', text: `${left} more lines not shown` }];
}

/** The paths a commit of these changes takes: a rename's old path too. */
export function commitPathsOf(changes: readonly FileChange[]): string[] {
  return changes.flatMap((change) => (change.oldPath ? [change.path, change.oldPath] : [change.path]));
}
