import { invoke } from "@tauri-apps/api/core";

/** One child of a workspace folder, as `list_directory` returns it. */
export interface DirEntryInfo {
  name: string;
  /** Path from the workspace root, `/`-separated; `""` is the root itself. */
  relativePath: string;
  isDir: boolean;
}

/** Loaded listings keyed by folder relative path (`""` for the root). */
export type ChildrenByFolder = Readonly<Record<string, readonly DirEntryInfo[]>>;

export const ROOT_FOLDER = "";

function isDirEntryInfo(value: unknown): value is DirEntryInfo {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.name === "string" &&
    typeof candidate.relativePath === "string" &&
    typeof candidate.isDir === "boolean"
  );
}

/** Validates a `list_directory` response; throws when it is not a list of entries. */
export function parseDirEntries(value: unknown): DirEntryInfo[] {
  if (!Array.isArray(value) || !value.every(isDirEntryInfo)) {
    throw new Error("Unexpected folder listing from the backend");
  }
  return value;
}

export async function listDirectory(root: string, relative: string): Promise<DirEntryInfo[]> {
  return parseDirEntries(await invoke("list_directory", { root, relative }));
}

/** Opens a workspace file with the platform's default application. */
export async function openWorkspacePath(root: string, relative: string): Promise<void> {
  await invoke("open_path", { root, relative });
}

export function joinWorkspacePath(root: string, relativePath: string): string {
  return `${root.replace(/\/+$/, "")}/${relativePath}`;
}

/** Parent folders of `relativePath`, top-down: `"a/b/c"` → `["a", "a/b"]`. */
export function ancestorPaths(relativePath: string): string[] {
  const segments = relativePath.split("/").slice(0, -1);
  return segments.map((_, index) => segments.slice(0, index + 1).join("/"));
}

/**
 * Paths to show for a filter: loaded entries whose name contains the query,
 * plus their parent folders. Returns null when the query is blank.
 */
export function filterVisiblePaths(children: ChildrenByFolder, query: string): Set<string> | null {
  const needle = query.trim().toLowerCase();
  if (needle === "") return null;

  const matches = Object.values(children)
    .flat()
    .filter((entry) => entry.name.toLowerCase().includes(needle));
  return new Set(matches.flatMap((entry) => [...ancestorPaths(entry.relativePath), entry.relativePath]));
}

/** Message text from a rejected `invoke`, which rejects with a plain string. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
