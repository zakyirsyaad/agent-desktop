import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { unifiedDiffRows, type FileChange } from "../../lib/git-changes";
import type { DiffTargetId } from "../../lib/diff-stats";
import { DiffRows } from "./DiffRows";
import { createLimiter } from "../../lib/limiter";

/** Diffs read at once: each is a git process, and "Expand all" may open hundreds. */
const MAX_DIFF_READS = 4;
const readDiff = createLimiter(MAX_DIFF_READS);

type DiffState = { status: "loading" } | { status: "ready"; diff: string; key: string } | { status: "failed"; error: string; key: string };

/** One changed file's diff against `target` (the last commit unless told otherwise), read when it is opened. */
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
    const controller = new AbortController();
    // A diff already shown stays while a refresh (new `version`) arrives, so it does not flash.
    // A different file or target starts over.
    setState((prev) => (prev.status === "ready" && prev.key === key ? prev : { status: "loading" }));
    readDiff(() => invoke<string>("session_file_diff", { path: rootPath, file: path, target }), controller.signal)
      .then((diff) => !controller.signal.aborted && setState({ status: "ready", diff: diff ?? "", key }))
      .catch((error) => !controller.signal.aborted && setState({ status: "failed", error: String(error), key }));
    // Gives up its turn (or its slot) so a closed section never holds up the others.
    return () => controller.abort();
  }, [rootPath, path, kind, version, target, key]);

  const rows = useMemo(() => (state.status === "ready" ? unifiedDiffRows(state.diff) : []), [state]);

  // The effect has not yet reset a state left over from another file or target.
  const isStale = state.status !== "loading" && state.key !== key;
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
