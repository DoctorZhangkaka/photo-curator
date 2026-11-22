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

const ITEM_SIZE = 104;

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
    <section aria-label="胶片栏" className="shrink-0 border-t border-white/[0.08] bg-ink-950">
      {/* 极细 35mm 胶片齿孔装饰轨 */}
      <div className="film-sprocket-rail h-[3px] w-full opacity-45" aria-hidden="true" />

      <div className="flex items-center justify-between gap-2 bg-ink-900/70 px-3 py-1 text-[10px] text-ink-500">
        <span className="flex items-center gap-2 font-mono tabular-nums tracking-[0.04em]">
          <span className="uppercase text-ink-400">胶片栏</span>
          <span className="text-ink-700">·</span>
          <span>
            已载入 {photos.length} / {total} 张
          </span>
        </span>
        <div className="flex items-center gap-2">
          {hasNextPage ? (
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded border border-white/[0.08] bg-white/[0.03] px-2 py-0.5 text-[10px] font-medium text-ink-300 transition-colors hover:border-white/[0.16] hover:bg-white/[0.07] hover:text-ink-100 disabled:opacity-50"
              onClick={() => void onLoadMore()}
              disabled={isFetchingNextPage}
            >
              {isFetchingNextPage ? <Loader2 className="h-2.5 w-2.5 animate-spin" aria-hidden="true" /> : null}
              {isFetchingNextPage ? "载入中..." : "加载更多"}
            </button>
          ) : (
            <span className="font-mono text-[10px] text-ink-600">全部照片已载入</span>
          )}
        </div>
      </div>

      <div className="relative bg-[#080809]">
        <button
          type="button"
          aria-label="上一批缩略图"
          title="向左翻一批缩略图"
          data-testid="filmstrip-prev-batch"
          disabled={!canPreviousBatch || batchLoading}
          onClick={() => void scrollBatch(-1)}
          className="absolute left-1.5 top-1/2 z-20 flex h-14 w-6 -translate-y-1/2 items-center justify-center rounded-md border border-white/[0.12] bg-ink-950/88 text-ink-300 shadow-lg backdrop-blur-md transition-all hover:border-white/25 hover:bg-ink-800 hover:text-white disabled:pointer-events-none disabled:opacity-15"
        >
          <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label="下一批缩略图"
          title="向右翻一批缩略图"
          data-testid="filmstrip-next-batch"
          disabled={!canNextBatch || batchLoading}
          onClick={() => void scrollBatch(1)}
          className="absolute right-1.5 top-1/2 z-20 flex h-14 w-6 -translate-y-1/2 items-center justify-center rounded-md border border-white/[0.12] bg-ink-950/88 text-ink-300 shadow-lg backdrop-blur-md transition-all hover:border-white/25 hover:bg-ink-800 hover:text-white disabled:pointer-events-none disabled:opacity-15"
        >
          <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
        </button>

        <div
          ref={parentRef}
          data-testid="filmstrip"
          role="listbox"
          aria-label="照片胶片栏"
          aria-orientation="horizontal"
          className="no-scrollbar h-[92px] overflow-x-auto overflow-y-hidden px-3 sm:h-[104px]"
        >
          <div className="relative h-full" style={{ width: `${virtualizer.getTotalSize()}px` }}>
            {virtualItems.map((virtualItem) => {
              const photo = photos[virtualItem.index];
              if (!photo) return null;
              const active = virtualItem.index === currentIndex;
              const frameNo = String(virtualItem.index + 1).padStart(2, "0");
              const label = [
                `第 ${virtualItem.index + 1} 张`,
                photo.displayName,
                VIEWED_LABELS[photo.viewedStatus],
                SELECTION_LABELS[photo.selectionStatus],
                photo.flags.pairingConflict ? "配对冲突" : "",
                photo.flags.missingFile ? "文件缺失" : "",
              ]
                .filter(Boolean)
                .join(", ");
              return (
                <div
                  key={photo.id}
                  className="absolute left-0 top-0 h-full px-1 py-2"
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
                      "group relative block h-full w-full overflow-hidden rounded-[6px] border bg-black text-left transition-all duration-150",
                      "focus-visible:outline focus-visible:outline-[1.5px] focus-visible:outline-offset-1 focus-visible:outline-accent-400",
                      active
                        ? "border-accent-400 shadow-darkroom-glow"
                        : photo.isPendingDelete
                          ? "border-red-500/35 opacity-60 hover:opacity-95"
                          : "border-white/[0.09] opacity-75 hover:border-white/30 hover:opacity-100",
                    )}
                  >
                    <ImageOff
                      className="absolute inset-0 m-auto h-4 w-4 text-ink-600"
                      aria-hidden="true"
                    />
                    <img
                      src={photo.thumbnailUrl}
                      alt={photo.displayName}
                      loading="lazy"
                      decoding="async"
                      draggable={false}
                      className={cx(
                        "relative h-full w-full object-cover transition-transform duration-300",
                        !active && "group-hover:scale-[1.03]",
                      )}
                      onError={(event) => {
                        event.currentTarget.style.opacity = "0";
                      }}
                    />

                    {/* 左上角精选/待删标记 */}
                    {photo.isSelected || photo.isPendingDelete ? (
                      <span
                        className={cx(
                          "absolute left-1 top-1 flex h-4 w-4 items-center justify-center rounded-[4px] border backdrop-blur-md",
                          photo.isPendingDelete
                            ? "border-red-400/45 bg-red-950/85 text-red-300"
                            : "border-accent-400/50 bg-ink-950/85 text-accent-300",
                        )}
                      >
                        {photo.isPendingDelete ? (
                          <Trash2 className="h-2.5 w-2.5" aria-hidden="true" />
                        ) : (
                          <Star className="h-2.5 w-2.5 fill-current" aria-hidden="true" />
                        )}
                      </span>
                    ) : null}

                    {/* 右上角冲突/缺失警示 */}
                    {photo.flags.pairingConflict || photo.flags.missingFile ? (
                      <span
                        className={cx(
                          "absolute right-1 top-1 flex h-4 w-4 items-center justify-center rounded-[4px] border bg-ink-950/90 backdrop-blur-md",
                          photo.flags.missingFile
                            ? "border-red-400/45 text-red-300"
                            : "border-amber-400/45 text-amber-300",
                        )}
                        title={photo.flags.missingFile ? "文件缺失" : "配对冲突"}
                      >
                        {photo.flags.missingFile ? (
                          <FileX className="h-2.5 w-2.5" aria-hidden="true" />
                        ) : (
                          <AlertTriangle className="h-2.5 w-2.5" aria-hidden="true" />
                        )}
                      </span>
                    ) : null}

                    {/* 底部暗角 + 胶片帧号与未浏览指示点 */}
                    <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-between bg-gradient-to-t from-black/80 via-black/30 to-transparent px-1.5 pb-1 pt-3">
                      {!photo.isViewed ? (
                        <span
                          className="h-1.5 w-1.5 rounded-full bg-sky-300 shadow-[0_0_5px_rgba(125,211,252,0.85)]"
                          title="未浏览"
                        />
                      ) : (
                        <span />
                      )}
                      <span
                        className={cx(
                          "font-mono text-[9px] tabular-nums leading-none",
                          active ? "font-semibold text-accent-300" : "text-ink-300/80",
                        )}
                      >
                        {frameNo}
                      </span>
                    </div>

                    {/* 当前帧底部高光条 */}
                    {active ? (
                      <span
                        aria-hidden="true"
                        className="pointer-events-none absolute inset-x-0 bottom-0 h-[2px] bg-accent-400"
                      />
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
