import type { ReactNode } from "react";
import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { vi } from "vitest";
import { AppContext, type AppContextValue, type ToastItem } from "../context/AppContext";
import type { Settings } from "../lib/api";

export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity, staleTime: 0 },
      mutations: { retry: false },
    },
  });
}

export function makeTestAppValue(overrides: Partial<AppContextValue> = {}): AppContextValue {
  const settings: Settings = {
    defaultSort: "capture",
    autoplayInterval: 3,
    cleanupNoticeSeen: false,
  };
  return {
    settings,
    settingsLoaded: true,
    config: null,
    updateSettings: vi.fn(async () => undefined),
    toast: vi.fn(() => "test-toast"),
    dismissToast: vi.fn(),
    toasts: [] as ToastItem[],
    ...overrides,
  };
}

interface RenderOptions {
  route?: string;
  appValue?: AppContextValue;
  queryClient?: QueryClient;
}

export function renderWithProviders(ui: ReactNode, options: RenderOptions = {}) {
  const queryClient = options.queryClient ?? createTestQueryClient();
  const appValue = options.appValue ?? makeTestAppValue();
  const result = render(
    <AppContext.Provider value={appValue}>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[options.route ?? "/"]}>{ui}</MemoryRouter>
      </QueryClientProvider>
    </AppContext.Provider>,
  );
  return { ...result, queryClient, appValue };
}
