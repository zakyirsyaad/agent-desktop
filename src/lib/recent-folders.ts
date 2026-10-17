export const MAX_RECENT_FOLDERS = 8;

export interface RecentFolder {
  name: string;
  path: string;
  /** Epoch milliseconds of the last time the folder was opened. */
  lastOpenedAt: number;
}

/** Returns a new newest-first list with `folder` at the front, deduped by path and capped. */
export function addRecentFolder(
  list: readonly RecentFolder[],
  folder: { name: string; path: string },
  now: number
): RecentFolder[] {
  const entry: RecentFolder = { name: folder.name, path: folder.path, lastOpenedAt: now };
  const others = list.filter((item) => item.path !== folder.path);
  return [entry, ...others].slice(0, MAX_RECENT_FOLDERS);
}

/** Returns a new list without the folder at `path`. */
export function removeRecentFolder(list: readonly RecentFolder[], path: string): RecentFolder[] {
  return list.filter((item) => item.path !== path);
}
