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
    <div className="flex min-h-full flex-col bg-ink-950">
      <header className="sticky top-0 z-40 border-b border-white/[0.06] bg-ink-950/90 backdrop-blur-md">
        <div className="mx-auto flex h-14 w-full max-w-[1680px] items-center gap-3 px-3 sm:gap-5 sm:px-6">
          <Link
            to="/"
            className="group flex shrink-0 items-center gap-2 rounded-lg px-1 py-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent-400"
            aria-label="相册精选助手首页"
          >
            <span className="flex h-7 w-7 items-center justify-center rounded-md border border-accent-500/30 bg-accent-500/10">
              <Aperture className="h-4 w-4 text-accent-400" aria-hidden="true" />
            </span>
            <span className="text-sm font-semibold tracking-tight text-ink-100">相册精选助手</span>
            <span className="hidden rounded border border-white/10 px-1 py-0.5 text-[9px] uppercase tracking-wider text-ink-500 sm:inline">
              本地
            </span>
          </Link>

          <nav aria-label="主导航" className="flex items-center gap-0.5 overflow-x-auto">
            {NAV_ITEMS.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  cx(
                    "inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors",
                    isActive
                      ? "bg-white/[0.07] text-ink-100"
                      : "text-ink-400 hover:bg-white/[0.04] hover:text-ink-200",
                  )
                }
              >
                <item.icon className="h-3.5 w-3.5" aria-hidden="true" />
                {item.label}
              </NavLink>
            ))}
          </nav>

          <div className="ml-auto hidden items-center gap-1.5 text-[10px] text-ink-500 sm:flex">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400/80" aria-hidden="true" />
            本地运行
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1680px] flex-1 px-3 py-5 sm:px-6 sm:py-7">
        <Outlet />
      </main>

      <footer className="mx-auto flex w-full max-w-[1680px] flex-wrap items-center justify-between gap-2 px-3 pb-5 text-[10px] text-ink-600 sm:px-6">
        <span>本地单用户 · 照片不会上传到第三方服务</span>
        <span className="font-mono">{location.pathname === "/" ? "相册库" : location.pathname}</span>
      </footer>
    </div>
  );
}
