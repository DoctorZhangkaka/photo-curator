import { useEffect, useState } from "react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { Aperture } from "lucide-react";
import { api, isApiError, setCsrfToken } from "./lib/api";
import { queryKeys } from "./lib/queryKeys";
import { AppProvider } from "./context/AppContext";
import { ToastViewport } from "./components/ui/Toasts";
import { BackendUnavailable } from "./components/BackendUnavailable";
import { AppShell } from "./components/AppShell";
import { ErrorBoundary } from "./components/ErrorBoundary";
import LibraryPage from "./pages/LibraryPage";
import CullerPage from "./pages/CullerPage";
import OperationsPage from "./pages/OperationsPage";
import IssuesPage from "./pages/IssuesPage";
import NotFoundPage from "./pages/NotFoundPage";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5_000,
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
      retry: (failureCount, error) => {
        if (isApiError(error) && error.status >= 400 && error.status < 500) return false;
        return failureCount < 2;
      },
    },
    mutations: { retry: false },
  },
});

function BootSplash() {
  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-4 bg-ink-950">
      <span className="flex h-12 w-12 items-center justify-center rounded-xl border border-accent-500/30 bg-accent-500/10">
        <Aperture className="h-6 w-6 text-accent-400" aria-hidden="true" />
      </span>
      <div className="text-center">
        <p className="text-sm font-semibold text-ink-200">相册精选助手</p>
        <p className="mt-1 text-[11px] text-ink-500">正在建立本地会话…</p>
      </div>
      <div className="h-1 w-32 overflow-hidden rounded-full bg-white/[0.06]">
        <div className="h-full w-1/2 animate-pulse rounded-full bg-accent-500/70 motion-reduce:animate-none" />
      </div>
    </div>
  );
}

function AppRoot() {
  const sessionQuery = useQuery({
    queryKey: queryKeys.session,
    queryFn: api.getSession,
    retry: 1,
    staleTime: Infinity,
    gcTime: Infinity,
    refetchOnWindowFocus: false,
  });
  const [tokenReady, setTokenReady] = useState(false);

  useEffect(() => {
    if (sessionQuery.data?.token) {
      setCsrfToken(sessionQuery.data.token);
      setTokenReady(true);
    }
  }, [sessionQuery.data?.token]);

  if (sessionQuery.isError) {
    return (
      <BackendUnavailable
        error={sessionQuery.error}
        retrying={sessionQuery.isFetching}
        onRetry={() => void sessionQuery.refetch()}
      />
    );
  }

  if (!sessionQuery.isSuccess || !tokenReady) return <BootSplash />;

  return (
    <AppProvider>
      <BrowserRouter>
        <Routes>
          <Route element={<AppShell />}>
            <Route index element={<LibraryPage />} />
            <Route path="operations" element={<OperationsPage />} />
            <Route path="issues" element={<IssuesPage />} />
            <Route path="*" element={<NotFoundPage />} />
          </Route>
          <Route path="/albums/:albumId" element={<CullerPage />} />
        </Routes>
        <ToastViewport />
      </BrowserRouter>
    </AppProvider>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <AppRoot />
      </QueryClientProvider>
    </ErrorBoundary>
  );
}
