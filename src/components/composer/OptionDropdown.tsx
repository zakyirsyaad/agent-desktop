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

/**
 * What the chip shows: a label without a leading "[Provider]" tag (Qwen
 * Code's model names carry one), so the narrow chip shows the model itself.
 */
function chipLabelOf(label: string): string {
  return label.replace(/^\[[^\]]*\]\s*/, "") || label;
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
        title={disabled ? disabledTitle : valueLabel}
        className="flex items-center gap-1.5 whitespace-nowrap rounded-lg px-2 py-1 text-xs text-fg-secondary hover:bg-surface-hover hover:text-fg transition-colors cursor-pointer border border-border focus-ring disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
      >
        {icon}
        <span className="max-w-[140px] truncate">{chipLabelOf(valueLabel)}</span>
        <ChevronDown size={11} className="text-fg-subtle" />
      </button>

      {isOpen && !disabled && (
        <div
          role="listbox"
          aria-label={label}
          className={`absolute bottom-full mb-2 min-w-40 rounded-lg border border-border bg-surface-3 p-1 shadow-popover z-50 ${
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
                    ? "bg-surface-hover text-fg font-medium"
                    : "text-fg-secondary hover:bg-surface-hover hover:text-fg"
                }`}
              >
                <span className="truncate">{option.label}</span>
                {isSelected && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-fg" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
