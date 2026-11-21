import { Aperture, RefreshCw, ServerOff, Terminal } from "lucide-react";
import { Button } from "./ui/Button";

interface BackendUnavailableProps {
  error: unknown;
  onRetry: () => void;
  retrying: boolean;
}

export function BackendUnavailable({ error, onRetry, retrying }: BackendUnavailableProps) {
  const message = error instanceof Error ? error.message : String(error ?? "未知错误");
  return (
    <div className="flex min-h-full items-center justify-center bg-ink-950 px-4 py-12">
      <div className="w-full max-w-lg rounded-2xl border border-white/10 bg-ink-900 p-6 shadow-2xl">
        <div className="flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg border border-accent-500/30 bg-accent-500/10">
            <Aperture className="h-5 w-5 text-accent-400" aria-hidden="true" />
          </span>
          <div>
            <p className="text-sm font-semibold text-ink-100">相册精选助手</p>
            <p className="text-[10px] uppercase tracking-wide text-ink-500">本地照片筛选工具</p>
          </div>
        </div>

        <div className="mt-6 flex items-start gap-3">
          <ServerOff className="mt-0.5 h-6 w-6 shrink-0 text-red-400" aria-hidden="true" />
          <div>
            <h1 className="text-lg font-semibold tracking-tight text-ink-100">无法连接到本地服务</h1>
            <p className="mt-1.5 text-xs leading-relaxed text-ink-400">
              页面没有收到后端的会话响应。请确认本地服务仍在运行，然后在项目根目录执行下面的命令：
            </p>
          </div>
        </div>

        <div className="mt-4 flex items-center gap-2 rounded-lg border border-white/10 bg-ink-950 px-3 py-2">
          <Terminal className="h-3.5 w-3.5 shrink-0 text-ink-500" aria-hidden="true" />
          <code className="font-mono text-xs text-ink-200">npm run dev</code>
        </div>
        <p className="mt-2 text-[10px] leading-relaxed text-ink-500">
          默认前端地址 http://127.0.0.1:7100，API 地址 http://127.0.0.1:8765。如果刚刚启动，请稍等几秒再重试。
        </p>

        <div className="mt-5 flex flex-wrap items-center gap-2">
          <Button variant="primary" icon={RefreshCw} loading={retrying} onClick={onRetry}>
            重新连接
          </Button>
          <Button variant="ghost" onClick={() => window.location.reload()}>
            刷新页面
          </Button>
        </div>

        <details className="mt-5 rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-[11px] text-ink-400">
          <summary className="cursor-pointer select-none text-ink-300">技术详情</summary>
          <p className="mt-2 break-words font-mono text-[10px] leading-relaxed text-ink-500">{message}</p>
          <p className="mt-1 text-[10px] leading-relaxed text-ink-500">
            如果是生产构建，请先运行 npm run build，并确认后端能读取 apps/web/dist。
          </p>
        </details>

        <p className="mt-4 text-[10px] leading-relaxed text-ink-600">
          本应用只监听本机回环地址；不会访问外网，也不会上传照片。
        </p>
      </div>
    </div>
  );
}
