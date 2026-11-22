import type { ReactNode } from "react";
import {
  FolderOpen,
  ImageOff,
  PanelRightClose,
  RefreshCw,
  Star,
  Trash2,
  Eye,
  EyeOff,
} from "lucide-react";
import type { Asset, Photo, PhotoDetailResponse } from "../../lib/api";
import {
  formatAperture,
  formatBytes,
  formatCaptureTime,
  formatDimensions,
  formatFocalLength,
} from "../../lib/format";
import { cx } from "../../lib/cx";
import { Button, IconButton } from "../ui/Button";
import { ErrorState, Skeleton } from "../ui/StateViews";
import { PhotoFlagChips, SelectionChip, ViewedChip } from "../StatusChips";

interface InfoPanelProps {
  photo: Photo | null;
  detail: PhotoDetailResponse | undefined;
  detailLoading: boolean;
  detailError: unknown;
  onRetryDetail: () => void;
  onToggleInfo: () => void;
  onToggleViewed: () => void;
  onToggleSelected: () => void;
  onTogglePendingDelete: () => void;
  markDisabled: boolean;
  markDisabledReason?: string;
  selectedAssetId: string | null;
  onSelectAsset: (assetId: string | null) => void;
  onRevealAsset: (assetId: string) => void;
  revealingAssetId: string | null;
  className?: string;
}

function InfoSection({ title, children, hint }: { title: string; children: ReactNode; hint?: string }) {
  return (
    <section className="border-t border-white/[0.06] pt-4 first:border-t-0 first:pt-0">
      <div className="mb-2.5 flex items-baseline justify-between gap-2">
        <h3 className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-400">{title}</h3>
        {hint ? <span className="font-mono text-[10px] text-ink-500">{hint}</span> : null}
      </div>
      {children}
    </section>
  );
}

function ExifRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5">
      <dt className="shrink-0 text-[11px] text-ink-500">{label}</dt>
      <dd
        className={cx(
          "min-w-0 break-words text-right text-[11px] text-ink-200",
          mono && "font-mono tabular-nums",
        )}
      >
        {value || "未知"}
      </dd>
    </div>
  );
}

function ExposureCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col items-center justify-center px-1 py-2 text-center">
      <span className="font-mono text-[9px] uppercase tracking-[0.12em] text-ink-500">{label}</span>
      <span className="mt-1 truncate font-mono text-[11px] font-semibold tabular-nums text-ink-100" title={value}>
        {value || "—"}
      </span>
    </div>
  );
}

function assetSummary(asset: Asset): string {
  const size = formatBytes(asset.sizeBytes);
  return `${asset.extension.replace(/^\./, "").toUpperCase()} · ${size}`;
}

