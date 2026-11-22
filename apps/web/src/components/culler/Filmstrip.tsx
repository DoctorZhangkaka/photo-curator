import { useCallback, useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { AlertTriangle, ChevronLeft, ChevronRight, FileX, ImageOff, Loader2, Star, Trash2 } from "lucide-react";
import type { Photo } from "../../lib/api";
import { SELECTION_LABELS, VIEWED_LABELS } from "../../lib/labels";
import { cx } from "../../lib/cx";

interface FilmstripProps {
  photos: Photo[];
  total: number;
  currentIndex: number;
  onSelect: (index: number) => void;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  onLoadMore: () => Promise<void> | void;
}

const ITEM_SIZE = 102;

export function Filmstrip({
  photos,
  total,
  currentIndex,
  onSelect,
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
}: FilmstripProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  const [atStart, setAtStart] = useState(true);
  const [atEnd, setAtEnd] = useState(false);
  const [batchLoading, setBatchLoading] = useState(false);
  const virtualizer = useVirtualizer({
    count: photos.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ITEM_SIZE,
    horizontal: true,
    overscan: 6,
    // 首屏在测量前也能渲染出可视项；浏览器挂载后会由 ResizeObserver 修正。
    initialRect: { width: 1400, height: 100 },
  });

  const updateScrollState = useCallback(() => {
    const element = parentRef.current;
    if (!element) return;
    setAtStart(element.scrollLeft <= 4);
    setAtEnd(element.scrollLeft + element.clientWidth >= element.scrollWidth - 4);
  }, []);

  useEffect(() => {
    const element = parentRef.current;
    if (!element) return;
    element.addEventListener("scroll", updateScrollState, { passive: true });
    window.addEventListener("resize", updateScrollState);
    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(updateScrollState);
      observer.observe(element);
    }
    return () => {
      element.removeEventListener("scroll", updateScrollState);
      window.removeEventListener("resize", updateScrollState);
      observer?.disconnect();
    };
  }, [updateScrollState]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(updateScrollState);
    return () => window.cancelAnimationFrame(frame);
  }, [photos.length, updateScrollState]);

  // 只在当前照片变化时居中；加载下一批缩略图不应该把视口拉回当前照片。
  useEffect(() => {
    if (photos.length === 0) return;
    const target = Math.min(Math.max(currentIndex, 0), photos.length - 1);
    virtualizer.scrollToIndex(target, { align: "center" });
  }, [currentIndex, virtualizer]);

  async function scrollBatch(direction: 1 | -1) {
    const element = parentRef.current;
    if (!element || batchLoading) return;
    const amount = Math.max(ITEM_SIZE * 4, Math.floor(element.clientWidth * 0.8));
    const nearEnd = element.scrollLeft + element.clientWidth >= element.scrollWidth - 8;
    setBatchLoading(true);
    try {
      if (direction > 0 && nearEnd && hasNextPage && !isFetchingNextPage) {
        await onLoadMore();
        await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      }
      element.scrollBy({ left: amount * direction, behavior: "smooth" });
    } finally {
      setBatchLoading(false);
      window.setTimeout(updateScrollState, 0);
    }
  }

  const canPreviousBatch = !atStart;
  const canNextBatch = !atEnd || hasNextPage;
  const virtualItems = virtualizer.getVirtualItems();

  return (
    <section aria-label="胶片栏" className="shrink-0 border-t border-white/[0.07] bg-ink-900/95">
      <div className="flex items-center justify-between gap-2 px-3 py-1.5 text-[11px] text-ink-500">
        <span className="tabular-nums">
          胶片栏 · 已载入 {photos.length} / {total} 张
        </span>
        <div className="flex items-center gap-2">
          {hasNextPage ? (
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-ink-300 hover:bg-white/[0.06] hover:text-ink-100 disabled:opacity-50"
              onClick={() => void onLoadMore()}
              disabled={isFetchingNextPage}
            >
              {isFetchingNextPage ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" /> : null}
              {isFetchingNextPage ? "载入中…" : "加载更多"}
            </button>
          ) : (
            <span>全部照片已载入</span>
          )}
        </div>
      </div>
      <div className="relative">
        <button
          type="button"
          aria-label="上一批缩略图"
          title="向左翻一批缩略图"
          data-testid="filmstrip-prev-batch"
          disabled={!canPreviousBatch || batchLoading}
          onClick={() => void scrollBatch(-1)}
          className="absolute left-1 top-1/2 z-20 flex h-16 w-7 -translate-y-1/2 items-center justify-center rounded-full border border-white/10 bg-ink-950/80 text-ink-300 shadow-lg backdrop-blur-sm transition-colors hover:bg-ink-800 hover:text-white disabled:pointer-events-none disabled:opacity-20"
        >
          <ChevronLeft className="h-4 w-4" aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label="下一批缩略图"
          title="向右翻一批缩略图"
          data-testid="filmstrip-next-batch"
          disabled={!canNextBatch || batchLoading}
          onClick={() => void scrollBatch(1)}
          className="absolute right-1 top-1/2 z-20 flex h-16 w-7 -translate-y-1/2 items-center justify-center rounded-full border border-white/10 bg-ink-950/80 text-ink-300 shadow-lg backdrop-blur-sm transition-colors hover:bg-ink-800 hover:text-white disabled:pointer-events-none disabled:opacity-20"
        >
          <ChevronRight className="h-4 w-4" aria-hidden="true" />
        </button>
        <div
          ref={parentRef}
          data-testid="filmstrip"
          role="listbox"
          aria-label="照片胶片栏"
          aria-orientation="horizontal"
          className="no-scrollbar h-[88px] overflow-x-auto overflow-y-hidden px-2 sm:h-[100px]"
        >
        <div className="relative h-full" style={{ width: `${virtualizer.getTotalSize()}px` }}>
          {virtualItems.map((virtualItem) => {
            const photo = photos[virtualItem.index];
            if (!photo) return null;
            const active = virtualItem.index === currentIndex;
            const label = [
              `第 ${virtualItem.index + 1} 张`,
              photo.displayName,
              VIEWED_LABELS[photo.viewedStatus],
              SELECTION_LABELS[photo.selectionStatus],
              photo.flags.pairingConflict ? "配对冲突" : "",
              photo.flags.missingFile ? "文件缺失" : "",
            ]
              .filter(Boolean)
              .join("，");
            return (
              <div
                key={photo.id}
                className="absolute left-0 top-0 h-full p-1.5"
                style={{ width: `${virtualItem.size}px`, transform: `translateX(${virtualItem.start}px)` }}
              >
                <button
                  type="button"
                  role="option"
                  aria-selected={active}
                  aria-label={label}
                  title={photo.displayName}
                  data-testid="filmstrip-item"
                  data-photo-id={photo.id}
                  onClick={() => onSelect(virtualItem.index)}
                  className={cx(
                    "group relative block h-full w-full overflow-hidden rounded-lg border bg-black text-left transition-colors",
                    "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-400",
                    active
                      ? "border-accent-500 ring-1 ring-accent-500/50"
                      : "border-white/10 hover:border-white/30",
                  )}
                >
                  <ImageOff
                    className="absolute inset-0 m-auto h-5 w-5 text-ink-600"
                    aria-hidden="true"
                  />
                  <img
                    src={photo.thumbnailUrl}
                    alt={photo.displayName}
                    loading="lazy"
                    decoding="async"
                    draggable={false}
                    className="relative h-full w-full object-cover"
                    onError={(event) => {
                      event.currentTarget.style.opacity = "0";
                    }}
                  />
                  {photo.isSelected || photo.isPendingDelete ? (
                    <span
                      className={cx(
                        "absolute left-1 top-1 flex h-5 w-5 items-center justify-center rounded-md border backdrop-blur-sm",
                        photo.isPendingDelete
                          ? "border-red-400/40 bg-red-950/80 text-red-300"
                          : "border-accent-400/40 bg-ink-950/80 text-accent-400",
                      )}
                    >
                      {photo.isPendingDelete ? (
                        <Trash2 className="h-3 w-3" aria-hidden="true" />
                      ) : (
                        <Star className="h-3 w-3 fill-current" aria-hidden="true" />
                      )}
                    </span>
                  ) : null}
                  {photo.flags.pairingConflict || photo.flags.missingFile ? (
                    <span
                      className={cx(
                        "absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-md border bg-ink-950/85 backdrop-blur-sm",
                        photo.flags.missingFile
                          ? "border-red-400/40 text-red-300"
                          : "border-amber-400/40 text-amber-300",
                      )}
                      title={photo.flags.missingFile ? "文件缺失" : "配对冲突"}
                    >
                      {photo.flags.missingFile ? (
                        <FileX className="h-3 w-3" aria-hidden="true" />
                      ) : (
                        <AlertTriangle className="h-3 w-3" aria-hidden="true" />
                      )}
                    </span>
                  ) : null}
                  {!photo.isViewed ? (
                    <span className="absolute bottom-1 left-1 h-1.5 w-1.5 rounded-full bg-sky-300/90" title="未浏览" />
                  ) : null}
                </button>
              </div>
            );
          })}
        </div>
        </div>
      </div>
    </section>
  );
}
