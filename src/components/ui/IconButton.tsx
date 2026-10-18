import type { ButtonHTMLAttributes, ReactNode, Ref } from "react";

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  variant?: "ghost" | "primary";
  children: ReactNode;
  ref?: Ref<HTMLButtonElement>;
}

const BASE =
  "inline-flex h-7 w-7 items-center justify-center transition-colors " +
  "focus-ring " +
  "disabled:cursor-not-allowed disabled:opacity-40";

const VARIANTS: Record<NonNullable<IconButtonProps["variant"]>, string> = {
  ghost: "rounded-md text-fg-muted enabled:hover:bg-surface-hover enabled:hover:text-fg",
  primary: "rounded-lg bg-primary text-on-primary enabled:hover:bg-primary-hover",
};

export function IconButton({
  label,
  variant = "ghost",
  className,
  type = "button",
  children,
  ...rest
}: IconButtonProps) {
  const classes = [BASE, VARIANTS[variant], className].filter(Boolean).join(" ");
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      className={classes}
      {...rest}
    >
      {children}
    </button>
  );
}
