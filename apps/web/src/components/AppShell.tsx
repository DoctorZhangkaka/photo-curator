import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import { Aperture, History, Images, ShieldAlert } from "lucide-react";
import { cx } from "../lib/cx";

const NAV_ITEMS = [
  { to: "/", label: "相册库", icon: Images, end: true },
  { to: "/operations", label: "操作记录", icon: History, end: false },
  { to: "/issues", label: "异常中心", icon: ShieldAlert, end: false },
];

export function AppShell() {
  const location = useLocation();
  return (
    <div className="flex min-h-full flex-col bg-ink-950 text-ink-100">
      <header className="sticky top-0 z-40 border-b border-white/[0.07] bg-ink-950/92 backdrop-blur-xl">
        <div className="mx-auto flex h-12 w-full max-w-[1680px] items-center gap-4 px-3 sm:gap-6 sm:px-6">
          <Link
            to="/"
            className="group flex shrink-0 items-center gap-2.5 rounded-md px-1 py-1 focus-visible:outline focus-visible:outline-[1.5px] focus-visible:outline-offset-4 focus-visible:outline-accent-400"
            aria-label="相册精选助手首页"
          >
            <span className="relative flex h-7 w-7 items-center justify-center rounded-md border border-accent-500/35 bg-gradient-to-b from-accent-500/15 to-accent-500/[0.04] shadow-[inset_0_1px_0_rgba(241,205,120,0.2)] transition-colors group-hover:border-accent-400/50">
              <Aperture className="h-3.5 w-3.5 text-accent-400 transition-transform duration-500 group-hover:rotate-45" aria-hidden="true" />
            </span>
            <div className="flex items-baseline gap-2">
              <span className="text-[13px] font-semibold tracking-[-0.015em] text-ink-100">相册精选助手</span>
              <span className="hidden font-mono text-[9px] font-medium uppercase tracking-[0.18em] text-ink-500 sm:inline">
                暗房
              </span>
            </div>
          </Link>

          <span className="hidden h-4 w-px bg-white/[0.08] sm:block" aria-hidden="true" />

          <nav aria-label="主导航" className="flex h-full items-center gap-1 overflow-x-auto">
            {NAV_ITEMS.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  cx(
                    "relative inline-flex h-full shrink-0 items-center gap-1.5 px-3 text-xs font-medium transition-colors",
                    isActive ? "text-ink-100" : "text-ink-400 hover:text-ink-200",
                  )
                }
              >
                {({ isActive }) => (
                  <>
                    <item.icon
                      className={cx("h-3.5 w-3.5 transition-colors", isActive ? "text-accent-400" : "text-ink-500")}
                      aria-hidden="true"
                    />
                    <span>{item.label}</span>
                    {isActive ? (
                      <span
                        aria-hidden="true"
                        className="absolute inset-x-2 bottom-0 h-[2px] rounded-t-full bg-accent-400 shadow-[0_0_8px_rgba(232,182,77,0.55)]"
                      />
                    ) : null}
                  </>
                )}
              </NavLink>
            ))}
          </nav>

          <div className="ml-auto hidden items-center gap-2 rounded-md border border-white/[0.07] bg-ink-900/90 px-2.5 py-1 font-mono text-[10px] tracking-[0.04em] text-ink-400 sm:flex">
            <span
              className="h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.75)]"
              aria-hidden="true"
            />
            <span>本地运行</span>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1680px] flex-1 px-3 py-6 sm:px-6 sm:py-8">
        <Outlet />
      </main>

      <footer className="mx-auto flex w-full max-w-[1680px] flex-wrap items-center justify-between gap-2 border-t border-white/[0.05] px-3 py-4 text-[10px] text-ink-500 sm:px-6">
        <span className="flex items-center gap-2">
          <span className="inline-block h-1 w-1 rounded-full bg-ink-600" aria-hidden="true" />
          本地单用户 · 照片仅在本地处理，不会上传至第三方服务
        </span>
        <span className="font-mono uppercase tracking-[0.08em] text-ink-600">
          {location.pathname === "/" ? "相册库" : location.pathname}
        </span>
      </footer>
    </div>
  );
}
