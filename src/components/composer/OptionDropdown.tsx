import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";

export interface DropdownOption {
  /** `undefined` means "agent default": no flag is passed. */
  value: string | undefined;
  label: string;
}

export interface OptionDropdownProps {
  /** Accessible name prefix, e.g. "Model" gives "Model: sonnet". */
  label: string;
  icon: ReactNode;
  options: readonly DropdownOption[];
  selected: string | undefined;
  isOpen: boolean;
  onToggle: () => void;
  onSelect: (value: string | undefined) => void;
  align?: "left" | "right";
  disabled?: boolean;
  disabledTitle?: string;
}

/** A compact composer dropdown listing only options the agent really supports. */
export function OptionDropdown({
  label,
  icon,
  options,
  selected,
  isOpen,
  onToggle,
  onSelect,
  align = "right",
  disabled = false,
  disabledTitle,
}: OptionDropdownProps) {
  const current = options.find((o) => o.value === selected) ?? options[0];
  const valueLabel = current?.label ?? "";

  return (
    <div className="relative">
      <button
        type="button"
        aria-label={`${label}: ${valueLabel}`}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        onClick={onToggle}
        disabled={disabled}
        title={disabled ? disabledTitle : undefined}
        className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-800 hover:text-neutral-100 transition-colors cursor-pointer border border-neutral-800/60 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent"
      >
        {icon}
        <span className="max-w-[120px] truncate">{valueLabel}</span>
        <ChevronDown size={11} className="text-neutral-500" />
      </button>

      {isOpen && !disabled && (
        <div
          role="listbox"
          aria-label={label}
          className={`absolute bottom-full mb-2 min-w-40 rounded-lg border border-neutral-800 bg-[#181818] p-1 shadow-2xl z-50 ${
            align === "left" ? "left-0" : "right-0"
          }`}
        >
          {options.map((option) => {
            const isSelected = option.value === current?.value;
            return (
              <button
                key={option.value ?? "__default"}
                type="button"
                role="option"
                aria-selected={isSelected}
                onClick={() => onSelect(option.value)}
                className={`flex w-full items-center justify-between gap-3 rounded px-2.5 py-1.5 text-xs text-left transition-colors cursor-pointer ${
                  isSelected
                    ? "bg-neutral-800 text-amber-400 font-medium"
                    : "text-neutral-300 hover:bg-neutral-800/60 hover:text-neutral-100"
                }`}
              >
                <span className="truncate">{option.label}</span>
                {isSelected && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
