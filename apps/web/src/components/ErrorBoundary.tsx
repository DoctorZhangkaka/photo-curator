import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertCircle } from "lucide-react";

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("相册精选助手界面错误", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex min-h-full items-center justify-center bg-ink-950 p-6">
          <div className="w-full max-w-lg rounded-2xl border border-red-500/25 bg-ink-900 p-6">
            <div className="flex items-start gap-3">
              <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-red-400" aria-hidden="true" />
              <div>
                <h1 className="text-base font-semibold text-ink-100">界面遇到意外错误</h1>
                <p className="mt-1 text-xs leading-relaxed text-ink-400">
                  没有文件操作会因界面错误自动执行。请刷新页面；若问题重复出现，请查看浏览器控制台和后端日志。
                </p>
                <pre className="mt-3 max-h-32 overflow-auto rounded-lg border border-white/10 bg-ink-950 p-2 font-mono text-[10px] leading-relaxed text-ink-400">
                  {this.state.error.message}
                </pre>
                <button
                  type="button"
                  onClick={() => window.location.reload()}
                  className="mt-4 inline-flex h-9 items-center rounded-lg bg-accent-500 px-3.5 text-sm font-medium text-ink-950 hover:bg-accent-400"
                >
                  刷新页面
                </button>
              </div>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
