/** An @-mention being typed: where it sits in the text and what follows the @. */
export interface MentionQuery {
  start: number;
  end: number;
  query: string;
}

/** How many files the mention list offers. */
export const MENTION_LIMIT = 8;

/**
 * The @word the caret is at the end of, when the @ starts the text or follows
 * whitespace, so an email address is not taken for one.
 */
export function mentionAt(text: string, caret: number): MentionQuery | null {
  const before = text.slice(0, caret);
  const match = /(^|\s)@([^\s@]*)$/.exec(before);
  if (!match) return null;
  const start = caret - match[2].length - 1;
  return { start, end: caret, query: match[2] };
}

/** How well a path matches: lower is better, null when it does not. */
function rankOf(path: string, query: string): number | null {
  const lowerPath = path.toLowerCase();
  const name = lowerPath.slice(lowerPath.lastIndexOf('/') + 1);
  if (name.startsWith(query)) return 0;
  if (name.includes(query)) return 1;
  if (lowerPath.includes(query)) return 2;
  return null;
}

/** The files best matching `query`: by name first, then by path, shorter paths first. */
export function matchFiles(files: readonly string[], query: string, limit = MENTION_LIMIT): string[] {
  const needle = query.toLowerCase();
  if (needle === '') return files.slice(0, limit);
  return files
    .map((path) => ({ path, rank: rankOf(path, needle) }))
    .filter((entry): entry is { path: string; rank: number } => entry.rank !== null)
    .sort((a, b) => a.rank - b.rank || a.path.length - b.path.length || a.path.localeCompare(b.path))
    .slice(0, limit)
    .map((entry) => entry.path);
}
