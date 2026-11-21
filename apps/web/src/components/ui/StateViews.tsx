import type { ComponentType, ReactNode } from "react";
import { AlertCircle, FolderSearch, Loader2, RefreshCw } from "lucide-react";
import { describeError } from "../../lib/messages";
import { cx } from "../../lib/cx";
import { Button } from "./Button";

export function Spinner({ className, label = "加载中" }: { className?: string; label?: string }) {
  return (
    <span role="status" className={cx("inline-flex items-center gap-2 text-ink-400", className)}>
      <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
      <span className="text-xs">{label}</span>
    </span>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      className={cx("animate-pulse rounded-md bg-white/[0.055] motion-reduce:animate-none", className)}
      aria-hidden="true"
    />
  );
}

interface EmptyStateProps {
  icon?: ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" | "false" }>;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ icon: Icon = FolderSearch, title, description, action, className }: EmptyStateProps) {
  return (
    <div
      className={cx(
        "flex flex-col items-center justify-center rounded-xl border border-dashed border-white/10 px-6 py-12 text-center",
        className,
      )}
    >
      <span className="mb-3 flex h-11 w-11 items-center justify-center rounded-full border border-white/10 bg-white/[0.03]">
        <Icon className="h-5 w-5 text-ink-400" aria-hidden="true" />
      </span>
      <h3 className="text-sm font-semibold text-ink-200">{title}</h3>
      {description ? <div className="mt-1.5 max-w-md text-xs leading-relaxed text-ink-400">{description}</div> : null}
      {action ? <div className="mt-4 flex flex-wrap items-center justify-center gap-2">{action}</div> : null}
    </div>
  );
}

interface ErrorStateProps {
  error: unknown;
  title?: string;
  onRetry?: () => void;
  retryLabel?: string;
  className?: string;
  compact?: boolean;
}

export function ErrorState({
  error,
  title,
  onRetry,
  retryLabel = "重试",
  className,
  compact = false,
}: ErrorStateProps) {
  const friendly = describeError(error);
  return (
    <div
      role="alert"
      className={cx(
        "rounded-xl border border-red-500/25 bg-red-500/[0.06] px-4 py-4 text-left",
        compact ? "py-3" : "py-5",
        className,
      )}
    >
      <div className="flex items-start gap-3">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-red-200">{title ?? friendly.title}</p>
          <p className="mt-1 text-xs leading-relaxed text-ink-300">{friendly.description}</p>
          {friendly.code ? (
            <p className="mt-1 font-mono text-[10px] uppercase tracking-wide text-ink-500">{friendly.code}</p>
          ) : null}
          {onRetry ? (
            <Button
              variant="secondary"
              size="sm"
              icon={RefreshCw}
              className="mt-3"
              onClick={onRetry}
            >
              {retryLabel}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function InlineSpinner({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-ink-400" role="status">
      <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
      {label}
    </span>
  );
}
