import type { ReactNode } from "react";

type Variant = "primary" | "outline" | "ghost";
type Size = "sm" | "lg";

interface ButtonLinkProps {
  href: string;
  variant: Variant;
  size?: Size;
  children: ReactNode;
}

const VARIANTS: Record<Variant, string> = {
  primary: "border-transparent bg-primary text-on-primary hover:bg-primary-hover",
  outline: "border-border-strong text-fg-secondary hover:bg-surface-hover hover:text-fg",
  ghost: "border-transparent text-fg-muted hover:bg-surface-hover hover:text-fg",
};

// lg is 44px tall, a comfortable touch target for the page's main actions.
const SIZES: Record<Size, string> = {
  sm: "px-3 py-2 text-[13px] leading-4",
  lg: "min-h-11 gap-2 px-[18px] py-[11px] text-sm leading-5",
};

/** A link styled as the design system's button: the app's Button, for navigation instead of actions. */
export function ButtonLink({ href, variant, size = "sm", children }: ButtonLinkProps) {
  return (
    <a
      href={href}
      className={`focus-ring inline-flex items-center justify-center gap-1.5 rounded-lg border font-medium no-underline transition-colors duration-150 ${VARIANTS[variant]} ${SIZES[size]}`}
    >
      {children}
    </a>
  );
}
