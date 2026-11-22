import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { ImageOff } from "lucide-react";
import { cx } from "../../lib/cx";

interface HoverPreviewProps {
  thumbnailUrl: string;
  previewUrl: string;
  alt: string;
  caption?: string;
  className?: string;
  testId?: string;
}

interface PreviewPosition {
  left: number;
  top: number;
  width: number;
}

const POPUP_MAX_WIDTH = 560;
const POPUP_MARGIN = 12;

function placePreview(anchor: DOMRect): PreviewPosition {
  const width = Math.min(POPUP_MAX_WIDTH, window.innerWidth - POPUP_MARGIN * 2);
  const estimatedHeight = Math.min(window.innerHeight * 0.7, width * 0.78 + 48);
  let left = anchor.right + 12;
  if (left + width > window.innerWidth - POPUP_MARGIN) {
    left = anchor.left - width - 12;
  }
  left = Math.max(POPUP_MARGIN, Math.min(left, window.innerWidth - width - POPUP_MARGIN));
  const centeredTop = anchor.top + anchor.height / 2 - estimatedHeight / 2;
  const top = Math.max(
    POPUP_MARGIN,
    Math.min(centeredTop, window.innerHeight - estimatedHeight - POPUP_MARGIN),
  );
  return { left, top, width };
}

/**
 * 缩略图 + 悬浮放大预览。
 *
 * 预览通过 portal 渲染，避免被弹窗的滚动容器裁切；只使用同源媒体端点，
 * 不读写任意路径。点击、键盘聚焦同样可以打开，鼠标离开或失焦关闭。
 */
export function HoverPreview({
  thumbnailUrl,
  previewUrl,
  alt,
  caption,
  className,
  testId,
}: HoverPreviewProps) {
  const anchorRef = useRef<HTMLButtonElement>(null);
  const closeTimer = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<PreviewPosition | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);

  const clearCloseTimer = useCallback(() => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);

  const show = useCallback(() => {
    clearCloseTimer();
    const anchor = anchorRef.current;
    if (!anchor) return;
    setLoaded(false);
    setFailed(false);
    setPosition(placePreview(anchor.getBoundingClientRect()));
    setOpen(true);
  }, [clearCloseTimer]);

  const hide = useCallback(() => {
    clearCloseTimer();
    closeTimer.current = window.setTimeout(() => setOpen(false), 90);
  }, [clearCloseTimer]);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  useEffect(() => () => clearCloseTimer(), [clearCloseTimer]);

  function handleClick(event: MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    show();
  }

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className={cx(
          "group relative block h-16 w-16 shrink-0 overflow-hidden rounded-lg border border-white/10 bg-black",
          "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-400",
          "hover:border-accent-500/60",
          className,
        )}
        aria-label={`放大预览 ${alt}`}
        title="悬浮或点击查看大图"
        data-testid={testId}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        onClick={handleClick}
      >
        <ImageOff className="absolute inset-0 m-auto h-4 w-4 text-ink-600" aria-hidden="true" />
        <img
          src={thumbnailUrl}
          alt={alt}
          loading="lazy"
          decoding="async"
          draggable={false}
          className="relative h-full w-full object-cover transition-transform duration-200 group-hover:scale-105"
        />
        <span className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 to-transparent px-1 pb-0.5 pt-2 text-[9px] text-ink-200">
          预览
        </span>
      </button>
      {open && position
        ? createPortal(
            <div
              role="tooltip"
              aria-label={`${alt} 放大预览`}
              data-testid={testId ? `${testId}-preview` : undefined}
              className="pointer-events-none fixed z-[120] rounded-xl border border-white/15 bg-ink-950/95 p-1.5 shadow-2xl shadow-black/70 backdrop-blur-sm"
              style={{ left: position.left, top: position.top, width: position.width }}
            >
              <div className="relative flex min-h-[120px] max-h-[70vh] items-center justify-center overflow-hidden rounded-lg bg-black">
                {!loaded && !failed ? <span className="text-[11px] text-ink-400">正在加载预览…</span> : null}
                {failed ? (
                  <span className="flex flex-col items-center gap-1 px-4 py-6 text-center text-[11px] text-ink-400">
                    <ImageOff className="h-5 w-5" aria-hidden="true" />
                    预览加载失败，文件可能已变化。
                  </span>
                ) : (
                  <img
                    src={previewUrl}
                    alt={alt}
                    draggable={false}
                    className={cx(
                      "max-h-[70vh] w-auto max-w-full object-contain",
                      loaded ? "opacity-100" : "opacity-0",
                    )}
                    onLoad={() => setLoaded(true)}
                    onError={() => setFailed(true)}
                  />
                )}
              </div>
              {caption ? (
                <p className="truncate px-1.5 pb-0.5 pt-1.5 font-mono text-[10px] text-ink-400">
                  {caption}
                </p>
              ) : null}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
