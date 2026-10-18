import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { unifiedDiffRows, type FileChange } from "../../lib/git-changes";
import type { DiffTargetId } from "../../lib/diff-stats";
import { DiffRows } from "./DiffRows";

type DiffState = { status: "loading" } | { status: "ready"; diff: string; key: string } | { status: "failed"; error: string };

/** One changed file's diff against the last commit, read when it is opened. */
export function FileDiff({ rootPath, change, version, target = "head" }: {
  rootPath: string;
  change: FileChange;
  /** The diff is read again whenever this changes. */
  version: number | string;
  target?: DiffTargetId;
}) {
  const [state, setState] = useState<DiffState>({ status: "loading" });

  const { path, kind } = change;
  // What is being read; a diff of anything else must never show.
  const key = `${rootPath}\0${path}\0${target}`;
  // Read again with every new list (`version`): the file may have changed since.
  useEffect(() => {
    let isCancelled = false;
    // A diff already shown stays while a refresh (new `version`) arrives, so it does not flash.
    // A different file or target starts over.
    setState((prev) => (prev.status === "ready" && prev.key === key ? prev : { status: "loading" }));
    invoke<string>("session_file_diff", { path: rootPath, file: path, target })
      .then((diff) => !isCancelled && setState({ status: "ready", diff: diff ?? "", key }))
      .catch((error) => !isCancelled && setState({ status: "failed", error: String(error) }));
    return () => {
      isCancelled = true;
    };
  }, [rootPath, path, kind, version, target, key]);

  const rows = useMemo(() => (state.status === "ready" ? unifiedDiffRows(state.diff) : []), [state]);

  // The effect has not yet reset a state left over from another file or target.
  const isStale = state.status === "ready" && state.key !== key;
  if (state.status === "loading" || isStale) return <p className="px-3 py-1.5 text-[11px] text-fg-subtle">Loading the diff…</p>;
  if (state.status === "failed") {
    return (
      <p role="alert" className="px-3 py-1.5 text-[11px] text-danger">
        Could not show the diff: {state.error}
      </p>
    );
  }
  if (rows.length === 0) return <p className="px-3 py-1.5 text-[11px] text-fg-subtle">No text changes.</p>;
  return <DiffRows rows={rows} label={`Diff of ${change.path}`} />;
}
