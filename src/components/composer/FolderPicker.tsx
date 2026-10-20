import { useState } from "react";
import { Check, ChevronDown, ChevronRight, Folder, FolderPlus, GitBranch } from "lucide-react";
import type { Workspace } from "../../types";

/** The folder a new session starts in, chosen before it starts. */
export interface FolderControl {
  folders: readonly Workspace[];
  selectedPath: string | undefined;
  onSelect: (path: string) => void;
  /** Opens the native folder dialog; the entry is hidden when absent. */
  onOpenFolder?: () => void;
  /** Whether the session gets its own worktree; offered only for a git repository. */
  worktree?: { isOn: boolean; onChange: (isOn: boolean) => void };
  /** The branch the session starts on; offered only for a git repository. */
  branch?: BranchControl;
}

/** The branch row: the folder's own branch, or a worktree's starting branch while Worktree is on. */
export interface BranchControl {
  current: string;
  /** The local branches, most recently committed first; null until they are loaded. */
  branches: readonly string[] | null;
  /** Called when the branch list opens, to load it. */
  onOpen: () => void;
  onPick: (branch: string) => void;
}

export interface FolderPickerProps extends FolderControl {
  isOpen: boolean;
  onToggle: () => void;
}

/** A composer chip naming the folder, with a searchable list of recent ones. */
export function FolderPicker({ folders, selectedPath, onSelect, onOpenFolder, worktree, branch, isOpen, onToggle }: FolderPickerProps) {
  const [query, setQuery] = useState("");
  const [isBranchListOpen, setIsBranchListOpen] = useState(false);
  // However the list closed (a pick, Escape, a click elsewhere), it reopens unfiltered.
  if (!isOpen && query !== "") setQuery("");
  if (!isOpen && isBranchListOpen) setIsBranchListOpen(false);
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
        className="flex items-center gap-1.5 whitespace-nowrap rounded-lg border border-border px-2 py-1 text-xs text-fg-secondary transition-colors hover:bg-surface-hover hover:text-fg"
      >
        <Folder size={12} className="text-fg-muted" />
        <span className="max-w-[140px] truncate">{selected?.name ?? "Choose folder"}</span>
        {worktree?.isOn && <GitBranch size={11} aria-label="in a new worktree" className="text-fg" />}
        <ChevronDown size={11} className="text-fg-subtle" />
      </button>

      {isOpen && (
        <div
          role="dialog"
          aria-label="Choose a folder"
          className="absolute bottom-full left-0 z-50 mb-2 w-64 rounded-lg border border-border bg-surface-3 shadow-popover"
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
            className="w-full border-b border-border bg-transparent px-3 py-2 text-xs text-fg-secondary placeholder-fg-subtle focus-ring"
          />
          <div className="max-h-64 overflow-y-auto p-1">
            <p className="px-2.5 pb-1 pt-1.5 text-[11px] text-fg-subtle">Recent</p>
            {shown.length === 0 && <p className="px-2.5 py-1.5 text-xs text-fg-subtle">No folder matches.</p>}
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
                      className="flex w-full items-center justify-between gap-3 rounded px-2.5 py-1.5 text-left text-xs text-fg-secondary transition-colors hover:bg-surface-hover hover:text-fg"
                    >
                      <span className="truncate">{folder.name}</span>
                      {isSelected && <Check size={13} className="shrink-0 text-fg" />}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
          {onOpenFolder && (
            <div className="border-t border-border p-1">
              <button
                type="button"
                onClick={() => {
                  onToggle();
                  onOpenFolder();
                }}
                className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-xs text-fg-secondary transition-colors hover:bg-surface-hover hover:text-fg"
              >
                <FolderPlus size={13} className="text-fg-muted" />
                Open folder…
              </button>
            </div>
          )}
          {(branch || worktree) && (
            <div className="relative border-t border-border p-1">
              {branch && (
                <button
                  type="button"
                  aria-label={`Branch: ${branch.current}`}
                  aria-haspopup="listbox"
                  aria-expanded={isBranchListOpen}
                  title={
                    worktree?.isOn
                      ? "The branch the new worktree starts from"
                      : "Switches this folder to another branch"
                  }
                  onClick={() => {
                    if (!isBranchListOpen) branch.onOpen();
                    setIsBranchListOpen(!isBranchListOpen);
                  }}
                  className="flex w-full items-center justify-between gap-2 rounded px-2.5 py-1.5 text-left text-xs text-fg-secondary transition-colors hover:bg-surface-hover hover:text-fg focus-ring"
                >
                  <span>Branch</span>
                  <span className="flex min-w-0 items-center gap-1 text-fg-subtle">
                    <span className="max-w-[120px] truncate">{branch.current}</span>
                    <ChevronRight size={12} className="shrink-0" />
                  </span>
                </button>
              )}
              {branch && isBranchListOpen && (
                <BranchList
                  branch={branch}
                  onPicked={() => {
                    setIsBranchListOpen(false);
                    onToggle();
                  }}
                />
              )}
              {worktree && (
                <button
                  type="button"
                  role="switch"
                  aria-checked={worktree.isOn}
                  aria-label="Worktree"
                  title="Run the session in its own checkout, on a new branch, so it does not touch your working copy"
                  onClick={() => worktree.onChange(!worktree.isOn)}
                  className="flex w-full items-center justify-between gap-2 rounded px-2.5 py-1.5 text-left text-xs text-fg-secondary transition-colors hover:bg-surface-hover hover:text-fg"
                >
                  <span>Worktree</span>
                  <span
                    aria-hidden="true"
                    className={`relative h-4 w-7 rounded-full transition-colors ${worktree.isOn ? "bg-fg" : "bg-border-strong"}`}
                  >
                    <span
                      className={`absolute top-0.5 h-3 w-3 rounded-full transition-transform ${worktree.isOn ? "translate-x-3.5 bg-bg" : "translate-x-0.5 bg-fg"}`}
                    />
                  </span>
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** The searchable list of local branches, opened beside the folder list. */
function BranchList({ branch, onPicked }: { branch: BranchControl; onPicked: () => void }) {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const shown = (branch.branches ?? []).filter((name) => needle === "" || name.toLowerCase().includes(needle));
  const pick = (name: string) => {
    branch.onPick(name);
    onPicked();
  };

  return (
    <div className="absolute bottom-0 left-full z-50 ml-2 w-64 rounded-lg border border-border bg-surface-3 shadow-popover">
      <input
        autoFocus
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && shown[0]) pick(shown[0]);
        }}
        placeholder="Search branches..."
        aria-label="Search branches"
        className="w-full border-b border-border bg-transparent px-3 py-2 text-xs text-fg-secondary placeholder-fg-subtle focus-ring"
      />
      <div className="max-h-64 overflow-y-auto p-1">
        {branch.branches === null && <p className="px-2.5 py-1.5 text-xs text-fg-subtle">Loading branches…</p>}
        {branch.branches !== null && shown.length === 0 && (
          <p className="px-2.5 py-1.5 text-xs text-fg-subtle">No branch matches.</p>
        )}
        <ul role="listbox" aria-label="Branches">
          {shown.map((name) => {
            const isCurrent = name === branch.current;
            return (
              <li key={name}>
                <button
                  type="button"
                  role="option"
                  aria-selected={isCurrent}
                  title={name}
                  onClick={() => pick(name)}
                  className="flex w-full items-center justify-between gap-3 rounded px-2.5 py-1.5 text-left text-xs text-fg-secondary transition-colors hover:bg-surface-hover hover:text-fg"
                >
                  <span className="truncate">{name}</span>
                  {isCurrent && <Check size={13} className="shrink-0 text-fg" />}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
