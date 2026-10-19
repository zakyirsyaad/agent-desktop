import type { ReactNode } from "react";

interface ChipProps {
  children: ReactNode;
  /** Mono and a tighter radius, for paths, branches and commands. */
  isCode?: boolean;
}

export function Chip({ children, isCode = false }: ChipProps) {
  const look = isCode
    ? "rounded-sm font-mono text-fg-muted"
    : "rounded-md font-sans text-fg-secondary";
  return (
    <span
      className={`inline-flex items-center gap-1 border border-border bg-surface-2 px-2 py-0.5 text-[11px] leading-4 ${look}`}
    >
      {children}
    </span>
  );
}
