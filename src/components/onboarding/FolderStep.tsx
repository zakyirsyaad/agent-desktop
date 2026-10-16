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

interface FolderListProps {
  label: string;
  folders: readonly FolderOption[];
  selectedPath: string | null;
  onSelect: (folder: FolderOption) => void;
}

function FolderList({ label, folders, selectedPath, onSelect }: FolderListProps) {
  if (folders.length === 0) return null;
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="px-1 text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
        {label}
      </h3>
      <ul aria-label={label} className="flex flex-col gap-1">
        {folders.map((folder) => {
          const selected = folder.path === selectedPath;
          return (
            <li key={folder.path}>
              <button
                type="button"
                aria-pressed={selected}
                onClick={() => onSelect(folder)}
                className={`flex w-full items-center gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors focus:outline-none focus:ring-1 focus:ring-amber-500/40 ${
                  selected
                    ? "border-amber-500/40 bg-amber-500/10"
                    : "border-[#262626] bg-[#121212] hover:bg-neutral-900"
                }`}
              >
                <Folder
                  size={14}
                  aria-hidden="true"
                  className={selected ? "shrink-0 text-amber-400" : "shrink-0 text-neutral-500"}
                />
                <span className="min-w-0">
                  <span className="block truncate text-xs font-medium text-neutral-100">{folder.name}</span>
                  <span className="block truncate font-mono text-[11px] text-neutral-500">{folder.path}</span>
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
          className="flex w-fit items-center gap-2 rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-xs font-medium text-neutral-100 transition-colors hover:bg-neutral-800 disabled:opacity-50 focus:outline-none focus:ring-1 focus:ring-amber-500/40"
        >
          <FolderOpen size={14} className="text-amber-400" aria-hidden="true" />
          Open folder…
        </button>
        {error && (
          <p role="alert" className="text-[11px] text-red-400">
            {error}
          </p>
        )}
        <p className="text-[11px] text-neutral-500" aria-live="polite">
          {selectedFolder ? (
            <>
              Selected: <span className="font-mono text-neutral-300">{selectedFolder.path}</span>
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