export function InfoPanel({
  photo,
  detail,
  detailLoading,
  detailError,
  onRetryDetail,
  onToggleInfo,
  onToggleViewed,
  onToggleSelected,
  onTogglePendingDelete,
  markDisabled,
  markDisabledReason,
  selectedAssetId,
  onSelectAsset,
  onRevealAsset,
  revealingAssetId,
  className,
}: InfoPanelProps) {
  if (!photo) return null;
  const exif = detail?.photo.exif ?? photo.exif ?? {};
  const hasExif = Object.keys(exif).length > 0;
  const presentAssets = photo.assets.filter((asset) => asset.presenceStatus === "present");
  const camera = [exif.cameraMake, exif.cameraModel].filter(Boolean).join(" ");
  const isConflict = photo.flags.pairingConflict || photo.pairingStatus === "conflict";

  const focalDisplay = formatFocalLength(exif.focalLength);
  const apertureDisplay = formatAperture(exif.aperture);
  const shutterDisplay = exif.exposureTime ?? "—";
  const isoDisplay = exif.iso ? `${exif.iso}` : "—";

  return (
    <aside
      data-testid="info-panel"
      aria-label="照片信息"
      className={cx(
        "flex w-[min(340px,100vw)] max-w-full shrink-0 flex-col border-l border-white/[0.08] bg-ink-900",
        className,
      )}
    >
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-white/[0.07] bg-ink-950/50 px-3.5">
        <div className="flex items-center gap-2">
          <h2 className="text-[11px] font-semibold tracking-[0.06em] text-ink-200">照片信息</h2>
          <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-ink-500">INSPECTOR</span>
        </div>
        <IconButton label="隐藏照片信息 (I) " icon={PanelRightClose} size="sm" onClick={onToggleInfo} />
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {/* 文件标题与状态总览 */}
        <div>
          <p className="break-all font-mono text-[13px] font-medium leading-snug text-ink-100">{photo.displayName}</p>
          <p className="mt-1 text-[11px] text-ink-500">{photo.albumName ?? "当前相册"}</p>
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            <ViewedChip status={photo.viewedStatus} />
            <SelectionChip status={photo.selectionStatus} />
            <PhotoFlagChips photo={photo} />
          </div>
        </div>

        {/* 相机肩屏式核心曝光参数条 */}
        {!detailLoading && !detailError ? (
          <div className="grid grid-cols-4 divide-x divide-white/[0.06] overflow-hidden rounded-lg border border-white/[0.08] bg-ink-950/90 shadow-[inset_0_1px_2px_rgba(0,0,0,0.5)]">
            <ExposureCell label="焦距" value={focalDisplay === "未知" ? "—" : focalDisplay} />
            <ExposureCell label="光圈" value={apertureDisplay === "未知" ? "—" : apertureDisplay} />
            <ExposureCell label="快门" value={shutterDisplay} />
            <ExposureCell label="ISO" value={isoDisplay} />
          </div>
        ) : null}

        <InfoSection title="状态" hint="两个独立维度">
          <div className="space-y-2.5 rounded-lg border border-white/[0.06] bg-ink-950/45 p-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] text-ink-400">浏览</span>
              <div className="flex items-center gap-1.5">
                <ViewedChip status={photo.viewedStatus} />
                <Button
                  variant="ghost"
                  size="sm"
                  icon={photo.isViewed ? EyeOff : Eye}
                  title="切换已浏览 / 未浏览 (U) "
                  onClick={onToggleViewed}
                >
                  {photo.isViewed ? "标为未浏览" : "标为已浏览"}
                </Button>
              </div>
            </div>
            <div className="border-t border-white/[0.05] pt-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] text-ink-400">筛选</span>
                <div className="flex flex-wrap items-center justify-end gap-1.5">
                  <Button
                    variant={photo.isSelected ? "primary" : "secondary"}
                    size="sm"
                    icon={Star}
                    disabled={markDisabled}
                    title={markDisabled ? markDisabledReason : "精选 / 取消精选 (F) "}
                    aria-pressed={photo.isSelected}
                    onClick={onToggleSelected}
                  >
                    精选
                    <kbd className={photo.isSelected ? "kbd-hint-dark" : "kbd-hint"}>F</kbd>
                  </Button>
                  <Button
                    variant={photo.isPendingDelete ? "danger" : "secondary"}
                    size="sm"
                    icon={Trash2}
                    disabled={markDisabled}
                    title={markDisabled ? markDisabledReason : "标记待删除 / 取消 (X 或 Delete) "}
                    aria-pressed={photo.isPendingDelete}
                    onClick={onTogglePendingDelete}
                  >
                    待删除
                    <kbd className="kbd-hint">X</kbd>
                  </Button>
                </div>
              </div>
            </div>
            {markDisabled && markDisabledReason ? (
              <p className="rounded border border-amber-400/25 bg-amber-500/[0.07] px-2 py-1.5 text-[11px] leading-relaxed text-amber-200">
                {markDisabledReason}
              </p>
            ) : null}
          </div>
        </InfoSection>

        <InfoSection title="文件" hint={`${photo.fileCount} 个 · ${formatBytes(photo.totalBytes)}`}>
          {isConflict ? (
            <p className="mb-2.5 rounded-md border border-amber-400/25 bg-amber-500/[0.07] px-2.5 py-2 text-[11px] leading-relaxed text-amber-200">
              此组存在配对冲突。以下文件仅供只读预览，预览不会解除冲突，也不会启用清理或导出。
            </p>
          ) : null}
          <ul className="space-y-2">
            {photo.assets.map((asset) => {
              const missing = asset.presenceStatus === "missing";
              const selectable = !missing && photo.assets.length > 1 && isConflict;
              const selected = selectedAssetId === asset.id;
              return (
                <li
                  key={asset.id}
                  className={cx(
                    "rounded-md border px-2.5 py-2 transition-colors",
                    missing
                      ? "border-red-400/25 bg-red-500/[0.06]"
                      : selected
                        ? "border-accent-400/45 bg-accent-500/[0.08]"
                        : "border-white/[0.07] bg-ink-950/60 hover:border-white/[0.12]",
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="inline-flex items-center gap-1.5">
                      <span
                        className={cx(
                          "rounded-[3px] border px-1 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-[0.06em]",
                          asset.kind === "jpg"
                            ? "border-sky-400/30 bg-sky-500/12 text-sky-300"
                            : "border-accent-400/35 bg-accent-500/12 text-accent-300",
                        )}
                      >
                        {asset.kind}
                      </span>
                      <span className="font-mono text-[11px] tabular-nums text-ink-300">{assetSummary(asset)}</span>
                    </span>
                    {missing ? (
                      <span className="inline-flex items-center gap-1 text-[10px] text-red-300">
                        <ImageOff className="h-3 w-3" aria-hidden="true" /> 缺失
                      </span>
                    ) : (
                      <button
                        type="button"
                        aria-label={`在 Finder 中显示 ${asset.originalFilename}`}
                        title="在 Finder 中显示"
                        disabled={revealingAssetId === asset.id}
                        onClick={() => onRevealAsset(asset.id)}
                        className="rounded p-1 text-ink-400 transition-colors hover:bg-white/[0.08] hover:text-ink-100 disabled:opacity-50"
                      >
                        <FolderOpen className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                    )}
                  </div>
                  <p className="mt-1 break-all font-mono text-[10px] leading-relaxed text-ink-500">{asset.relativePath}</p>
                  <div className="mt-1.5 flex items-center justify-between gap-2">
                    <span className="truncate font-mono text-[10px] text-ink-600">{asset.originalFilename}</span>
                    {selectable ? (
                      <button
                        type="button"
                        aria-pressed={selected}
                        onClick={() => onSelectAsset(selected ? null : asset.id)}
                        className={cx(
                          "shrink-0 rounded border px-1.5 py-0.5 text-[10px] transition-colors",
                          selected
                            ? "border-accent-400/45 bg-accent-500/15 text-accent-300"
                            : "border-white/10 text-ink-400 hover:bg-white/[0.06] hover:text-ink-200",
                        )}
                      >
                        {selected ? "正在预览此文件" : "只读预览此文件"}
                      </button>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
          {selectedAssetId ? (
            <button
              type="button"
              className="mt-2 text-[11px] font-medium text-accent-300 hover:underline"
              onClick={() => onSelectAsset(null)}
            >
              切换回主文件预览
            </button>
          ) : null}
          {presentAssets.length === 0 ? (
            <p className="mt-2 rounded-md border border-red-400/25 bg-red-500/[0.06] px-2.5 py-2 text-[11px] text-red-200">
              该照片的所有文件均已缺失。请重新扫描，或到异常中心查看路径。
            </p>
          ) : null}
        </InfoSection>

        <InfoSection title="EXIF" hint="METADATA">
          {detailLoading ? (
            <div className="space-y-2" aria-label="正在读取 EXIF">
              {[0, 1, 2, 3].map((row) => (
                <Skeleton key={row} className="h-4 w-full" />
              ))}
            </div>
          ) : detailError ? (
            <ErrorState
              error={detailError}
              compact
              title="照片详情读取失败"
              onRetry={onRetryDetail}
              retryLabel="重新读取"
            />
          ) : (
            <>
              <dl className="divide-y divide-white/[0.05]">
                <ExifRow label="拍摄时间" value={formatCaptureTime(exif.captureTime ?? photo.captureTime)} mono />
                <ExifRow label="相机" value={camera || "未知"} />
                <ExifRow label="镜头" value={exif.lensModel ?? "未知"} />
                <ExifRow label="焦距" value={focalDisplay} mono />
                <ExifRow label="光圈" value={apertureDisplay} mono />
                <ExifRow label="快门" value={exif.exposureTime ?? "未知"} mono />
                <ExifRow label="ISO" value={exif.iso ? String(exif.iso) : "未知"} mono />
                <ExifRow label="尺寸" value={formatDimensions(exif.width, exif.height)} mono />
                <ExifRow
                  label="文件形态"
                  value={
                    photo.form === "jpg_raw"
                      ? "JPG+RAW"
                      : photo.form === "jpg_only"
                        ? "仅 JPG"
                        : photo.form === "raw_only"
                          ? "仅 RAW"
                          : "未知"
                  }
                  mono
                />
                <ExifRow label="文件大小" value={formatBytes(photo.totalBytes)} mono />
              </dl>
              {!hasExif ? (
                <p className="mt-2.5 flex items-center gap-1.5 text-[10px] text-ink-500">
                  <RefreshCw className="h-3 w-3" aria-hidden="true" />
                  未读取到 EXIF 信息，照片仍可正常浏览。
                </p>
              ) : null}
            </>
          )}
        </InfoSection>
      </div>
    </aside>
  );
}
