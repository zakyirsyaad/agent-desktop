import type { ButtonHTMLAttributes, ReactNode, Ref } from "react";

export type ButtonVariant = "primary" | "outline" | "ghost" | "danger";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  icon?: ReactNode;
  ref?: Ref<HTMLButtonElement>;
}

const BASE =
  "inline-flex items-center justify-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors " +
  "focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1 focus-visible:outline-focus-ring " +
  "disabled:cursor-not-allowed disabled:opacity-40";

const VARIANTS: Record<ButtonVariant, string> = {
  primary: "border-transparent bg-primary text-on-primary enabled:hover:bg-primary-hover",
  outline:
    "border-border-strong text-fg-secondary enabled:hover:bg-surface-hover enabled:hover:text-fg",
  ghost: "border-transparent text-fg-muted enabled:hover:bg-surface-hover enabled:hover:text-fg",
  danger: "border-transparent bg-danger-surface text-danger",
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
