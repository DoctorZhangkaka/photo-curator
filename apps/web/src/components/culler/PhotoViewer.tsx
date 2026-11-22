import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode, type SyntheticEvent } from "react";
import {
  ChevronLeft,
  ChevronRight,
  ImageOff,
  Maximize2,
  Minimize2,
  Pause,
  Play,
  RotateCcw,
  Star,
  Trash2,
  ZoomIn,
  ZoomOut,
  PanelRightClose,
  PanelRightOpen,
  Eye,
  EyeOff,
} from "lucide-react";
import { appendMediaParam, type AutoplayInterval, type Photo } from "../../lib/api";
import { formatBytes, formatCaptureTime } from "../../lib/format";
import { cx } from "../../lib/cx";
import { useApp } from "../../context/AppContext";
import { describeError } from "../../lib/messages";
import { Button, IconButton } from "../ui/Button";
import { Select } from "../ui/Select";
import { Skeleton, Spinner } from "../ui/StateViews";
import { FormChip, PhotoFlagChips, SelectionChip, StatusChip, ViewedChip } from "../StatusChips";

interface PhotoViewerProps {
  photo: Photo | null;
  index: number;
  total: number;
  canPrevious: boolean;
  canNext: boolean;
  emptyState?: ReactNode;
  playing: boolean;
  autoplayInterval: AutoplayInterval;
  onTogglePlayback: () => void;
  onAutoplayIntervalChange: (value: AutoplayInterval) => void;
  onPrevious: () => void;
  onNext: () => void;
  onToggleViewed: () => void;
  onToggleSelected: () => void;
  onTogglePendingDelete: () => void;
  onToggleInfo: () => void;
  infoOpen: boolean;
  onViewerLoaded: (photo: Photo) => void;
  markDisabled: boolean;
  markDisabledReason?: string;
  conflictAssetId: string | null;
}

