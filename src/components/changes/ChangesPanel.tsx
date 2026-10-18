import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ChevronRight, GitBranch, RefreshCw, X } from "lucide-react";
import { commitPathsOf, type ChangeKind, type FileChange } from "../../lib/git-changes";
import { Button } from "../ui/Button";
import { FileDiff } from "./FileDiff";
import { PullRequestList } from "./PullRequestList";
import type { PullRequestSummary } from "../../hooks/useRepoPullRequests";

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
  /** The user's pull requests in this repository, newest first; none shown when null (gh missing, not on GitHub). */
  pullRequests?: PullRequestSummary[] | null;
  onOpenPullRequest?: (url: string) => void;
}

const KIND_LABEL: Record<ChangeKind, { letter: string; name: string; style: string }> = {
  modified: { letter: "M", name: "Modified", style: "text-fg-muted" },
  added: { letter: "A", name: "Added", style: "text-status-running" },
  untracked: { letter: "U", name: "Untracked", style: "text-status-running" },
  deleted: { letter: "D", name: "Deleted", style: "text-danger" },
  renamed: { letter: "R", name: "Renamed", style: "text-fg-secondary" },
};

const HEADER_BUTTON =
  "rounded p-1 text-fg-subtle hover:bg-surface-hover hover:text-fg-secondary focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1 focus-visible:outline-focus-ring";

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
    <div className="group flex items-center gap-1.5 rounded-md px-1.5 text-fg-muted hover:bg-surface-hover hover:text-fg-secondary">
      <input
        type="checkbox"
        checked={isChecked}
        onChange={(e) => onCheck(e.target.checked)}
        aria-label={`Include ${change.path} in the commit`}
        className="h-3 w-3 shrink-0 accent-primary"
      />
      <button
        type="button"
        onClick={onOpen}
        aria-expanded={isOpen}
        title={change.oldPath ? `${change.oldPath} → ${change.path}` : change.path}
        className="flex min-w-0 flex-1 items-center gap-1.5 py-1 text-left"
      >
        <ChevronRight size={11} aria-hidden="true" className={`shrink-0 transition-transform ${isOpen ? "rotate-90" : ""}`} />
        <span className="truncate text-fg-secondary">{name}</span>
        {folder && <span className="truncate text-[10px] text-fg-muted">{folder}</span>}
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
export function ChangesPanel({
  rootPath,
  rootName,
  branch,
  changes,
  version,
  onReload,
  onClose,
  pullRequests,
  onOpenPullRequest,
}: ChangesPanelProps) {
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
      className="flex h-full w-80 shrink-0 flex-col border-l border-border bg-surface-1 text-xs text-fg-secondary select-none"
    >
      <div className="flex items-center gap-1.5 border-b border-border px-3 py-2">
        <div className="min-w-0 flex-1">
          <p className="font-medium text-fg-secondary">
            Changes {changes && <span className="text-fg-subtle">({list.length})</span>}
          </p>
          <p className="flex items-center gap-1 truncate text-[10px] text-fg-subtle" title={rootPath}>
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

      {pullRequests && onOpenPullRequest && (
        <div className="max-h-[45%] shrink-0 overflow-y-auto">
          <PullRequestList pullRequests={pullRequests} onOpen={onOpenPullRequest} />
        </div>
      )}
      <div className="flex-1 overflow-y-auto p-1.5">
        {changes === null && <p className="px-2 py-1.5 text-[11px] text-fg-subtle">Reading the changes…</p>}
        {changes !== null && list.length === 0 && (
          <p className="px-2 py-1.5 text-[11px] text-fg-subtle">No uncommitted changes.</p>
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
        <div className="space-y-2 border-t border-border p-2.5">
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            rows={2}
            placeholder="Commit message"
            aria-label="Commit message"
            className="w-full resize-none rounded-md border border-border-strong bg-surface-2 px-2 py-1.5 text-xs text-fg-secondary placeholder-fg-subtle focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1 focus-visible:outline-focus-ring"
          />
          <Button
            variant="primary"
            onClick={() => void handleCommit()}
            disabled={!canCommit}
            className="w-full"
          >
            {commit.status === "committing"
              ? "Committing…"
              : `Commit ${chosen.length} file${chosen.length === 1 ? "" : "s"}`}
          </Button>
        </div>
      )}
      {commit.status === "done" && (
        <p role="status" className="border-t border-border px-3 py-1.5 text-[11px] text-status-running">
          Committed {commit.hash}.
        </p>
      )}
      {commit.status === "failed" && (
        <p role="alert" className="border-t border-border px-3 py-1.5 text-[11px] text-danger">
          {commit.error}
        </p>
      )}
    </aside>
  );
}
