import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  AlertCircle,
  ArrowLeft,
  Download,
  Filter,
  Images,
  Loader2,
  PanelRightOpen,
  RefreshCw,
  SlidersHorizontal,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  api,
  isApiError,
  type AutoplayInterval,
  type FormFilter,
  type IssueFilter,
  type Photo,
  type SelectionFilter,
  type SelectionStatus,
  type SortMode,
  type ViewFilter,
} from "../lib/api";
import { describeError } from "../lib/messages";
import { cx } from "../lib/cx";
import { formatRelativeTime } from "../lib/format";
import { queryKeys } from "../lib/queryKeys";
import { DEFAULT_FILTERS, type PhotoFilters } from "../lib/queryKeys";
import { useApp } from "../context/AppContext";
import { useAlbum, usePhotoDetail, usePhotos } from "../hooks/useApiQueries";
import { usePhotoStateMutation, useRescanAlbum, useRevealAsset } from "../hooks/useMutations";
import { useAlbumEvents } from "../hooks/useAlbumEvents";
import { useKeyboardShortcuts } from "../hooks/useKeyboardShortcuts";
import { Button, IconButton } from "../components/ui/Button";
import { Select } from "../components/ui/Select";
import { EmptyState, ErrorState, Skeleton, Spinner } from "../components/ui/StateViews";
import { ScanStatusChip } from "../components/StatusChips";
import { PhotoViewer } from "../components/culler/PhotoViewer";
import { Filmstrip } from "../components/culler/Filmstrip";
import { InfoPanel } from "../components/culler/InfoPanel";
import { CleanupDialog } from "../components/culler/CleanupDialog";
import { ExportDialog } from "../components/culler/ExportDialog";

