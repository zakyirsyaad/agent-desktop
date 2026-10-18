import type { FileChange } from './git-changes';

/** What a diff is measured against: the last commit, or the branch this one forked from. */
export type DiffTargetId = 'head' | 'base';

export interface DiffTargets {
  /** The branch to compare against, when the session's branch has one. */
  base: { name: string } | null;
}

/** An uncommitted change with its line counts. */
export interface FileStat extends FileChange {
  added: number;
  removed: number;
  isBinary: boolean;
  /** Changes whenever the file's diff may have; equal means a diff already read still holds. */
  fingerprint: string;
}

/** The sign shown before removed-line counts (U+2212, not a hyphen). */
export const MINUS = '−';

/** Added and removed lines summed over all files. */
export function totalsOf(stats: readonly FileStat[]): { added: number; removed: number } {
  return stats.reduce(
    (total, stat) => ({ added: total.added + stat.added, removed: total.removed + stat.removed }),
    { added: 0, removed: 0 },
  );
}

/** A line count with thousands separators, e.g. "2,847". */
export function formatLineCount(n: number): string {
  return n.toLocaleString('en-US');
}

/** The comparison a diff shows, e.g. "main → working tree". */
export function targetLabel(target: DiffTargetId, targets: DiffTargets): string {
  const from = target === 'base' && targets.base ? targets.base.name : 'HEAD';
  return `${from} → working tree`;
}
