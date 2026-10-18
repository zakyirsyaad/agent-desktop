import type { SlashCommand } from "../../types";

export interface SlashCommandMenuProps {
  commands: SlashCommand[];
  highlighted: number;
  onPick: (command: SlashCommand) => void;
}

/** The agent's commands matching what follows the `/`, above the prompt. */
export function SlashCommandMenu({ commands, highlighted, onPick }: SlashCommandMenuProps) {
  return (
    <ul
      role="listbox"
      aria-label="Slash commands"
      className="absolute bottom-full left-0 mb-2 max-h-64 w-full overflow-y-auto rounded-lg border border-border bg-surface-3 p-1 shadow-popover"
    >
      {commands.map((command, index) => (
        <li
          key={command.name}
          role="option"
          aria-selected={index === highlighted}
          data-command={command.name}
          // mousedown, not click: the prompt must keep focus.
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(command);
          }}
          className={`flex cursor-pointer items-baseline gap-3 rounded-md px-2.5 py-1.5 text-xs ${
            index === highlighted ? "bg-surface-hover text-fg" : "text-fg-secondary hover:bg-surface-hover"
          }`}
        >
          <span className="shrink-0 font-mono text-fg-muted">/{command.name}</span>
          <span className="truncate text-fg-muted">{command.description}</span>
        </li>
      ))}
    </ul>
  );
}
