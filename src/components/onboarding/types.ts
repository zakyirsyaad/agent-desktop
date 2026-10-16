/** A project folder as the setup screens see it; extra fields on recent items are ignored. */
export interface FolderOption {
  name: string;
  path: string;
}

export interface OnboardingResult {
  defaultAgentId: string;
  folder: FolderOption;
}

/** Drops persistence fields such as `lastOpenedAt` so callers get exactly `{ name, path }`. */
export function toFolderOption(folder: FolderOption): FolderOption {
  return { name: folder.name, path: folder.path };
}
