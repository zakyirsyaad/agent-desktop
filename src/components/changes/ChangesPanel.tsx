import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ChevronRight, GitBranch, RefreshCw, X } from "lucide-react";
import { commitPathsOf, type ChangeKind, type FileChange } from "../../lib/git-changes";
import { FileDiff } from "./FileDiff";

export interface ChangesPanelProps {
  /** The folder the session works in; its whole repository's changes are listed. */
  rootPath: string;
  rootName: string;
  branch?: string;
  /** null while the first list is read. */
  changes: FileChange[] | null;
  /** Goes up with every list read; open diffs read again then. */
  version: number;
  onReload: () => void;
  onClose: () => void;
}

const KIND_LABEL: Record<ChangeKind, { letter: string; name: string; style: string }> = {
  modified: { letter: "M", name: "Modified", style: "text-amber-400" },
  added: { letter: "A", name: "Added", style: "text-emerald-400" },
  untracked: { letter: "U", name: "Untracked", style: "text-emerald-400" },
  deleted: { letter: "D", name: "Deleted", style: "text-rose-400" },
  renamed: { letter: "R", name: "Renamed", style: "text-sky-400" },
};

const HEADER_BUTTON =
  "rounded p-1 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200 focus:outline-none focus:ring-1 focus:ring-neutral-700";

type CommitState = { status: "idle" } | { status: "committing" } | { status: "done"; hash: string } | { status: "failed"; error: string };

function ChangeRow({ change, isChecked, isOpen, onCheck, onOpen }: {
  change: FileChange;
  isChecked: boolean;
  isOpen: boolean;
  onCheck: (isChecked: boolean) => void;
  onOpen: () => void;
}) {
  const kind = KIND_LABEL[change.kind];
  const slash = change.path.lastIndexOf("/");
  const name = change.path.slice(slash + 1);
  const folder = slash > 0 ? change.path.slice(0, slash) : "";
  return (
    <div className="group flex items-center gap-1.5 rounded-md px-1.5 text-neutral-400 hover:bg-neutral-900/60 hover:text-neutral-200">
      <input
        type="checkbox"
        checked={isChecked}
        onChange={(e) => onCheck(e.target.checked)}
        aria-label={`Include ${change.path} in the commit`}
        className="h-3 w-3 shrink-0 accent-amber-500"
      />
      <button
        type="button"
        onClick={onOpen}
        aria-expanded={isOpen}
        title={change.oldPath ? `${change.oldPath} → ${change.path}` : change.path}
        className="flex min-w-0 flex-1 items-center gap-1.5 py-1 text-left"
      >
        <ChevronRight size={11} aria-hidden="true" className={`shrink-0 transition-transform ${isOpen ? "rotate-90" : ""}`} />
        <span className="truncate text-neutral-200">{name}</span>
        {folder && <span className="truncate text-[10px] text-neutral-600">{folder}</span>}
      </button>
      <span title={kind.name} aria-label={kind.name} className={`w-3 shrink-0 text-center font-mono text-[10px] ${kind.style}`}>
        {kind.letter}
      </span>
    </div>
  );
}

/**
 * What changed in a session's repository since the last commit: each file's
 * diff, and a commit of the files chosen. It never pushes or throws changes away.
 */
export function ChangesPanel({ rootPath, rootName, branch, changes, version, onReload, onClose }: ChangesPanelProps) {
  // Files left out of the commit; any new change is included by default.
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(() => new Set());
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [commit, setCommit] = useState<CommitState>({ status: "idle" });

  const list = changes ?? [];
  const chosen = list.filter((change) => !excluded.has(change.path));
  const canCommit = chosen.length > 0 && message.trim() !== "" && commit.status !== "committing";

  const setIncluded = (path: string, isIncluded: boolean) =>
    setExcluded((prev) => {
      const next = new Set(prev);
      if (isIncluded) next.delete(path);
      else next.add(path);
      return next;
    });

  const handleCommit = async () => {
    if (!canCommit) return;
    setCommit({ status: "committing" });
    try {
      const hash = await invoke<string>("commit_session_changes", {
        path: rootPath,
        files: commitPathsOf(chosen),
        message: message.trim(),
      });
      setCommit({ status: "done", hash });
      setMessage("");
      setOpenPath(null);
    } catch (error) {
      setCommit({ status: "failed", error: String(error) });
    }
    onReload();
  };

  return (
    <aside
      aria-label="Changes panel"
      className="flex h-full w-80 shrink-0 flex-col border-l border-neutral-800/80 bg-[#0d0d0d] text-xs text-neutral-300 select-none"
    >
      <div className="flex items-center gap-1.5 border-b border-neutral-800/60 px-3 py-2">
        <div className="min-w-0 flex-1">
          <p className="font-medium text-neutral-200">
            Changes {changes && <span className="text-neutral-500">({list.length})</span>}
          </p>
          <p className="flex items-center gap-1 truncate text-[10px] text-neutral-500" title={rootPath}>
            {rootName}
            {branch && (
              <>
                <GitBranch size={10} aria-hidden="true" className="ml-1" />
                <span className="truncate font-mono">{branch}</span>
              </>
            )}
          </p>
        </div>
        <button type="button" onClick={onReload} aria-label="Refresh changes" title="Refresh" className={HEADER_BUTTON}>
          <RefreshCw size={12} />
        </button>
        <button type="button" onClick={onClose} aria-label="Close changes panel" className={HEADER_BUTTON}>
          <X size={13} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-1.5">
        {changes === null && <p className="px-2 py-1.5 text-[11px] text-neutral-500">Reading the changes…</p>}
        {changes !== null && list.length === 0 && (
          <p className="px-2 py-1.5 text-[11px] text-neutral-500">No uncommitted changes.</p>
        )}
        <ul aria-label={`Changes in ${rootName}`} className="space-y-0.5">
          {list.map((change) => (
            <li key={change.path}>
              <ChangeRow
                change={change}
                isChecked={!excluded.has(change.path)}
                isOpen={openPath === change.path}
                onCheck={(isChecked) => setIncluded(change.path, isChecked)}
                onOpen={() => setOpenPath((current) => (current === change.path ? null : change.path))}
              />
              {openPath === change.path && <FileDiff rootPath={rootPath} change={change} version={version} />}
            </li>
          ))}
        </ul>
      </div>

      {list.length > 0 && (
        <div className="space-y-2 border-t border-neutral-800/60 p-2.5">
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            rows={2}
            placeholder="Commit message"
            aria-label="Commit message"
            className="w-full resize-none rounded-md border border-neutral-800 bg-neutral-900/80 px-2 py-1.5 text-xs text-neutral-200 placeholder-neutral-500 outline-none focus:border-neutral-700"
          />
          <button
            type="button"
            onClick={() => void handleCommit()}
            disabled={!canCommit}
            className="w-full rounded-md bg-neutral-200 px-2 py-1.5 text-xs font-medium text-neutral-900 transition-colors hover:bg-white disabled:opacity-30 disabled:hover:bg-neutral-200"
          >
            {commit.status === "committing"
              ? "Committing…"
              : `Commit ${chosen.length} file${chosen.length === 1 ? "" : "s"}`}
          </button>
        </div>
      )}
      {commit.status === "done" && (
        <p role="status" className="border-t border-neutral-800/60 px-3 py-1.5 text-[11px] text-emerald-400">
          Committed {commit.hash}.
        </p>
      )}
      {commit.status === "failed" && (
        <p role="alert" className="border-t border-neutral-800/60 px-3 py-1.5 text-[11px] text-rose-400">
          {commit.error}
        </p>
      )}
    </aside>
  );
}
