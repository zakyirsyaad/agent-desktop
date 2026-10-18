import type { ButtonHTMLAttributes, ReactNode, Ref } from "react";

export type ButtonVariant = "primary" | "outline" | "ghost" | "danger";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  icon?: ReactNode;
  ref?: Ref<HTMLButtonElement>;
}

const BASE =
  "inline-flex items-center justify-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors " +
  "focus-ring disabled:cursor-not-allowed";

// A faded primary fill still reads as a light, pressable button, so a disabled
// primary turns into a flat neutral one instead of dimming.
const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "border-transparent bg-primary text-on-primary enabled:hover:bg-primary-hover " +
    "disabled:bg-surface-hover disabled:text-fg-subtle",
  outline:
    "border-border-strong text-fg-secondary enabled:hover:bg-surface-hover enabled:hover:text-fg disabled:opacity-40",
  ghost:
    "border-transparent text-fg-muted enabled:hover:bg-surface-hover enabled:hover:text-fg disabled:opacity-40",
  danger: "border-transparent bg-danger-surface text-danger disabled:opacity-40",
};

export function Button({
  variant = "outline",
  icon,
  className,
  type = "button",
  children,
  ...rest
}: ButtonProps) {
  const classes = [BASE, VARIANTS[variant], className].filter(Boolean).join(" ");
  return (
    <button type={type} className={classes} {...rest}>
      {icon}
      {children}
    </button>
  );
}