interface DragState {
  pointerId: number;
  startX: number;
  startY: number;
  originX: number;
  originY: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function PhotoViewer({
  photo,
  index,
  total,
  canPrevious,
  canNext,
  emptyState,
  playing,
  autoplayInterval,
  onTogglePlayback,
  onAutoplayIntervalChange,
  onPrevious,
  onNext,
  onToggleViewed,
  onToggleSelected,
  onTogglePendingDelete,
  onToggleInfo,
  infoOpen,
  onViewerLoaded,
  markDisabled,
  markDisabledReason,
  conflictAssetId,
}: PhotoViewerProps) {
  const { toast } = useApp();
  const rootRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const attemptedViewRef = useRef<string | null>(null);

  const [zoom, setZoom] = useState(1);
  const [zoomMode, setZoomMode] = useState<"fit" | "actual" | "custom">("fit");
  const [translate, setTranslate] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [usingOriginal, setUsingOriginal] = useState(false);
  const [pendingActual, setPendingActual] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [naturalSize, setNaturalSize] = useState({ width: 0, height: 0 });
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    setZoom(1);
    setZoomMode("fit");
    setTranslate({ x: 0, y: 0 });
    setUsingOriginal(false);
    setPendingActual(false);
    setLoaded(false);
    setLoadError(null);
    setRetry(0);
    setNaturalSize({ width: 0, height: 0 });
    setDragging(false);
    dragRef.current = null;
  }, [photo?.id, conflictAssetId]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const update = () => setViewportSize({ width: viewport.clientWidth, height: viewport.clientHeight });
    update();
    window.addEventListener("resize", update);
    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(update);
      observer.observe(viewport);
    }
    return () => {
      window.removeEventListener("resize", update);
      observer?.disconnect();
    };
  }, []);

  useEffect(() => {
    const handleChange = () => setFullscreen(document.fullscreenElement === rootRef.current);
    document.addEventListener("fullscreenchange", handleChange);
    return () => document.removeEventListener("fullscreenchange", handleChange);
  }, []);

  const presentAssets = photo?.assets.filter((asset) => asset.presenceStatus === "present") ?? [];
  const hasPresentAsset = presentAssets.length > 0;
  const src = photo
    ? (() => {
        let url = usingOriginal ? photo.originalPreviewUrl : photo.previewUrl;
        if (retry > 0) url = appendMediaParam(url, "retry", retry);
        if (conflictAssetId) url = appendMediaParam(url, "assetId", conflictAssetId);
        return url;
      })()
    : "";

  const rawFitScale =
    naturalSize.width > 0 && naturalSize.height > 0 && viewportSize.width > 0 && viewportSize.height > 0
      ? Math.min(viewportSize.width / naturalSize.width, viewportSize.height / naturalSize.height)
      : 0;
  // CSS 的 max-width/max-height 已经把大图缩小到可视区域；fitScale 用于把
  // “相对布局尺寸”的 zoom 换算成显示百分比。小图（尤其高分辨率屏幕上较小的
  // 预览）需要显式放大到适应屏幕，因此 fitZoom 允许大于 1。
  const fitScale = rawFitScale > 0 ? Math.min(rawFitScale, 1) : 0;
  const fitZoom = rawFitScale > 1 ? rawFitScale : 1;
  const zoomPercent = fitScale > 0 ? Math.round(fitScale * zoom * 100) : 100;

  useEffect(() => {
    if (zoomMode !== "fit" || rawFitScale <= 0) return;
    setZoom(fitZoom);
  }, [fitZoom, rawFitScale, zoomMode]);

  function applyActualZoom(naturalWidth: number, naturalHeight: number) {
    const viewport = viewportRef.current;
    if (!viewport || !naturalWidth || !naturalHeight) return;
    const rect = viewport.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const fit = Math.min(rect.width / naturalWidth, rect.height / naturalHeight, 1);
    if (fit > 0) {
      setZoom(clamp(1 / fit, 0.02, 20));
      setZoomMode("actual");
      setTranslate({ x: 0, y: 0 });
    }
  }

  function handleActual() {
    if (!photo) return;
    setPendingActual(true);
    if (usingOriginal) {
      if (naturalSize.width) applyActualZoom(naturalSize.width, naturalSize.height);
      setPendingActual(false);
    } else {
      setUsingOriginal(true);
      setLoaded(false);
      setLoadError(null);
    }
  }

  function handleFit() {
    setZoom(fitZoom);
    setZoomMode("fit");
    setTranslate({ x: 0, y: 0 });
    setUsingOriginal(false);
    setPendingActual(false);
  }

  function handleZoomIn() {
    setZoom((current) => {
      const next = clamp(current * 1.25, 1, 20);
      setZoomMode(next === 1 ? "fit" : "custom");
      return next;
    });
  }

  function handleZoomOut() {
    setZoom((current) => {
      const next = current / 1.25;
      if (next <= 1.01) {
        // 小图在“适应”模式下会放大到大于 100%；缩小到这里表示回到 100%，
        // 不应重新切回“适应”，否则效果会被 fit effect 立刻还原。
        setZoomMode(rawFitScale > 1 ? "custom" : "fit");
        setTranslate({ x: 0, y: 0 });
        setUsingOriginal(false);
        return 1;
      }
      setZoomMode("custom");
      return next;
    });
  }

  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else if (rootRef.current?.requestFullscreen) {
        await rootRef.current.requestFullscreen();
      } else {
        toast({ variant: "error", title: "当前浏览器不支持全屏", description: "可以继续使用窗口内的大图查看器。" });
      }
    } catch (error) {
      const friendly = describeError(error);
      toast({ variant: "error", title: "无法切换全屏", description: friendly.description });
    }
  }

  function handleImageLoad(event: SyntheticEvent<HTMLImageElement>) {
    if (!photo) return;
    const image = event.currentTarget;
    setNaturalSize({ width: image.naturalWidth, height: image.naturalHeight });
    setLoaded(true);
    setLoadError(null);
    if (pendingActual) {
      applyActualZoom(image.naturalWidth, image.naturalHeight);
      setPendingActual(false);
    }
    if (attemptedViewRef.current !== photo.id) {
      attemptedViewRef.current = photo.id;
      onViewerLoaded(photo);
    }
  }

  function handleImageError() {
    if (!photo) return;
    if (usingOriginal) {
      setUsingOriginal(false);
      setLoaded(false);
      setLoadError(null);
      setRetry((current) => current + 1);
      toast({
        variant: "info",
        title: "原图预览不可用，已切换到标准预览",
        description: "100% 查看会使用服务端解码预览代替原图。",
      });
      return;
    }
    setLoaded(false);
    setLoadError("无法加载大图预览。文件可能已变化、被移走，或 RAW 解码失败。");
  }

  function retryImage() {
    setLoadError(null);
    setLoaded(false);
    setUsingOriginal(false);
    setPendingActual(false);
    setRetry((current) => current + 1);
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (!photo || zoom <= 1.01 || event.button !== 0) return;
    if ((event.target as HTMLElement).closest("button")) return;
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: translate.x,
      originY: translate.y,
    };
    setDragging(true);
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const image = imgRef.current;
    const viewport = viewportRef.current;
    if (!image || !viewport) return;
    const overflowX = Math.max(0, (image.offsetWidth * zoom - viewport.clientWidth) / 2);
    const overflowY = Math.max(0, (image.offsetHeight * zoom - viewport.clientHeight) / 2);
    setTranslate({
      x: clamp(drag.originX + event.clientX - drag.startX, -overflowX, overflowX),
      y: clamp(drag.originY + event.clientY - drag.startY, -overflowY, overflowY),
    });
  }

  function endDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (dragRef.current?.pointerId === event.pointerId) {
      dragRef.current = null;
      setDragging(false);
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    }
  }

  const zoomLabel = zoomMode === "fit" ? "FIT" : zoomMode === "actual" ? "100%" : `${zoomPercent}%`;

  return (
    <div ref={rootRef} className="flex min-h-0 flex-1 flex-col bg-[#060607]">
      <div
        ref={viewportRef}
        data-viewport
        className={cx(
          "group/stage darkroom-stage relative flex min-h-[220px] flex-1 items-center justify-center overflow-hidden p-2 sm:p-4",
          zoom > 1.01 && !dragging && "cursor-grab",
          dragging && "cursor-grabbing",
        )}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={() => {
          if (!photo) return;
          if (zoomMode === "fit") handleActual();
          else handleFit();
        }}
        style={{ touchAction: zoom > 1.01 ? "none" : undefined }}
      >
        {/* 顶部低干扰取景器状态条 */}
        {photo ? (
          <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex flex-wrap items-start justify-between gap-2 p-2.5 sm:p-3.5">
            <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-white/[0.08] bg-ink-950/70 px-2 py-1 backdrop-blur-md">
              <span
                data-testid="photo-counter"
                className="pr-1 font-mono text-[11px] font-medium tabular-nums text-ink-200"
              >
                {index + 1} <span className="text-ink-500">/</span> {total}
              </span>
              <span className="h-3 w-px bg-white/[0.1]" aria-hidden="true" />
              <ViewedChip status={photo.viewedStatus} />
              <SelectionChip status={photo.selectionStatus} />
              <FormChip form={photo.form} />
              <PhotoFlagChips photo={photo} />
            </div>
            <div className="flex flex-col items-end gap-1">
              {markDisabled && markDisabledReason ? (
                <StatusChip
                  tone="warning"
                  className="max-w-[270px] whitespace-normal bg-ink-950/85 text-left backdrop-blur-md"
                >
                  {markDisabledReason}
                </StatusChip>
              ) : null}
            </div>
          </div>
        ) : null}

        {!photo ? (
          <div className="flex h-full w-full items-center justify-center p-6">{emptyState}</div>
        ) : !hasPresentAsset ? (
          <div
            role="alert"
            data-testid="viewer-error"
            className="mx-4 flex max-w-md flex-col items-center rounded-[10px] border border-red-400/25 bg-red-950/25 px-6 py-8 text-center backdrop-blur-sm"
          >
            <ImageOff className="h-7 w-7 text-red-400" aria-hidden="true" />
            <p className="mt-3 text-sm font-medium text-red-200">文件缺失，无法显示预览</p>
            <p className="mt-1 text-xs leading-relaxed text-ink-400">
              数据库仍有这张照片的记录，但原文件已不在相册中。请重新扫描，或在异常中心查看缺失路径。
            </p>
          </div>
        ) : loadError ? (
          <div
            role="alert"
            data-testid="viewer-error"
            className="mx-4 flex max-w-md flex-col items-center rounded-[10px] border border-red-400/25 bg-red-950/25 px-6 py-8 text-center backdrop-blur-sm"
          >
            <ImageOff className="h-7 w-7 text-red-400" aria-hidden="true" />
            <p className="mt-3 text-sm font-medium text-red-200">大图加载失败</p>
            <p className="mt-1 text-xs leading-relaxed text-ink-400">{loadError}</p>
            <Button variant="secondary" size="sm" icon={RotateCcw} className="mt-4" onClick={retryImage}>
              重试加载
            </Button>
          </div>
        ) : (
          <>
            {!loaded ? (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-8" aria-hidden="true">
                <Skeleton className="h-2/3 w-2/3 max-w-3xl opacity-40" />
                <Spinner label="正在显影大图..." />
              </div>
            ) : null}
            <img
              ref={imgRef}
              key={`${photo.id}:${usingOriginal ? "original" : "preview"}`}
              data-testid="viewer-image"
              data-photo-id={photo.id}
              src={src}
              alt={`大图：${photo.displayName}`}
              draggable={false}
              onLoad={handleImageLoad}
              onError={handleImageError}
              className={cx(
                "relative max-h-full max-w-full select-none object-contain shadow-[0_18px_60px_rgba(0,0,0,0.85)] ring-1 ring-white/[0.06]",
                loaded ? "opacity-100" : "opacity-0",
                !dragging && "transition-[opacity] duration-200",
              )}
              style={{
                transform: `translate3d(${translate.x}px, ${translate.y}px, 0) scale(${zoom})`,
                cursor: zoom > 1.01 ? (dragging ? "grabbing" : "grab") : "default",
              }}
            />
          </>
        )}

        {photo ? (
          <>
            {/* 底部低调照片标题与缩放遥测 */}
            <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex items-end justify-between gap-3 bg-gradient-to-t from-black/80 via-black/25 to-transparent px-3.5 pb-3 pt-12 sm:px-5 sm:pb-3.5">
              <div className="min-w-0">
                <p className="truncate font-mono text-xs font-medium tracking-[0.01em] text-ink-100 sm:text-[13px]">
                  {photo.displayName}
                </p>
                <p className="mt-0.5 truncate font-mono text-[10px] tabular-nums text-ink-400">
                  {formatCaptureTime(photo.captureTime)} · {photo.fileCount} 个文件 · {formatBytes(photo.totalBytes)}
                </p>
              </div>
              <span className="shrink-0 rounded border border-white/[0.1] bg-ink-950/75 px-2 py-0.5 font-mono text-[10px] font-medium tabular-nums tracking-[0.06em] text-ink-200 backdrop-blur-md">
                {zoomLabel}
              </span>
            </div>

            {/* 左右翻张静音悬浮按钮（平时低存在感，悬停显影） */}
            <button
              type="button"
              aria-label="上一张"
              aria-keyshortcuts="ArrowLeft"
              onClick={onPrevious}
              disabled={!canPrevious}
              className="absolute left-3 top-1/2 z-10 flex h-11 w-9 -translate-y-1/2 items-center justify-center rounded-md border border-white/[0.12] bg-ink-950/65 text-ink-200 opacity-45 backdrop-blur-md transition-all duration-150 hover:border-white/25 hover:bg-ink-900/90 hover:text-white group-hover/stage:opacity-100 disabled:pointer-events-none disabled:opacity-15"
            >
              <ChevronLeft className="h-5 w-5" aria-hidden="true" />
            </button>
            <button
              type="button"
              aria-label="下一张"
              aria-keyshortcuts="ArrowRight"
              onClick={onNext}
              disabled={!canNext}
              className="absolute right-3 top-1/2 z-10 flex h-11 w-9 -translate-y-1/2 items-center justify-center rounded-md border border-white/[0.12] bg-ink-950/65 text-ink-200 opacity-45 backdrop-blur-md transition-all duration-150 hover:border-white/25 hover:bg-ink-900/90 hover:text-white group-hover/stage:opacity-100 disabled:pointer-events-none disabled:opacity-15"
            >
              <ChevronRight className="h-5 w-5" aria-hidden="true" />
            </button>
          </>
        ) : null}
      </div>

      {/* 暗房硬件操控台式底部工具栏 */}
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-t border-white/[0.08] bg-ink-900 px-2.5 py-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] sm:px-3.5">
        {/* 选片核心操作组 */}
        <div className="flex items-center gap-1 rounded-md border border-white/[0.06] bg-ink-950/65 p-0.5">
          <Button
            variant={photo?.isSelected ? "primary" : "ghost"}
            size="sm"
            icon={Star}
            data-testid="select-button"
            aria-pressed={photo?.isSelected ?? false}
            aria-keyshortcuts="F"
            disabled={!photo || markDisabled}
            title={markDisabled ? markDisabledReason : "精选 / 取消精选 (F)"}
            onClick={onToggleSelected}
          >
            精选
            <kbd className={cx("hidden sm:inline-flex", photo?.isSelected ? "kbd-hint-dark" : "kbd-hint")}>F</kbd>
          </Button>
          <Button
            variant={photo?.isPendingDelete ? "danger" : "ghost"}
            size="sm"
            icon={Trash2}
            data-testid="pending-delete-button"
            aria-pressed={photo?.isPendingDelete ?? false}
            aria-keyshortcuts="X Delete"
            disabled={!photo || markDisabled}
            title={markDisabled ? markDisabledReason : "标记待删除 / 取消 (X 或 Delete)"}
            onClick={onTogglePendingDelete}
          >
            待删除
            <kbd className="kbd-hint hidden sm:inline-flex">X</kbd>
          </Button>
          <span className="mx-0.5 h-4 w-px bg-white/[0.08]" aria-hidden="true" />
          <Button
            variant="ghost"
            size="sm"
            icon={photo?.isViewed ? Eye : EyeOff}
            aria-keyshortcuts="U"
            aria-pressed={photo?.isViewed ?? false}
            disabled={!photo}
            title="切换已浏览 / 未浏览 (U) "
            onClick={onToggleViewed}
          >
            {photo?.isViewed ? "已浏览" : "未浏览"}
            <kbd className="kbd-hint hidden md:inline-flex">U</kbd>
          </Button>
        </div>

        {/* 自动播放控制组 */}
        <div className="flex items-center gap-1.5 rounded-md border border-white/[0.06] bg-ink-950/65 p-0.5 pr-1.5">
          <IconButton
            label={playing ? "暂停自动播放 (空格)" : "自动播放 (空格)"}
            icon={playing ? Pause : Play}
            variant="ghost"
            size="sm"
            active={playing}
            aria-keyshortcuts="Space"
            onClick={onTogglePlayback}
          />
          <Select
            label="间隔"
            hideLabel={false}
            aria-label="自动播放间隔"
            value={String(autoplayInterval)}
            onChange={(event) => {
              const value = Number(event.target.value);
              if (value === 2 || value === 3 || value === 5 || value === 10) onAutoplayIntervalChange(value);
            }}
            wrapperClassName="[&>span:first-child]:hidden"
            className="h-6 min-w-[66px] border-0 bg-transparent shadow-none"
          >
            <option value="2">2 秒</option>
            <option value="3">3 秒</option>
            <option value="5">5 秒</option>
            <option value="10">10 秒</option>
          </Select>
        </div>

        {/* 放大镜缩放、全屏与信息栏切换组 */}
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <div className="flex items-center gap-0.5 rounded-md border border-white/[0.06] bg-ink-950/65 p-0.5">
            <Button
              variant={zoomMode === "fit" ? "secondary" : "ghost"}
              size="sm"
              disabled={!photo}
              title="适应屏幕"
              aria-pressed={zoomMode === "fit"}
              data-testid="fit-button"
              onClick={handleFit}
            >
              适应
            </Button>
            <Button
              variant={zoomMode === "actual" ? "secondary" : "ghost"}
              size="sm"
              disabled={!photo}
              title="以 100% 查看（使用原图预览）"
              aria-pressed={zoomMode === "actual"}
              data-testid="actual-size-button"
              onClick={handleActual}
              className="font-mono"
            >
              100%
            </Button>
            <span className="mx-0.5 h-4 w-px bg-white/[0.08]" aria-hidden="true" />
            <IconButton label="缩小" icon={ZoomOut} size="sm" disabled={!photo || zoom <= 1.01} onClick={handleZoomOut} />
            <IconButton label="放大" icon={ZoomIn} size="sm" disabled={!photo} onClick={handleZoomIn} />
          </div>

          <div className="flex items-center gap-1 rounded-md border border-white/[0.06] bg-ink-950/65 p-0.5">
            <IconButton
              label={fullscreen ? "退出全屏 (Esc) " : "全屏查看"}
              icon={fullscreen ? Minimize2 : Maximize2}
              size="sm"
              aria-keyshortcuts="Escape"
              onClick={() => void toggleFullscreen()}
            />
            <IconButton
              label={infoOpen ? "隐藏照片信息 (I) " : "显示照片信息 (I) "}
              icon={infoOpen ? PanelRightClose : PanelRightOpen}
              size="sm"
              active={infoOpen}
              aria-keyshortcuts="I"
              data-testid="info-button"
              onClick={onToggleInfo}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
