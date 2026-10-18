import { useMemo, useState } from "react";
import { DiffFileSection } from "./DiffFileSection";
import { DiffViewHeader } from "./DiffViewHeader";
import { useDiffStats, useDiffTargets } from "../../hooks/useDiffStats";
import type { DiffTargetId } from "../../lib/diff-stats";

/** Above this many files the sections start collapsed, so a large diff does not read them all. */
const AUTO_OPEN_LIMIT = 25;

export interface DiffViewProps {
  rootPath: string;
  /** Goes up whenever the session's changes were read again. */
  version: number;
  isExpanded: boolean;
  onToggleExpanded: () => void;
  onClose: () => void;
  onError: (message: string) => void;
}

/** A whole repository's diff: one collapsible section per changed file. */
export function DiffView({ rootPath, version, isExpanded, onToggleExpanded, onClose, onError }: DiffViewProps) {
  const { targets, isLoaded: areTargetsLoaded } = useDiffTargets(rootPath, true, version, onError);
  const [chosen, setChosen] = useState<DiffTargetId | null>(null);
  // A chosen base means nothing once there is none (main checked out): HEAD then.
  const target: DiffTargetId = targets.base ? (chosen ?? "base") : "head";
  const { stats, reload } = useDiffStats(rootPath, areTargetsLoaded, target, version, onError);
  // Refresh reads every open diff again; otherwise a diff is read again only when its file changed.
  const [refreshes, setRefreshes] = useState(0);
  const refresh = () => {
    setRefreshes((n) => n + 1);
    reload();
  };
  const [isSearching, setIsSearching] = useState(false);
  const [search, setSearch] = useState("");
  // The first list read after switching to a target decides what starts open;
  // later reads of the same target keep the user's choices.
  const [opened, setOpened] = useState<{ target: DiffTargetId; paths: ReadonlySet<string> } | null>(null);
  if (stats && opened?.target !== target) {
    setOpened({ target, paths: new Set(stats.length > AUTO_OPEN_LIMIT ? [] : stats.map((s) => s.path)) });
  }
  const openPaths = opened?.target === target ? opened.paths : null;
  const setOpenPaths = (change: (prev: ReadonlySet<string>) => ReadonlySet<string>) =>
    setOpened((prev) => (prev ? { ...prev, paths: change(prev.paths) } : prev));

  const query = search.trim().toLowerCase();
  const visible = useMemo(
    () => (stats ?? []).filter((s) => s.path.toLowerCase().includes(query)),
    [stats, query],
  );

  const toggle = (path: string) =>
    setOpenPaths((prev) => {
      const next = new Set(prev);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  const toggleSearch = () => {
    if (isSearching) setSearch("");
    setIsSearching(!isSearching);
  };
  const from = target === "base" && targets.base ? targets.base.name : "HEAD";

  return (
    <aside
      aria-label="Diff view"
      className={`flex h-full flex-col border-l border-border bg-surface-1 ${isExpanded ? "flex-1" : "w-1/2 min-w-[480px] shrink-0"}`}
    >
      <DiffViewHeader
        target={target}
        targets={targets}
        onTargetChange={setChosen}
        isSearching={isSearching}
        onToggleSearch={toggleSearch}
        search={search}
        onSearchChange={setSearch}
        onCollapseAll={() => setOpenPaths(() => new Set())}
        onExpandAll={() => setOpenPaths(() => new Set((stats ?? []).map((s) => s.path)))}
        onRefresh={refresh}
        isExpanded={isExpanded}
        onToggleExpanded={onToggleExpanded}
        onClose={onClose}
      />
      <div className="min-h-0 flex-1 overflow-y-auto p-2 text-xs">
        {stats === null ? (
          <p className="px-2 py-3 text-fg-subtle">Reading the changes…</p>
        ) : stats.length === 0 ? (
          <p className="px-2 py-3 text-fg-subtle">No changes against {from}.</p>
        ) : visible.length === 0 ? (
          <p className="px-2 py-3 text-fg-subtle">No files match “{search.trim()}”.</p>
        ) : (
          visible.map((stat) => (
            <DiffFileSection
              key={stat.path}
              rootPath={rootPath}
              stat={stat}
              target={target}
              version={`${refreshes}:${stat.fingerprint}`}
              isOpen={openPaths?.has(stat.path) ?? false}
              onToggle={() => toggle(stat.path)}
            />
          ))
        )}
      </div>
    </aside>
  );
}
