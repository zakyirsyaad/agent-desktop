export interface MentionMenuProps {
  /** Paths relative to the workspace. */
  files: string[];
  highlighted: number;
  onPick: (path: string) => void;
}

/** Workspace files matching what follows the `@`, above the prompt. */
export function MentionMenu({ files, highlighted, onPick }: MentionMenuProps) {
  return (
    <ul
      role="listbox"
      aria-label="Files to mention"
      className="absolute bottom-full left-0 mb-2 max-h-64 w-full overflow-y-auto rounded-lg border border-border bg-surface-3 p-1 shadow-popover"
    >
      {files.map((path, index) => {
        const slash = path.lastIndexOf("/");
        return (
          <li
            key={path}
            role="option"
            aria-selected={index === highlighted}
            data-file={path}
            title={path}
            // mousedown, not click: the prompt must keep focus.
            onMouseDown={(e) => {
              e.preventDefault();
              onPick(path);
            }}
            className={`flex cursor-pointer items-baseline gap-2 rounded-md px-2.5 py-1.5 text-xs ${
              index === highlighted ? "bg-surface-hover text-fg" : "text-fg-secondary hover:bg-surface-hover"
            }`}
          >
            <span className="shrink-0 font-mono text-fg-muted">{path.slice(slash + 1)}</span>
            {slash > 0 && <span className="truncate text-fg-muted">{path.slice(0, slash)}</span>}
          </li>
        );
      })}
    </ul>
  );
}
