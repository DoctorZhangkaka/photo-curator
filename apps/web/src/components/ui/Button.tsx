import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Loader2, type LucideIcon } from "lucide-react";
import { cx } from "../../lib/cx";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary: "btn-primary",
  secondary: "btn-secondary",
  ghost: "btn-ghost",
  danger: "btn-danger",
};

const SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: "btn-sm",
  md: "btn-md",
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: LucideIcon;
  loading?: boolean;
  children?: ReactNode;
}

export function Button({
  variant = "secondary",
  size = "md",
  icon: Icon,
  loading = false,
  className,
  children,
  disabled,
  type = "button",
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cx("btn", VARIANT_CLASSES[variant], SIZE_CLASSES[size], className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading ? (
        <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden="true" />
      ) : Icon ? (
        <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
      ) : null}
      {children}
    </button>
  );
}

interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label"> {
  label: string;
  icon: LucideIcon;
  variant?: "ghost" | "secondary" | "danger";
  active?: boolean;
  size?: "sm" | "md";
}

export function IconButton({
  label,
  icon: Icon,
  variant = "ghost",
  active,
  size = "md",
  className,
  type = "button",
  ...props
}: IconButtonProps) {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      aria-pressed={active === undefined ? undefined : active}
      className={cx(
        "inline-flex shrink-0 items-center justify-center rounded-lg border transition-colors",
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-400",
        "disabled:cursor-not-allowed disabled:opacity-40",
        size === "sm" ? "h-7 w-7" : "h-9 w-9",
        variant === "ghost" && "border-transparent text-ink-300 hover:bg-white/[0.07] hover:text-ink-100",
        variant === "secondary" && "border-white/10 bg-ink-800 text-ink-200 hover:bg-ink-700",
        variant === "danger" && "border-red-500/25 bg-red-500/10 text-red-200 hover:bg-red-500/20",
        active && "border-accent-500/40 bg-accent-500/10 text-accent-400",
        className,
      )}
      {...props}
    >
      <Icon className={size === "sm" ? "h-3.5 w-3.5" : "h-4 w-4"} aria-hidden="true" />
    </button>
  );
}
