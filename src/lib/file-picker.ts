import { open } from "@tauri-apps/plugin-dialog";

export interface PickedFolder {
  name: string;
  path: string;
}

const PATH_SEPARATOR = /[\\/]+/;

/** Last non-empty segment of a POSIX or Windows path, e.g. "/a/b/" -> "b". */
function folderName(path: string): string {
  const segments = path.split(PATH_SEPARATOR).filter(Boolean);
  return segments.at(-1) ?? path;
}

/** Opens the native folder dialog; resolves null when the user cancels. */
export async function pickFolder(): Promise<PickedFolder | null> {
  const selected = await open({ directory: true, multiple: false });
  if (typeof selected !== "string") {
    return null;
  }
  return { name: folderName(selected), path: selected };
}

/** Opens the native multi-file dialog; resolves [] when the user cancels. */
export async function pickFiles(): Promise<string[]> {
  const selected: string | string[] | null = await open({ directory: false, multiple: true });
  if (selected === null) {
    return [];
  }
  return Array.isArray(selected) ? selected : [selected];
}
