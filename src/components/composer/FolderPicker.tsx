import { useState } from "react";
import { Check, ChevronDown, Folder, FolderPlus } from "lucide-react";
import type { Workspace } from "../../types";

/** The folder a new session starts in, chosen before it starts. */
export interface FolderControl {
  folders: readonly Workspace[];
  selectedPath: string | undefined;
  onSelect: (path: string) => void;
  /** Opens the native folder dialog; the entry is hidden when absent. */
  onOpenFolder?: () => void;
}

export interface FolderPickerProps extends FolderControl {
  isOpen: boolean;
  onToggle: () => void;
}

/** A composer chip naming the folder, with a searchable list of recent ones. */
export function FolderPicker({ folders, selectedPath, onSelect, onOpenFolder, isOpen, onToggle }: FolderPickerProps) {
  const [query, setQuery] = useState("");
  // However the list closed (a pick, Escape, a click elsewhere), it reopens unfiltered.
  if (!isOpen && query !== "") setQuery("");
  const selected = folders.find((folder) => folder.path === selectedPath);
  const needle = query.trim().toLowerCase();
  const shown = folders.filter(
    (folder) => needle === "" || folder.name.toLowerCase().includes(needle) || folder.path.toLowerCase().includes(needle),
  );

  return (
    <div className="relative">
      <button
        type="button"
        aria-label={`Folder: ${selected?.name ?? "none"}`}
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        onClick={onToggle}
        title={selected?.path}
        className="flex items-center gap-1.5 rounded-lg border border-neutral-800/60 px-2 py-1 text-xs text-neutral-300 transition-colors hover:bg-neutral-800 hover:text-neutral-100"
      >
        <Folder size={12} className="text-neutral-400" />
        <span className="max-w-[140px] truncate">{selected?.name ?? "Choose folder"}</span>
        <ChevronDown size={11} className="text-neutral-500" />
      </button>

      {isOpen && (
        <div
          role="dialog"
          aria-label="Choose a folder"
          className="absolute bottom-full left-0 z-50 mb-2 w-64 rounded-lg border border-neutral-800 bg-[#181818] shadow-2xl"
        >
          <input
            autoFocus
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && shown[0]) {
                onSelect(shown[0].path);
                onToggle();
              }
            }}
            placeholder="Search folders..."
            aria-label="Search folders"
            className="w-full border-b border-neutral-800 bg-transparent px-3 py-2 text-xs text-neutral-200 placeholder-neutral-500 outline-none"
          />
          <div className="max-h-64 overflow-y-auto p-1">
            <p className="px-2.5 pb-1 pt-1.5 text-[11px] text-neutral-500">Recent</p>
            {shown.length === 0 && <p className="px-2.5 py-1.5 text-xs text-neutral-500">No folder matches.</p>}
            <ul role="listbox" aria-label="Recent folders">
              {shown.map((folder) => {
                const isSelected = folder.path === selectedPath;
                return (
                  <li key={folder.path}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={isSelected}
                      title={folder.path}
                      onClick={() => {
                        onSelect(folder.path);
                        onToggle();
                      }}
                      className="flex w-full items-center justify-between gap-3 rounded px-2.5 py-1.5 text-left text-xs text-neutral-300 transition-colors hover:bg-neutral-800/60 hover:text-neutral-100"
                    >
                      <span className="truncate">{folder.name}</span>
                      {isSelected && <Check size={13} className="shrink-0 text-amber-400" />}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
          {onOpenFolder && (
            <div className="border-t border-neutral-800 p-1">
              <button
                type="button"
                onClick={() => {
                  onToggle();
                  onOpenFolder();
                }}
                className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-xs text-neutral-300 transition-colors hover:bg-neutral-800/60 hover:text-neutral-100"
              >
                <FolderPlus size={13} className="text-neutral-400" />
                Open folder…
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
