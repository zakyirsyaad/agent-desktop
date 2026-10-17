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
      className="absolute bottom-full left-0 mb-2 max-h-64 w-full overflow-y-auto rounded-lg border border-neutral-800 bg-[#121212] p-1 shadow-2xl"
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
            index === highlighted ? "bg-neutral-800 text-neutral-100" : "text-neutral-300 hover:bg-neutral-900"
          }`}
        >
          <span className="shrink-0 font-mono text-amber-400">/{command.name}</span>
          <span className="truncate text-neutral-500">{command.description}</span>
        </li>
      ))}
    </ul>
  );
}
