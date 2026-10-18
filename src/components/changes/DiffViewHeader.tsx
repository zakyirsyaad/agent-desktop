import { useRef, useState } from "react";
import { ChevronDown, Maximize2, Minimize2, MoreHorizontal, Search, X } from "lucide-react";
import { IconButton } from "../ui/IconButton";
import { useDismiss } from "../../hooks/useDismiss";
import { targetLabel, type DiffTargetId, type DiffTargets } from "../../lib/diff-stats";

const POPOVER = "absolute top-full mt-1 rounded-lg border border-border bg-surface-3 p-1 shadow-popover z-50";
const POPOVER_ITEM =
  "flex w-full items-center justify-between gap-3 rounded px-2.5 py-1.5 text-left text-xs transition-colors cursor-pointer";

function TargetPicker({ target, targets, onSelect }: {
  target: DiffTargetId;
  targets: DiffTargets;
  onSelect: (target: DiffTargetId) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, isOpen, () => setIsOpen(false));
  const label = targetLabel(target, targets);

  // Without a base branch there is nothing to choose between.
  if (!targets.base) return <span className="truncate text-xs font-medium text-fg">{label}</span>;

  const options: DiffTargetId[] = ["base", "head"];
  return (
    <div ref={ref} className="relative min-w-0">
      <button
        type="button"
        aria-label={`Diff target: ${label}`}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        onClick={() => setIsOpen((open) => !open)}
        className="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-xs font-medium text-fg hover:bg-surface-hover cursor-pointer focus-ring"
      >
        <span className="truncate">{label}</span>
        <ChevronDown size={11} aria-hidden="true" className="shrink-0 text-fg-subtle" />
      </button>
      {isOpen && (
        <div role="listbox" aria-label="Diff target" className={`${POPOVER} left-0 min-w-48`}>
          {options.map((option) => (
            <button
              key={option}
              type="button"
              role="option"
              aria-selected={option === target}
              onClick={() => {
                onSelect(option);
                setIsOpen(false);
              }}
              className={`${POPOVER_ITEM} ${
                option === target ? "bg-surface-hover text-fg font-medium" : "text-fg-secondary hover:bg-surface-hover hover:text-fg"
              }`}
            >
              <span className="truncate">{targetLabel(option, targets)}</span>
              {option === target && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-fg" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function MoreMenu({ onCollapseAll, onExpandAll, onRefresh }: {
  onCollapseAll: () => void;
  onExpandAll: () => void;
  onRefresh: () => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, isOpen, () => setIsOpen(false));
  const items = [
    { label: "Collapse all", run: onCollapseAll },
    { label: "Expand all", run: onExpandAll },
    { label: "Refresh", run: onRefresh },
  ];
  return (
    <div ref={ref} className="relative">
      <IconButton label="More actions" aria-haspopup="menu" aria-expanded={isOpen} onClick={() => setIsOpen((open) => !open)}>
        <MoreHorizontal size={14} />
      </IconButton>
      {isOpen && (
        <div role="menu" aria-label="More actions" className={`${POPOVER} right-0 min-w-36`}>
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              onClick={() => {
                item.run();
                setIsOpen(false);
              }}
              className={`${POPOVER_ITEM} text-fg-secondary hover:bg-surface-hover hover:text-fg`}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export interface DiffViewHeaderProps {
  target: DiffTargetId;
  targets: DiffTargets;
  onTargetChange: (target: DiffTargetId) => void;
  isSearching: boolean;
  onToggleSearch: () => void;
  search: string;
  onSearchChange: (search: string) => void;
  onCollapseAll: () => void;
  onExpandAll: () => void;
  onRefresh: () => void;
  isExpanded: boolean;
  onToggleExpanded: () => void;
  onClose: () => void;
}

/** The diff view's title bar: what is compared, plus search, section controls, expand and close. */
export function DiffViewHeader(props: DiffViewHeaderProps) {
  const { isExpanded, isSearching, search } = props;
  return (
    <header className="shrink-0 border-b border-border">
      <div className="flex h-10 items-center gap-1 px-2">
        <div className="min-w-0 flex-1">
          <TargetPicker target={props.target} targets={props.targets} onSelect={props.onTargetChange} />
        </div>
        <IconButton label="Search files" aria-pressed={isSearching} onClick={props.onToggleSearch}>
          <Search size={14} />
        </IconButton>
        <MoreMenu onCollapseAll={props.onCollapseAll} onExpandAll={props.onExpandAll} onRefresh={props.onRefresh} />
        <IconButton label={isExpanded ? "Shrink diff view" : "Expand diff view"} onClick={props.onToggleExpanded}>
          {isExpanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        </IconButton>
        <IconButton label="Close diff view" onClick={props.onClose}>
          <X size={14} />
        </IconButton>
      </div>
      {isSearching && (
        <div className="px-2 pb-2">
          <input
            type="text"
            autoFocus
            value={search}
            onChange={(e) => props.onSearchChange(e.target.value)}
            placeholder="Filter files"
            aria-label="Filter files"
            className="w-full rounded-md border border-border bg-surface-2 px-2 py-1 text-xs text-fg placeholder:text-fg-subtle focus-ring"
          />
        </div>
      )}
    </header>
  );
}
