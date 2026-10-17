import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { unifiedDiffRows, type FileChange, type UnifiedRowKind } from "../../lib/git-changes";

const ROW_STYLE: Record<UnifiedRowKind, string> = {
  added: "bg-emerald-950/50 text-emerald-200",
  removed: "bg-rose-950/50 text-rose-200",
  context: "text-neutral-400",
  hunk: "text-sky-400/80",
  note: "text-neutral-600 italic",
};

const ROW_SIGN: Record<UnifiedRowKind, string> = { added: "+", removed: "-", context: " ", hunk: "", note: "" };

type DiffState = { status: "loading" } | { status: "ready"; diff: string } | { status: "failed"; error: string };

/** One changed file's diff against the last commit, read when it is opened. */
export function FileDiff({ rootPath, change }: { rootPath: string; change: FileChange }) {
  const [state, setState] = useState<DiffState>({ status: "loading" });

  const { path, oldPath, kind } = change;
  // Keyed on the change's fields: a reloaded list makes new objects for the same file.
  useEffect(() => {
    let isCancelled = false;
    setState({ status: "loading" });
    invoke<string>("session_file_diff", { path: rootPath, change: { path, oldPath, kind } })
      .then((diff) => !isCancelled && setState({ status: "ready", diff: diff ?? "" }))
      .catch((error) => !isCancelled && setState({ status: "failed", error: String(error) }));
    return () => {
      isCancelled = true;
    };
  }, [rootPath, path, oldPath, kind]);

  const rows = useMemo(() => (state.status === "ready" ? unifiedDiffRows(state.diff) : []), [state]);

  if (state.status === "loading") return <p className="px-3 py-1.5 text-[11px] text-neutral-500">Loading the diff…</p>;
  if (state.status === "failed") {
    return (
      <p role="alert" className="px-3 py-1.5 text-[11px] text-rose-400">
        Could not show the diff: {state.error}
      </p>
    );
  }
  if (rows.length === 0) return <p className="px-3 py-1.5 text-[11px] text-neutral-500">No text changes.</p>;
  return (
    <div
      aria-label={`Diff of ${change.path}`}
      className="mx-1.5 mb-1.5 max-h-80 overflow-auto rounded-md border border-neutral-800 bg-[#0a0a0a] py-1 font-mono text-[11px] leading-5"
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
