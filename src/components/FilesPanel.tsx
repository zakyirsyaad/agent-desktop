import { useMemo, useState } from "react";
import {
  ChevronRight,
  File,
  Folder,
  FolderOpen,
  FolderSearch,
  Plus,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { useFileTree, type FileTree } from "../hooks/useFileTree";
import {
  errorMessage,
  filterVisiblePaths,
  joinWorkspacePath,
  openWorkspacePath,
  ROOT_FOLDER,
  type DirEntryInfo,
} from "../lib/files";

export interface FilesPanelProps {
  /** Absolute path of the workspace folder the tree shows. */
  rootPath: string;
  /** Display name of that folder, e.g. its last path segment. */
  rootName: string;
  onClose: () => void;
  /** Adds a file's absolute path to the composer; row buttons are hidden when absent. */
  onInsertPath?: (absolutePath: string) => void;
  /** Reveals the workspace folder in Finder; the header button is hidden when absent. */
  onRevealRoot?: () => void;
}

const BASE_INDENT_PX = 8;
const INDENT_STEP_PX = 12;
const HEADER_BUTTON =
  "rounded p-1 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200 focus:outline-none focus:ring-1 focus:ring-neutral-700";
const ROW =
  "group flex items-center rounded-md text-neutral-400 hover:bg-neutral-900/60 hover:text-neutral-200";
const NOTE = "py-1 pr-2 text-[11px]";

interface TreeView {
  tree: FileTree;
  /** Paths kept by the filter, or null when no filter is active. */
  visible: Set<string> | null;
  rootPath: string;
  onOpenFile: (entry: DirEntryInfo) => void;
  onInsertPath?: (absolutePath: string) => void;
}

function indent(depth: number): { paddingLeft: number } {
  return { paddingLeft: BASE_INDENT_PX + depth * INDENT_STEP_PX };
}

function hasVisibleDescendant(visible: Set<string>, folder: string): boolean {
  const prefix = `${folder}/`;
  return [...visible].some((path) => path.startsWith(prefix));
}

function FolderRow({ entry, depth, view }: { entry: DirEntryInfo; depth: number; view: TreeView }) {
  const path = entry.relativePath;
  const expanded = view.visible ? hasVisibleDescendant(view.visible, path) : view.tree.isExpanded(path);
  const Icon = expanded ? FolderOpen : Folder;
  return (
    <li role="treeitem" aria-label={entry.name} aria-expanded={expanded}>
      <div className={ROW}>
        <button
          type="button"
          onClick={() => view.tree.toggleFolder(path)}
          title={path}
          style={indent(depth)}
          className="flex min-w-0 flex-1 items-center gap-1.5 py-1 pr-2 text-left focus:outline-none focus:ring-1 focus:ring-neutral-700"
        >
          <ChevronRight
            size={12}
            aria-hidden="true"
            className={`shrink-0 text-neutral-600 transition-transform ${expanded ? "rotate-90" : ""}`}
          />
          <Icon size={13} aria-hidden="true" className="shrink-0 text-neutral-500" />
          <span className="truncate">{entry.name}</span>
        </button>
      </div>
      {expanded && (
        <ul role="group">
          <FolderChildren folder={path} depth={depth + 1} view={view} />
        </ul>
      )}
    </li>
  );
}

function FileRow({ entry, depth, view }: { entry: DirEntryInfo; depth: number; view: TreeView }) {
  const { onInsertPath } = view;
  return (
    <li role="treeitem" aria-label={entry.name}>
      <div className={ROW}>
        <button
          type="button"
          onClick={() => view.onOpenFile(entry)}
          title={`Open ${entry.relativePath}`}
          // Files line up with folder names, past the folder chevron.
          style={indent(depth + 1)}
          className="flex min-w-0 flex-1 items-center gap-1.5 py-1 pr-2 text-left focus:outline-none focus:ring-1 focus:ring-neutral-700"
        >
          <File size={13} aria-hidden="true" className="shrink-0 text-neutral-500" />
          <span className="truncate">{entry.name}</span>
        </button>
        {onInsertPath && (
          <button
            type="button"
            aria-label={`Add ${entry.name} to prompt`}
            title="Add to prompt"
            onClick={() => onInsertPath(joinWorkspacePath(view.rootPath, entry.relativePath))}
            className="mr-1 rounded p-1 text-neutral-500 opacity-0 group-hover:opacity-100 focus:opacity-100 hover:text-amber-300 focus:outline-none focus:ring-1 focus:ring-neutral-600"
          >
            <Plus size={12} aria-hidden="true" />
          </button>
        )}
      </div>
    </li>
  );
}

function FolderChildren({ folder, depth, view }: { folder: string; depth: number; view: TreeView }) {
  const { tree, visible } = view;
  const error = tree.errors[folder];
  const entries = tree.children[folder];

  if (error) {
    return (
      <li role="none">
        <p role="alert" style={indent(depth + 1)} className={`${NOTE} text-red-400`}>
          {error}
        </p>
      </li>
    );
  }
  if (!entries) {
    return tree.isLoading(folder) && !visible ? (
      <li role="none" style={indent(depth + 1)} className={`${NOTE} text-neutral-600`}>
        Loading…
      </li>
    ) : null;
  }
  if (entries.length === 0 && !visible) {
    return (
      <li role="none" style={indent(depth + 1)} className={`${NOTE} text-neutral-600`}>
        Empty folder
      </li>
    );
  }

  const shown = visible ? entries.filter((entry) => visible.has(entry.relativePath)) : entries;
  return (
    <>
      {shown.map((entry) =>
        entry.isDir ? (
          <FolderRow key={entry.relativePath} entry={entry} depth={depth} view={view} />
        ) : (
          <FileRow key={entry.relativePath} entry={entry} depth={depth} view={view} />
        )
      )}
    </>
  );
}

interface PanelHeaderProps {
  rootName: string;
  rootPath: string;
  query: string;
  onQueryChange: (query: string) => void;
  onRefresh: () => void;
  onRevealRoot?: () => void;
  onClose: () => void;
}

function PanelHeader({ rootName, rootPath, query, onQueryChange, onRefresh, onRevealRoot, onClose }: PanelHeaderProps) {
  return (
    <div className="flex flex-col gap-2 border-b border-neutral-800/60 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-baseline gap-2">
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-neutral-500">Files</h2>
          <span title={rootPath} className="truncate font-mono text-[11px] text-neutral-400">
            {rootName}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <button type="button" onClick={onRefresh} aria-label="Refresh files" title="Refresh" className={HEADER_BUTTON}>
            <RefreshCw size={13} aria-hidden="true" />
          </button>
          {onRevealRoot && (
            <button type="button" onClick={onRevealRoot} aria-label="Reveal in Finder" title="Reveal in Finder" className={HEADER_BUTTON}>
              <FolderSearch size={13} aria-hidden="true" />
            </button>
          )}
          <button type="button" onClick={onClose} aria-label="Close files panel" title="Close" className={HEADER_BUTTON}>
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      </div>
      <div className="relative">
        <Search
          size={13}
          aria-hidden="true"
          className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-neutral-500"
        />
        <input
          type="text"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder="Filter files"
          aria-label="Filter files"
          className="w-full rounded-md border border-neutral-800/80 bg-neutral-900/90 py-1.5 pl-8 pr-3 text-xs text-neutral-200 placeholder-neutral-500 outline-none focus:border-neutral-700 focus:ring-1 focus:ring-neutral-700"
        />
      </div>
    </div>
  );
}

/** Right-hand panel with a lazily loaded tree of the workspace folder. */
export function FilesPanel({ rootPath, rootName, onClose, onInsertPath, onRevealRoot }: FilesPanelProps) {
  const tree = useFileTree(rootPath);
  const [query, setQuery] = useState("");
  const [openError, setOpenError] = useState<string | null>(null);
  const visible = useMemo(() => filterVisiblePaths(tree.children, query), [tree.children, query]);

  const handleOpenFile = (entry: DirEntryInfo) => {
    setOpenError(null);
    openWorkspacePath(rootPath, entry.relativePath).catch((error: unknown) => {
      setOpenError(`Couldn't open ${entry.name}: ${errorMessage(error)}`);
    });
  };

  const view: TreeView = { tree, visible, rootPath, onOpenFile: handleOpenFile, onInsertPath };

  return (
    <aside
      aria-label="Files panel"
      className="flex h-full w-72 shrink-0 flex-col border-l border-neutral-800/80 bg-[#0d0d0d] text-xs text-neutral-300 select-none"
    >
      <PanelHeader
        rootName={rootName}
        rootPath={rootPath}
        query={query}
        onQueryChange={setQuery}
        onRefresh={tree.refresh}
        onRevealRoot={onRevealRoot}
        onClose={onClose}
      />
      {openError && (
        <p role="alert" className="border-b border-neutral-800/60 px-3 py-1.5 text-[11px] text-red-400">
          {openError}
        </p>
      )}
      <div className="flex-1 overflow-y-auto p-1.5">
        <ul role="tree" aria-label={`Files in ${rootName}`}>
          <FolderChildren folder={ROOT_FOLDER} depth={0} view={view} />
        </ul>
        {visible?.size === 0 && (
          <p className="px-2 py-1 text-[11px] text-neutral-500">No loaded files match “{query.trim()}”.</p>
        )}
      </div>
    </aside>
  );
}
