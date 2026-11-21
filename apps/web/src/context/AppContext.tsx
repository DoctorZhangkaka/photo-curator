import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type AutoplayInterval, type Config, type Settings, type SettingsResponse } from "../lib/api";
import { createId } from "../lib/id";
import { describeError } from "../lib/messages";
import { queryKeys } from "../lib/queryKeys";

export type ToastVariant = "success" | "error" | "info";

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastOptions {
  title: string;
  description?: string;
  code?: string;
  variant?: ToastVariant;
  action?: ToastAction;
  durationMs?: number;
}

export interface ToastItem extends ToastOptions {
  id: string;
  variant: ToastVariant;
}

export interface AppContextValue {
  settings: Settings;
  settingsLoaded: boolean;
  config: Config | null;
  updateSettings: (patch: Partial<Settings>) => Promise<void>;
  toast: (options: ToastOptions) => string;
  dismissToast: (id: string) => void;
  toasts: ToastItem[];
}

export const AppContext = createContext<AppContextValue | null>(null);

const DEFAULT_SETTINGS: Settings = {
  defaultSort: "capture",
  autoplayInterval: 3,
  cleanupNoticeSeen: false,
};

function normalizeInterval(value: number | undefined): AutoplayInterval {
  return value === 2 || value === 3 || value === 5 || value === 10 ? value : 3;
}

export function useApp(): AppContextValue {
  const context = useContext(AppContext);
  if (!context) throw new Error("useApp 必须在 AppProvider 内使用。");
  return context;
}

interface AppProviderProps {
  children: ReactNode;
}

export function AppProvider({ children }: AppProviderProps) {
  const queryClient = useQueryClient();
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const timers = useRef(new Map<string, number>());

  const dismissToast = useCallback((id: string) => {
    const timer = timers.current.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timers.current.delete(id);
    }
    setToasts((current) => current.filter((item) => item.id !== id));
  }, []);

  const toast = useCallback(
    (options: ToastOptions): string => {
      const id = createId();
      const item: ToastItem = { ...options, id, variant: options.variant ?? "info" };
      setToasts((current) => [...current.slice(-3), item]);
      const duration =
        options.durationMs ?? (item.variant === "error" ? 9000 : item.variant === "success" ? 5000 : 6000);
      const timer = window.setTimeout(() => dismissToast(id), duration);
      timers.current.set(id, timer);
      return id;
    },
    [dismissToast],
  );

  useEffect(() => {
    const activeTimers = timers.current;
    return () => {
      for (const timer of activeTimers.values()) window.clearTimeout(timer);
      activeTimers.clear();
    };
  }, []);

  const configQuery = useQuery({
    queryKey: queryKeys.config,
    queryFn: api.getConfig,
    staleTime: 5 * 60_000,
    retry: 1,
  });
  const settingsQuery = useQuery({
    queryKey: queryKeys.settings,
    queryFn: api.getSettings,
    staleTime: 60_000,
    retry: 1,
    refetchOnWindowFocus: false,
  });

  const config = configQuery.data ?? null;
  const fallbackSettings: Settings = useMemo(
    () => ({
      defaultSort: config?.defaults.sort ?? DEFAULT_SETTINGS.defaultSort,
      autoplayInterval: normalizeInterval(config?.defaults.autoplayInterval),
      cleanupNoticeSeen: config?.defaults.cleanupNoticeSeen ?? DEFAULT_SETTINGS.cleanupNoticeSeen,
    }),
    [config],
  );
  const settings = settingsQuery.data?.settings ?? fallbackSettings;

  const updateSettings = useCallback(
    async (patch: Partial<Settings>) => {
      const previous = queryClient.getQueryData<SettingsResponse>(queryKeys.settings);
      const next: Settings = { ...(previous?.settings ?? settings), ...patch };
      queryClient.setQueryData<SettingsResponse>(queryKeys.settings, { settings: next });
      try {
        const response = await api.patchSettings(patch);
        queryClient.setQueryData<SettingsResponse>(queryKeys.settings, response);
      } catch (error) {
        if (previous) queryClient.setQueryData<SettingsResponse>(queryKeys.settings, previous);
        const friendly = describeError(error);
        toast({ ...friendly, variant: "error" });
        throw error;
      }
    },
    [queryClient, settings, toast],
  );

  const value = useMemo<AppContextValue>(
    () => ({
      settings,
      settingsLoaded: settingsQuery.isSuccess,
      config,
      updateSettings,
      toast,
      dismissToast,
      toasts,
    }),
    [settings, settingsQuery.isSuccess, config, updateSettings, toast, dismissToast, toasts],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}
