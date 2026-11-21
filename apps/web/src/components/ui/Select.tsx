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
    <label className={cx("flex min-w-0 items-center gap-2", wrapperClassName)}>
      <span className={cx("shrink-0 text-[11px] font-medium text-ink-400", hideLabel && "sr-only")}>{label}</span>
      <span className="relative min-w-0">
        <select
          id={id}
          className={cx("field h-8 w-full min-w-[92px] appearance-none py-0 pl-2.5 pr-7 text-xs", className)}
          {...props}
        >
          {children}
        </select>
        <ChevronDown
          className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-400"
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
      <span className="text-[11px] font-medium text-ink-400">{label}</span>
      <input id={id} type="date" className={cx("field h-8 px-2.5 text-xs", className)} {...props} />
    </label>
  );
}
