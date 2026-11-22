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
        <Loader2 className={cx("shrink-0 animate-spin", size === "sm" ? "h-3.5 w-3.5" : "h-3.5 w-3.5")} aria-hidden="true" />
      ) : Icon ? (
        <Icon className={cx("shrink-0", size === "sm" ? "h-3.5 w-3.5" : "h-3.5 w-3.5")} aria-hidden="true" />
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
        "inline-flex shrink-0 items-center justify-center rounded-md border transition-all duration-150",
        "focus-visible:outline focus-visible:outline-[1.5px] focus-visible:outline-offset-2 focus-visible:outline-accent-400",
        "active:translate-y-[0.5px] disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-35",
        size === "sm" ? "h-7 w-7" : "h-8 w-8",
        variant === "ghost" && "border-transparent text-ink-400 hover:bg-white/[0.06] hover:text-ink-100",
        variant === "secondary" &&
          "border-white/[0.09] bg-ink-800/90 text-ink-200 shadow-darkroom-control hover:border-white/[0.16] hover:bg-ink-700/90 hover:text-white",
        variant === "danger" &&
          "border-red-400/25 bg-red-500/[0.11] text-red-200 hover:border-red-400/40 hover:bg-red-500/20",
        active && "border-accent-500/45 bg-accent-500/15 text-accent-300 shadow-[inset_0_1px_0_rgba(241,205,120,0.18)]",
        className,
      )}
      {...props}
    >
      <Icon className={size === "sm" ? "h-3.5 w-3.5" : "h-4 w-4"} aria-hidden="true" />
    </button>
  );
}
