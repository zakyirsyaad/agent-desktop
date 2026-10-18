import { useState } from "react";
import { Folder, FolderOpen } from "lucide-react";
import type { FolderOption } from "./types";

export interface FolderStepProps {
  recentFolders: readonly FolderOption[];
  suggestedFolders: readonly FolderOption[];
  selectedFolder: FolderOption | null;
  onSelectFolder: (folder: FolderOption) => void;
  onPickFolder: () => Promise<FolderOption | null>;
}

const PICK_ERROR = "Couldn't open the folder dialog. Try again.";

/** Lists longer than this scroll inside a fixed-height area instead of growing the page. */
export const MAX_VISIBLE_FOLDERS = 5;

const LIST_CLASS = "flex flex-col gap-1";
/** About five folder rows (two text lines plus padding and gap each). */
const SCROLL_LIST_CLASS = `${LIST_CLASS} max-h-[17rem] overflow-y-auto overscroll-contain pr-1`;

interface FolderListProps {
  label: string;
  folders: readonly FolderOption[];
  selectedPath: string | null;
  onSelect: (folder: FolderOption) => void;
}

function FolderList({ label, folders, selectedPath, onSelect }: FolderListProps) {
  if (folders.length === 0) return null;
  const listClass = folders.length > MAX_VISIBLE_FOLDERS ? SCROLL_LIST_CLASS : LIST_CLASS;
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="px-1 text-[10px] font-semibold uppercase tracking-wider text-fg-subtle">
        {label}
      </h3>
      <ul aria-label={label} className={listClass}>
        {folders.map((folder) => {
          const selected = folder.path === selectedPath;
          return (
            <li key={folder.path}>
              <button
                type="button"
                aria-pressed={selected}
                onClick={() => onSelect(folder)}
                className={`flex w-full items-center gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1 focus-visible:outline-focus-ring ${
                  selected
                    ? "border-border-strong bg-surface-hover"
                    : "border-border bg-surface-2 hover:bg-surface-hover"
                }`}
              >
                <Folder
                  size={14}
                  aria-hidden="true"
                  className={selected ? "shrink-0 text-fg" : "shrink-0 text-fg-subtle"}
                />
                <span className="min-w-0">
                  <span className="block truncate text-xs font-medium text-fg">{folder.name}</span>
                  <span className={`block truncate font-mono text-[11px] ${selected ? "text-fg-muted" : "text-fg-subtle"}`}>{folder.path}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function FolderStep({
  recentFolders,
  suggestedFolders,
  selectedFolder,
  onSelectFolder,
  onPickFolder,
}: FolderStepProps) {
  const [isPicking, setIsPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectedPath = selectedFolder?.path ?? null;

  const handlePick = async () => {
    setIsPicking(true);
    setError(null);
    try {
      const folder = await onPickFolder();
      if (folder) onSelectFolder(folder);
    } catch {
      setError(PICK_ERROR);
    } finally {
      setIsPicking(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <button
          type="button"
          onClick={handlePick}
          disabled={isPicking}
          className="flex w-fit items-center gap-2 rounded-lg border border-border-strong bg-surface-2 px-3 py-1.5 text-xs font-medium text-fg transition-colors hover:bg-surface-hover disabled:opacity-50 focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1 focus-visible:outline-focus-ring"
        >
          <FolderOpen size={14} className="text-fg-muted" aria-hidden="true" />
          Open folder…
        </button>
        {error && (
          <p role="alert" className="text-[11px] text-danger">
            {error}
          </p>
        )}
        <p className="text-[11px] text-fg-subtle" aria-live="polite">
          {selectedFolder ? (
            <>
              Selected: <span className="font-mono text-fg-secondary">{selectedFolder.path}</span>
            </>
          ) : (
            "No folder selected yet."
          )}
        </p>
      </div>
      <FolderList
        label="Recent folders"
        folders={recentFolders}
        selectedPath={selectedPath}
        onSelect={onSelectFolder}
      />
      <FolderList
        label="Suggested folders"
        folders={suggestedFolders}
        selectedPath={selectedPath}
        onSelect={onSelectFolder}
      />
    </div>
  );
}
