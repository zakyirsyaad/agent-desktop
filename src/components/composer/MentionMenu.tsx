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
      className="absolute bottom-full left-0 mb-2 max-h-64 w-full overflow-y-auto rounded-lg border border-neutral-800 bg-[#121212] p-1 shadow-2xl"
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
              index === highlighted ? "bg-neutral-800 text-neutral-100" : "text-neutral-300 hover:bg-neutral-900"
            }`}
          >
            <span className="shrink-0 font-mono text-amber-400">{path.slice(slash + 1)}</span>
            {slash > 0 && <span className="truncate text-neutral-500">{path.slice(0, slash)}</span>}
          </li>
        );
      })}
    </ul>
  );
}
