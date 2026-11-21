import { AlertCircle, CheckCircle2, Info, X } from "lucide-react";
import { useApp, type ToastVariant } from "../../context/AppContext";
import { cx } from "../../lib/cx";

const VARIANT_STYLES: Record<ToastVariant, { icon: typeof Info; className: string; iconClassName: string }> = {
  success: {
    icon: CheckCircle2,
    className: "border-emerald-500/25 bg-emerald-950/90",
    iconClassName: "text-emerald-400",
  },
  error: {
    icon: AlertCircle,
    className: "border-red-500/30 bg-red-950/90",
    iconClassName: "text-red-400",
  },
  info: {
    icon: Info,
    className: "border-white/10 bg-ink-850/95",
    iconClassName: "text-accent-400",
  },
};

export function ToastViewport() {
  const { toasts, dismissToast } = useApp();
  return (
    <div
      role="region"
      aria-label="通知"
      aria-live="polite"
      aria-atomic="false"
      className="pointer-events-none fixed bottom-4 right-4 z-[70] flex w-[min(390px,calc(100vw-2rem))] flex-col gap-2"
    >
      {toasts.map((toast) => {
        const style = VARIANT_STYLES[toast.variant];
        const Icon = style.icon;
        return (
          <div
            key={toast.id}
            data-testid="toast"
            data-variant={toast.variant}
            role={toast.variant === "error" ? "alert" : "status"}
            className={cx(
              "pointer-events-auto flex items-start gap-3 rounded-xl border px-3.5 py-3 shadow-2xl backdrop-blur-md",
              style.className,
            )}
          >
            <Icon className={cx("mt-0.5 h-4 w-4 shrink-0", style.iconClassName)} aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium leading-snug text-ink-100">{toast.title}</p>
              {toast.description ? (
                <p className="mt-1 whitespace-pre-line text-xs leading-relaxed text-ink-300">{toast.description}</p>
              ) : null}
              {toast.code ? (
                <p className="mt-1 font-mono text-[10px] uppercase tracking-wide text-ink-500">{toast.code}</p>
              ) : null}
              {toast.action ? (
                <button
                  type="button"
                  className="mt-2 inline-flex items-center rounded-md border border-accent-500/40 bg-accent-500/10 px-2 py-1 text-xs font-medium text-accent-400 hover:bg-accent-500/20"
                  onClick={() => {
                    toast.action?.onClick();
                    dismissToast(toast.id);
                  }}
                >
                  {toast.action.label}
                </button>
              ) : null}
            </div>
            <button
              type="button"
              aria-label="关闭通知"
              className="mt-0.5 rounded p-1 text-ink-400 hover:bg-white/10 hover:text-ink-100"
              onClick={() => dismissToast(toast.id)}
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
