import type { InputHTMLAttributes, SelectHTMLAttributes } from "react";
import { ChevronDown } from "lucide-react";
import { cx } from "../../lib/cx";

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label: string;
  hideLabel?: boolean;
  wrapperClassName?: string;
}

export function Select({ label, hideLabel = false, wrapperClassName, className, id, children, ...props }: SelectProps) {
  return (
    <label className={cx("flex min-w-0 items-center gap-1.5", wrapperClassName)}>
      <span
        className={cx(
          "shrink-0 text-[10px] font-medium uppercase tracking-[0.08em] text-ink-500",
          hideLabel && "sr-only",
        )}
      >
        {label}
      </span>
      <span className="relative min-w-0">
        <select
          id={id}
          className={cx("field h-7 w-full min-w-[84px] appearance-none py-0 pl-2 pr-6 text-[11px] font-medium", className)}
          {...props}
        >
          {children}
        </select>
        <ChevronDown
          className="pointer-events-none absolute right-1.5 top-1/2 h-3 w-3 -translate-y-1/2 text-ink-500"
          aria-hidden="true"
        />
      </span>
    </label>
  );
}

interface DateInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  label: string;
}

export function DateInput({ label, className, id, ...props }: DateInputProps) {
  return (
    <label className="flex min-w-0 flex-col gap-1">
      <span className="text-[10px] font-medium uppercase tracking-[0.08em] text-ink-500">{label}</span>
      <input id={id} type="date" className={cx("field h-7 px-2 text-[11px]", className)} {...props} />
    </label>
  );
}