export default function CullerPage() {
  const { albumId } = useParams<{ albumId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { settings, settingsLoaded, updateSettings, toast } = useApp();

  const [sort, setSort] = useState<SortMode>(settings.defaultSort);
  const [filters, setFilters] = useState<PhotoFilters>(DEFAULT_FILTERS);
  const [autoplayInterval, setAutoplayInterval] = useState<AutoplayInterval>(settings.autoplayInterval);
  const [playing, setPlaying] = useState(false);
  const [infoOpen, setInfoOpen] = useState<boolean>(() =>
    typeof window === "undefined" ? true : window.innerWidth >= 1024,
  );
  const [currentPhotoId, setCurrentPhotoId] = useState<string | null>(null);
  const [conflictAssetId, setConflictAssetId] = useState<string | null>(null);
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [backgroundScanning, setBackgroundScanning] = useState(false);

  const defaultsApplied = useRef(false);
  const rescanStartedFor = useRef<string | null>(null);
  const lastIndexRef = useRef<{ albumId: string; index: number }>({ albumId: "", index: 0 });

  const albumQuery = useAlbum(albumId);
  const album = albumQuery.data?.album ?? null;
  const photoParams = useMemo(() => ({ ...filters, sort }), [filters, sort]);
  const photosQuery = usePhotos(albumId, photoParams);
  const pages = photosQuery.data?.pages;
  const photos = useMemo(() => (pages ? pages.flatMap((page) => page.items) : []), [pages]);
  const total = pages?.[0]?.total ?? album?.counts.total ?? 0;

  const foundIndex = currentPhotoId ? photos.findIndex((photo) => photo.id === currentPhotoId) : -1;
  // 当前照片从列表消失（清理、筛选或标记后刷新）时，记住它原来所在的位置，
  // 落到同一位置的下一位；不要在加载下一页/清除项时跳回第一张。
  const rememberedIndex =
    lastIndexRef.current.albumId === (albumId ?? "") ? lastIndexRef.current.index : 0;
  const fallbackIndex = photos.length > 0 ? Math.min(rememberedIndex, photos.length - 1) : -1;
  const currentIndex = foundIndex >= 0 ? foundIndex : fallbackIndex;
  const current = currentIndex >= 0 ? (photos[currentIndex] ?? null) : null;

  const detailQuery = usePhotoDetail(current?.id);
  const patchMutation = usePhotoStateMutation(albumId);
  const rescanMutation = useRescanAlbum(albumId);
  const revealMutation = useRevealAsset();

  useAlbumEvents(albumId);

  const counts = album?.counts ?? null;
  const selectedCount = counts?.selected ?? 0;
  const pendingCount = counts?.pendingDelete ?? 0;
  const markDisabled = Boolean(current && (current.flags.pairingConflict || current.flags.missingFile));
  const markDisabledReason = current?.flags.pairingConflict
    ? "此照片存在配对冲突，已禁用精选/待删除标记。请先在异常中心整理文件。"
    : current?.flags.missingFile
      ? "此照片的文件已缺失，已禁用精选/待删除标记。请重新扫描或检查 Finder。"
      : undefined;

  // 设置加载完成后应用一次默认值；用户此后的选择优先。
  useEffect(() => {
    if (!settingsLoaded || defaultsApplied.current) return;
    defaultsApplied.current = true;
    setSort(settings.defaultSort);
    setAutoplayInterval(settings.autoplayInterval);
  }, [settingsLoaded, settings.defaultSort, settings.autoplayInterval]);

  useEffect(() => {
    lastIndexRef.current = { albumId: albumId ?? "", index: 0 };
    setCurrentPhotoId(null);
    setConflictAssetId(null);
    setPlaying(false);
    setInfoOpen(typeof window === "undefined" ? true : window.innerWidth >= 1024);
  }, [albumId]);

  // 窄窗口自动折叠信息面板，避免遮挡大图；用户仍可按 I 手动打开。
  useEffect(() => {
    const onResize = () => {
      if (window.innerWidth < 1024) setInfoOpen(false);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    if (foundIndex < 0) return;
    lastIndexRef.current = { albumId: albumId ?? "", index: foundIndex };
  }, [foundIndex, albumId]);

  // 保持当前照片；若新排序/筛选/清理结果中已不存在，优先落到原位置的下一位。
  useEffect(() => {
    if (!photosQuery.isSuccess || photosQuery.isPlaceholderData) return;
    if (photos.length === 0) return;
    if (!currentPhotoId || !photos.some((photo) => photo.id === currentPhotoId)) {
      const target = photos[Math.min(Math.max(rememberedIndex, 0), photos.length - 1)];
      if (target) setCurrentPhotoId(target.id);
    }
  }, [
    photos,
    currentPhotoId,
    photosQuery.isSuccess,
    photosQuery.isPlaceholderData,
    rememberedIndex,
  ]);

  useEffect(() => {
    setConflictAssetId(null);
  }, [current?.id]);

  useEffect(() => {
    if (conflictAssetId && current && !current.assets.some((asset) => asset.id === conflictAssetId)) {
      setConflictAssetId(null);
    }
  }, [conflictAssetId, current]);

  // 打开相册：先 GET 详情（显示已有数据），再后台重新扫描。
  useEffect(() => {
    if (!albumId || !albumQuery.data) return;
    if (rescanStartedFor.current === albumId) return;
    rescanStartedFor.current = albumId;
    setBackgroundScanning(true);
    rescanMutation
      .mutateAsync()
      .then((result) => {
        if (result.error) {
          toast({
            variant: "error",
            title: "后台重新扫描失败",
            description: `${result.error} 相册现有数据仍可浏览，请检查目录权限。`,
          });
        }
      })
      .catch((error: unknown) => {
        const friendly = describeError(error);
        toast({ variant: "error", title: "后台重新扫描失败", description: friendly.description });
      })
      .finally(() => setBackgroundScanning(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 每个 albumId 只自动扫描一次
  }, [albumId, albumQuery.data]);

  const loadMorePhotos = useCallback(async () => {
    if (!photosQuery.hasNextPage || photosQuery.isFetchingNextPage) return;
    try {
      await photosQuery.fetchNextPage();
    } catch (error) {
      const friendly = describeError(error);
      toast({ variant: "error", title: "加载更多照片失败", description: friendly.description });
    }
  }, [photosQuery.hasNextPage, photosQuery.isFetchingNextPage, photosQuery.fetchNextPage, toast]);

  // 接近已载入末尾时自动加载下一页；避免胶片栏一次挂载全部。
  useEffect(() => {
    if (!photosQuery.hasNextPage || photosQuery.isFetchingNextPage) return;
    if (photos.length === 0) return;
    if (currentIndex >= photos.length - 5) {
      void loadMorePhotos();
    }
  }, [
    currentIndex,
    photos.length,
    photosQuery.hasNextPage,
    photosQuery.isFetchingNextPage,
    loadMorePhotos,
  ]);

  // 预加载当前照片前后各两张（不触发已浏览标记）。
  useEffect(() => {
    if (!current || photos.length === 0) return;
    const neighbors = [currentIndex - 2, currentIndex - 1, currentIndex + 1, currentIndex + 2];
    for (const index of neighbors) {
      const photo = photos[index];
      if (!photo) continue;
      const image = new window.Image();
      image.decoding = "async";
      image.src = photo.previewUrl;
    }
  }, [current, currentIndex, photos]);

  const pauseForAction = useCallback(() => setPlaying(false), []);

  const loadNextPageAndAdvance = useCallback(async () => {
    const currentId = current?.id;
    try {
      const result = await photosQuery.fetchNextPage();
      const all = result.data?.pages.flatMap((page) => page.items) ?? [];
      const index = all.findIndex((photo) => photo.id === currentId);
      if (index >= 0 && index + 1 < all.length) setCurrentPhotoId(all[index + 1].id);
    } catch (error) {
      const friendly = describeError(error);
      toast({ variant: "error", title: "加载更多照片失败", description: friendly.description });
      setPlaying(false);
    }
  }, [current?.id, photosQuery, toast]);

  const goPrevious = useCallback(() => {
    if (currentIndex <= 0) return;
    const previous = photos[currentIndex - 1];
    if (previous) setCurrentPhotoId(previous.id);
  }, [currentIndex, photos]);

  const goNext = useCallback(() => {
    if (photos.length === 0) return;
    if (currentIndex < photos.length - 1) {
      const next = photos[currentIndex + 1];
      if (next) setCurrentPhotoId(next.id);
      return;
    }
    if (photosQuery.hasNextPage && !photosQuery.isFetchingNextPage) {
      void loadNextPageAndAdvance();
    }
  }, [currentIndex, photos, photosQuery.hasNextPage, photosQuery.isFetchingNextPage, loadNextPageAndAdvance]);

  const canPrevious = currentIndex > 0;
  const canNext = currentIndex >= 0 && (currentIndex < photos.length - 1 || photosQuery.hasNextPage);

  const applyState = useCallback(
    async (
      photo: Photo,
      patch: { viewedStatus?: "unseen" | "viewed"; selectionStatus?: SelectionStatus },
    ) => {
      try {
        await patchMutation.mutateAsync({
          photoId: photo.id,
          version: photo.version,
          ...patch,
        });
      } catch (error) {
        const friendly = describeError(error);
        toast({ ...friendly, variant: "error" });
      }
    },
    [patchMutation, toast],
  );

  const markViewed = useCallback(
    async (photo: Photo) => {
      if (photo.viewedStatus === "viewed") return;
      try {
        await patchMutation.mutateAsync({
          photoId: photo.id,
          version: photo.version,
          viewedStatus: "viewed",
        });
      } catch (error) {
        if (isApiError(error) && error.code === "STALE_VERSION") {
          try {
            const fresh = await api.getPhoto(photo.id);
            queryClient.setQueryData(queryKeys.photo(photo.id), fresh);
            if (fresh.photo.viewedStatus === "unseen") {
              await patchMutation.mutateAsync({
                photoId: fresh.photo.id,
                version: fresh.photo.version,
                viewedStatus: "viewed",
              });
            }
            void queryClient.invalidateQueries({ queryKey: ["photos", albumId] });
            return;
          } catch (retryError) {
            error = retryError;
          }
        }
        const friendly = describeError(error);
        toast({ ...friendly, variant: "error" });
      }
    },
    [albumId, patchMutation, queryClient, toast],
  );

  const notifyMarkBlocked = useCallback(() => {
    if (!markDisabled) return false;
    toast({
      variant: "info",
      title: "无法标记此照片",
      description: markDisabledReason,
    });
    return true;
  }, [markDisabled, markDisabledReason, toast]);

  const toggleSelected = useCallback(() => {
    pauseForAction();
    if (!current || notifyMarkBlocked()) return;
    const next: SelectionStatus = current.selectionStatus === "selected" ? "unmarked" : "selected";
    void applyState(current, { selectionStatus: next });
  }, [current, applyState, pauseForAction, notifyMarkBlocked]);

  const togglePendingDelete = useCallback(() => {
    pauseForAction();
    if (!current || notifyMarkBlocked()) return;
    const next: SelectionStatus =
      current.selectionStatus === "pending_delete" ? "unmarked" : "pending_delete";
    void applyState(current, { selectionStatus: next });
  }, [current, applyState, pauseForAction, notifyMarkBlocked]);

  const toggleViewed = useCallback(() => {
    pauseForAction();
    if (!current) return;
    void applyState(current, {
      viewedStatus: current.viewedStatus === "viewed" ? "unseen" : "viewed",
    });
  }, [current, applyState, pauseForAction]);

  const togglePlayback = useCallback(() => {
    if (playing) {
      setPlaying(false);
      return;
    }
    if (!current) return;
    if (currentIndex >= photos.length - 1 && !photosQuery.hasNextPage) {
      toast({ variant: "info", title: "已经是最后一张", description: "自动播放已停止，不会循环。" });
      return;
    }
    setPlaying(true);
  }, [playing, current, currentIndex, photos.length, photosQuery.hasNextPage, toast]);

  const toggleInfo = useCallback(() => setInfoOpen((value) => !value), []);

  const handleEscape = useCallback(() => {
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    }
  }, []);

  useKeyboardShortcuts(
    {
      previous: goPrevious,
      next: goNext,
      toggleSelected,
      togglePendingDelete,
      togglePlayback,
      toggleInfo,
      toggleViewed,
      escape: handleEscape,
    },
    { enabled: !cleanupOpen && !exportOpen },
  );

  // 自动播放：到末尾停止，不循环；任何标记/清理/导出操作都会暂停。
  useEffect(() => {
    if (!playing) return;
    if (!current) {
      setPlaying(false);
      return;
    }
    const timer = window.setTimeout(() => {
      if (currentIndex >= photos.length - 1 && !photosQuery.hasNextPage) {
        setPlaying(false);
        toast({ variant: "info", title: "已到最后一张", description: "自动播放已停止。" });
        return;
      }
      goNext();
    }, autoplayInterval * 1000);
    return () => window.clearTimeout(timer);
  }, [
    playing,
    current,
    currentIndex,
    photos.length,
    photosQuery.hasNextPage,
    autoplayInterval,
    goNext,
    toast,
  ]);

  function handleAutoplayIntervalChange(value: AutoplayInterval) {
    setAutoplayInterval(value);
    void updateSettings({ autoplayInterval: value }).catch(() => undefined);
  }

  function updateFilter<K extends keyof PhotoFilters>(key: K, value: PhotoFilters[K]) {
    setFilters((currentFilters) => ({ ...currentFilters, [key]: value }));
  }

  const filtersActive = (Object.keys(DEFAULT_FILTERS) as Array<keyof PhotoFilters>).some(
    (key) => filters[key] !== DEFAULT_FILTERS[key],
  );

  function resetFilters() {
    setFilters({ ...DEFAULT_FILTERS });
  }

  function handleRescan() {
    setBackgroundScanning(true);
    rescanMutation
      .mutateAsync()
      .then((result) => {
        if (result.error) {
          toast({ variant: "error", title: "重新扫描失败", description: result.error });
        } else {
          toast({ variant: "success", title: "重新扫描完成", description: `共 ${result.album.counts.total} 张逻辑照片。` });
        }
      })
      .catch((error: unknown) => {
        const friendly = describeError(error);
        toast({ ...friendly, variant: "error" });
      })
      .finally(() => setBackgroundScanning(false));
  }

  function handleReveal(assetId: string) {
    revealMutation
      .mutateAsync(assetId)
      .then((result) => {
        toast({ variant: "info", title: "已在 Finder 中显示", description: result.relativePath });
      })
      .catch((error: unknown) => {
        const friendly = describeError(error);
        toast({ ...friendly, variant: "error" });
      });
  }

  const scanStatus = backgroundScanning || album?.scanStatus === "scanning" ? "scanning" : (album?.scanStatus ?? "pending");
  const scanFailed = !backgroundScanning && album?.scanStatus === "failed";
  const viewerEmptyState =
    photosQuery.isPending && !photosQuery.data ? (
      <div className="w-full max-w-md space-y-3" aria-label="正在加载照片列表">
        <Skeleton className="h-64 w-full opacity-40" />
        <Spinner label="正在读取照片列表..." />
      </div>
    ) : album?.scanStatus === "empty" || (album && album.counts.total === 0) ? (
      <EmptyState
        icon={Images}
        title="相册为空"
        description="没有发现支持的 JPG、JPEG、RAF、ARW 或 DNG 文件。重新扫描可检测外部新增的文件。"
        action={
          <Button variant="secondary" size="sm" icon={RefreshCw} onClick={handleRescan} loading={backgroundScanning}>
            重新扫描相册
          </Button>
        }
        className="w-full max-w-lg border-white/[0.08]"
      />
    ) : (
      <EmptyState
        icon={Filter}
        title="没有符合筛选条件的照片"
        description="当前筛选组合下没有照片。可以重置筛选，或切换到全部浏览/筛选状态。"
        action={
          <Button variant="secondary" size="sm" icon={SlidersHorizontal} onClick={resetFilters}>
            重置筛选
          </Button>
        }
        className="w-full max-w-lg border-white/[0.08]"
      />
    );

  if (!albumId) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 bg-ink-950 p-6">
        <ErrorState error={new Error("缺少相册 ID。")} title="无法打开相册" />
        <Button variant="secondary" icon={ArrowLeft} onClick={() => navigate("/")}>
          返回相册库
        </Button>
      </div>
    );
  }

  if (albumQuery.isError && !album) {
    return (
      <div data-testid="culler-page" className="flex h-full flex-col bg-ink-950">
        <header className="flex items-center gap-2 border-b border-white/[0.07] bg-ink-900 px-3 py-2">
          <Button variant="ghost" size="sm" icon={ArrowLeft} data-testid="back-button" onClick={() => navigate("/")}>
            相册库
          </Button>
        </header>
        <div className="mx-auto w-full max-w-xl p-6">
          <ErrorState error={albumQuery.error} title="无法打开相册" onRetry={() => void albumQuery.refetch()} />
          <p className="mt-3 text-center text-xs text-ink-500">没有任何文件操作发生。</p>
        </div>
      </div>
    );
  }

  return (
    <div data-testid="culler-page" className="flex h-full min-h-0 flex-col bg-ink-950">
      {/* 暗房工作台顶部控制栏 */}
      <header className="z-20 shrink-0 border-b border-white/[0.08] bg-ink-900">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2">
          <Button
            variant="ghost"
            size="sm"
            icon={ArrowLeft}
            data-testid="back-button"
            onClick={() => navigate("/")}
            className="text-ink-300"
          >
            相册库
          </Button>

          <span className="hidden h-4 w-px bg-white/[0.08] sm:block" aria-hidden="true" />

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate text-[13px] font-semibold tracking-[-0.01em] text-ink-100 sm:text-sm">
                {album?.name ?? "加载相册…"}
              </h1>
              <ScanStatusChip status={scanStatus} />
              {counts ? (
                <span className="hidden items-center gap-2 rounded border border-white/[0.06] bg-ink-950/70 px-2 py-0.5 font-mono text-[10px] tabular-nums text-ink-400 sm:inline-flex">
                  <span>共 {counts.total}</span>
                  <span className="text-ink-700">|</span>
                  <span>已浏览 {counts.viewed}</span>
                  <span className="text-ink-700">|</span>
                  <span className={counts.selected > 0 ? "text-accent-300" : undefined}>精选 {counts.selected}</span>
                  <span className="text-ink-700">|</span>
                  <span className={counts.pendingDelete > 0 ? "text-red-300" : undefined}>
                    待删除 {counts.pendingDelete}
                  </span>
                </span>
              ) : null}
              {album?.lastScannedAt ? (
                <span className="hidden font-mono text-[10px] text-ink-500 xl:inline">
                  扫描于 {formatRelativeTime(album.lastScannedAt)}
                </span>
              ) : null}
            </div>
            <p className="mt-0.5 truncate font-mono text-[10px] text-ink-500">{album?.relativePath ?? albumId}</p>
            {scanFailed && album?.scanError ? (
              <p role="alert" className="mt-0.5 flex items-center gap-1 text-[10px] text-red-300">
                <AlertCircle className="h-3 w-3 shrink-0" aria-hidden="true" />
                {album.scanError}
              </p>
            ) : null}
          </div>

          <div className="order-last flex w-full flex-wrap items-center justify-end gap-1.5 border-t border-white/[0.05] pt-1.5 sm:order-none sm:w-auto sm:border-0 sm:pt-0">
            <Button
              variant="ghost"
              size="sm"
              icon={TriangleAlert}
              onClick={() => navigate(`/issues?album=${encodeURIComponent(albumId)}`)}
              title="打开异常中心"
            >
              异常
              {counts && counts.missing + counts.conflicts > 0 ? (
                <span className="ml-0.5 rounded bg-amber-500/15 px-1 font-mono text-[10px] text-amber-300">
                  {counts.missing + counts.conflicts}
                </span>
              ) : null}
            </Button>
            <IconButton
              label={backgroundScanning ? "正在重新扫描相册" : "重新扫描相册"}
              icon={RefreshCw}
              size="sm"
              disabled={backgroundScanning || rescanMutation.isPending}
              onClick={handleRescan}
            />
            <span className="hidden h-4 w-px bg-white/[0.08] sm:block" aria-hidden="true" />
            <Button
              variant="secondary"
              size="sm"
              icon={Download}
              data-testid="export-button"
              disabled={selectedCount === 0}
              title={selectedCount === 0 ? "当前没有精选照片" : "导出精选照片到固定精选目录"}
              className={selectedCount > 0 ? "border-accent-400/35 text-accent-200 hover:border-accent-400/55" : undefined}
              onClick={() => {
                pauseForAction();
                setExportOpen(true);
              }}
            >
              导出精选
              {selectedCount > 0 ? (
                <span className="rounded bg-accent-500/20 px-1 font-mono text-[10px] tabular-nums text-accent-300">
                  {selectedCount}
                </span>
              ) : null}
            </Button>
            <Button
              variant="danger"
              size="sm"
              icon={Trash2}
              data-testid="cleanup-button"
              disabled={pendingCount === 0}
              title={pendingCount === 0 ? "当前没有待删除照片" : "预检后移入 macOS 废纸篓"}
              onClick={() => {
                pauseForAction();
                setCleanupOpen(true);
              }}
            >
              清理待删除
              {pendingCount > 0 ? (
                <span className="rounded bg-red-500/20 px-1 font-mono text-[10px] tabular-nums text-red-200">
                  {pendingCount}
                </span>
              ) : null}
            </Button>
          </div>
        </div>

        {/* 暗房内凹式筛选子栏 */}
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 border-t border-white/[0.06] bg-ink-950/75 px-3 py-1.5">
          <Select
            label="排序"
            data-testid="culler-sort"
            value={sort}
            onChange={(event) => setSort(event.target.value as SortMode)}
          >
            <option value="capture">拍摄时间</option>
            <option value="filename">文件名</option>
          </Select>
          <span className="hidden h-3.5 w-px bg-white/[0.08] sm:block" aria-hidden="true" />
          <Select
            label="浏览"
            data-testid="filter-viewed"
            value={filters.viewed}
            onChange={(event) => updateFilter("viewed", event.target.value as ViewFilter)}
          >
            <option value="all">全部</option>
            <option value="unseen">未浏览</option>
            <option value="viewed">已浏览</option>
          </Select>
          <Select
            label="筛选"
            data-testid="filter-selection"
            value={filters.selection}
            onChange={(event) => updateFilter("selection", event.target.value as SelectionFilter)}
          >
            <option value="all">全部</option>
            <option value="unmarked">未筛选</option>
            <option value="selected">精选</option>
            <option value="pending_delete">待删除</option>
          </Select>
          <Select
            label="形态"
            data-testid="filter-form"
            value={filters.form}
            onChange={(event) => updateFilter("form", event.target.value as FormFilter)}
          >
            <option value="all">全部</option>
            <option value="jpg_raw">JPG+RAW</option>
            <option value="jpg_only">仅 JPG</option>
            <option value="raw_only">仅 RAW</option>
          </Select>
          <Select
            label="异常"
            data-testid="filter-issue"
            value={filters.issue}
            onChange={(event) => updateFilter("issue", event.target.value as IssueFilter)}
          >
            <option value="all">全部</option>
            <option value="pairing_conflict">配对冲突</option>
            <option value="missing">文件缺失</option>
            <option value="export_conflict">导出冲突</option>
          </Select>
          {filtersActive ? (
            <button
              type="button"
              onClick={resetFilters}
              className="rounded border border-accent-400/30 bg-accent-500/10 px-2 py-0.5 text-[10px] font-medium text-accent-300 transition-colors hover:bg-accent-500/20"
            >
              重置筛选
            </button>
          ) : null}
          <div className="ml-auto flex items-center gap-3">
            {photosQuery.isFetching && !photosQuery.isFetchingNextPage ? (
              <span role="status" aria-label="正在刷新筛选结果">
                <Loader2 className="h-3 w-3 animate-spin text-accent-400" aria-hidden="true" />
              </span>
            ) : null}
            <span className="font-mono text-[10px] tabular-nums text-ink-500">
              筛选结果 <span className="text-ink-200">{total}</span> 张
            </span>
            {!infoOpen && current ? (
              <button
                type="button"
                onClick={toggleInfo}
                className="inline-flex items-center gap-1 rounded border border-white/[0.08] bg-white/[0.03] px-2 py-0.5 text-[10px] font-medium text-ink-300 transition-colors hover:border-white/[0.16] hover:bg-white/[0.07] hover:text-ink-100"
              >
                <PanelRightOpen className="h-3 w-3" aria-hidden="true" /> 信息
              </button>
            ) : null}
          </div>
        </div>
      </header>

      <div className="relative flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          {photosQuery.isError && !photosQuery.data ? (
            <div className="flex flex-1 items-center justify-center p-6">
              <div className="w-full max-w-lg">
                <ErrorState
                  error={photosQuery.error}
                  title="无法加载照片列表"
                  onRetry={() => void photosQuery.refetch()}
                />
                <p className="mt-3 text-center text-xs text-ink-500">相册文件没有被修改。可以返回相册库后重试。</p>
              </div>
            </div>
          ) : (
            <PhotoViewer
              photo={current}
              index={currentIndex < 0 ? 0 : currentIndex}
              total={total}
              canPrevious={canPrevious}
              canNext={canNext}
              emptyState={viewerEmptyState}
              playing={playing}
              autoplayInterval={autoplayInterval}
              onTogglePlayback={togglePlayback}
              onAutoplayIntervalChange={handleAutoplayIntervalChange}
              onPrevious={goPrevious}
              onNext={goNext}
              onToggleViewed={toggleViewed}
              onToggleSelected={toggleSelected}
              onTogglePendingDelete={togglePendingDelete}
              onToggleInfo={toggleInfo}
              infoOpen={infoOpen}
              onViewerLoaded={(photo) => void markViewed(photo)}
              markDisabled={markDisabled}
              markDisabledReason={markDisabledReason}
              conflictAssetId={conflictAssetId}
            />
          )}
          <Filmstrip
            photos={photos}
            total={total}
            currentIndex={currentIndex < 0 ? 0 : currentIndex}
            onSelect={(index) => {
              const photo = photos[index];
              if (photo) setCurrentPhotoId(photo.id);
            }}
            hasNextPage={Boolean(photosQuery.hasNextPage)}
            isFetchingNextPage={photosQuery.isFetchingNextPage}
            onLoadMore={loadMorePhotos}
          />
        </div>

        {infoOpen && current ? (
          <>
            <button
              type="button"
              aria-label="关闭照片信息"
              className="absolute inset-0 z-20 bg-black/45 backdrop-blur-[1px] lg:hidden"
              onClick={toggleInfo}
            />
            <InfoPanel
              className={cx(
                "absolute inset-y-0 right-0 z-30 max-h-full shadow-2xl lg:static lg:z-auto lg:shadow-none",
              )}
              photo={current}
              detail={detailQuery.data}
              detailLoading={detailQuery.isPending}
              detailError={detailQuery.error}
              onRetryDetail={() => void detailQuery.refetch()}
              onToggleInfo={toggleInfo}
              onToggleViewed={toggleViewed}
              onToggleSelected={toggleSelected}
              onTogglePendingDelete={togglePendingDelete}
              markDisabled={markDisabled}
              markDisabledReason={markDisabledReason}
              selectedAssetId={conflictAssetId}
              onSelectAsset={(assetId) => {
                pauseForAction();
                setConflictAssetId(assetId);
              }}
              onRevealAsset={handleReveal}
              revealingAssetId={revealMutation.isPending ? (revealMutation.variables ?? null) : null}
            />
          </>
        ) : null}
      </div>

      <CleanupDialog
        open={cleanupOpen}
        albumId={albumId}
        albumName={album?.name ?? null}
        onClose={() => setCleanupOpen(false)}
        onPauseAutoplay={pauseForAction}
      />
      <ExportDialog
        open={exportOpen}
        albumId={albumId}
        albumName={album?.name ?? null}
        selectedCount={selectedCount}
        onClose={() => setExportOpen(false)}
        onPauseAutoplay={pauseForAction}
      />
      <div className="sr-only" aria-live="polite">
        {current ? `${current.displayName}，第 ${currentIndex + 1} 张，共 ${total} 张` : "没有照片"}
      </div>
    </div>
  );
}
