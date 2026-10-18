import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { unifiedDiffRows, type FileChange, type UnifiedRowKind } from "../../lib/git-changes";

const ROW_STYLE: Record<UnifiedRowKind, string> = {
  added: "bg-diff-added text-status-running",
  removed: "bg-diff-removed text-danger",
  context: "text-fg-muted",
  hunk: "text-fg-muted",
  note: "text-fg-subtle italic",
};

const ROW_SIGN: Record<UnifiedRowKind, string> = { added: "+", removed: "-", context: " ", hunk: "", note: "" };

type DiffState = { status: "loading" } | { status: "ready"; diff: string } | { status: "failed"; error: string };

/** One changed file's diff against the last commit, read when it is opened. */
export function FileDiff({ rootPath, change, version }: { rootPath: string; change: FileChange; version: number }) {
  const [state, setState] = useState<DiffState>({ status: "loading" });

  const { path, kind } = change;
  // Read again with every new list (`version`): the file may have changed since.
  useEffect(() => {
    let isCancelled = false;
    // A diff already shown stays until the new one arrives, so a refresh does not flash.
    setState((prev) => (prev.status === "ready" ? prev : { status: "loading" }));
    invoke<string>("session_file_diff", { path: rootPath, file: path })
      .then((diff) => !isCancelled && setState({ status: "ready", diff: diff ?? "" }))
      .catch((error) => !isCancelled && setState({ status: "failed", error: String(error) }));
    return () => {
      isCancelled = true;
    };
  }, [rootPath, path, kind, version]);

  const rows = useMemo(() => (state.status === "ready" ? unifiedDiffRows(state.diff) : []), [state]);

  if (state.status === "loading") return <p className="px-3 py-1.5 text-[11px] text-fg-subtle">Loading the diff…</p>;
  if (state.status === "failed") {
    return (
      <p role="alert" className="px-3 py-1.5 text-[11px] text-danger">
        Could not show the diff: {state.error}
      </p>
    );
  }
  if (rows.length === 0) return <p className="px-3 py-1.5 text-[11px] text-fg-subtle">No text changes.</p>;
  return (
    <div
      aria-label={`Diff of ${change.path}`}
      className="mx-1.5 mb-1.5 max-h-80 overflow-auto rounded-md border border-border bg-bg py-1 font-mono text-[11px] leading-5"
    >
      {rows.map((row, index) => (
        <div key={index} data-line={row.kind} className={`flex whitespace-pre px-2 ${ROW_STYLE[row.kind]}`}>
          <span aria-hidden="true" className="w-3.5 shrink-0 select-none opacity-60">
            {ROW_SIGN[row.kind]}
          </span>
          <span>{row.text}</span>
        </div>
      ))}
    </div>
  );
}
