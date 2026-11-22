import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  FolderOpen,
  Images,
  RefreshCw,
  ArrowUpRight,
  ShieldAlert,
  Star,
  Trash2,
} from "lucide-react";
import {
  api,
  appendMediaParam,
  type Album,
  type AlbumResponse,
  type RescanAllResponse,
} from "../lib/api";
import { useApp } from "../context/AppContext";
import { useAlbums } from "../hooks/useApiQueries";
import { useRescanAllAlbums } from "../hooks/useMutations";
import { describeError } from "../lib/messages";
import { formatPercent, formatRelativeTime } from "../lib/format";
import { queryKeys } from "../lib/queryKeys";
import { cx } from "../lib/cx";
import { Button } from "../components/ui/Button";
import { Select } from "../components/ui/Select";
import { EmptyState, ErrorState, Skeleton } from "../components/ui/StateViews";
import { ScanStatusChip, StatusChip } from "../components/StatusChips";

function AlbumCard({
  album,
  onOpen,
  onRetry,
  retrying,
}: {
  album: Album;
  onOpen: () => void;
  onRetry: () => void;
  retrying: boolean;
}) {
  const [coverFailed, setCoverFailed] = useState(false);
  const progress = formatPercent(album.counts.viewed, album.counts.total);
  const issueCount = album.counts.missing + album.counts.conflicts;

  return (
    <article
      className="group relative flex flex-col overflow-hidden rounded-[10px] border border-white/[0.08] bg-ink-900 shadow-darkroom-card transition-all duration-200 hover:border-white/[0.18] hover:bg-ink-850/90 focus-within:border-accent-500/55"
      data-testid="album-card"
      data-album-name={album.name}
    >
      <Link
        to={`/albums/${encodeURIComponent(album.id)}`}
        aria-label={`打开相册 ${album.name}`}
        onClick={onOpen}
        className="absolute inset-0 z-10 rounded-[10px]"
      >
        <span className="sr-only">打开相册 {album.name}</span>
      </Link>

      {/* 暗房灯箱封面视窗 */}
      <div className="relative aspect-[16/10] w-full overflow-hidden bg-[#060607]">
        {album.coverThumbnailUrl && !coverFailed ? (
          <img
            src={appendMediaParam(album.coverThumbnailUrl, "updated", album.updatedAt)}
            alt={`相册封面：${album.name}`}
            loading="lazy"
            decoding="async"
            className="h-full w-full object-cover transition-transform duration-700 ease-out group-hover:scale-[1.035]"
            onError={() => setCoverFailed(true)}
          />
        ) : (
          <div className="darkroom-stage flex h-full w-full flex-col items-center justify-center gap-2 text-ink-600">
            {album.scanStatus === "failed" ? (
              <AlertCircle className="h-6 w-6 text-red-400/75" aria-hidden="true" />
            ) : (
              <Images className="h-6 w-6 text-ink-600" aria-hidden="true" />
            )}
            <span className="font-mono text-[10px] tracking-[0.06em] text-ink-500">
              {album.counts.total === 0 ? "EMPTY ROLL" : "NO PREVIEW"}
            </span>
          </div>
        )}

        {/* 取景器悬浮角标 */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-2 z-20 opacity-0 transition-opacity duration-200 group-hover:opacity-100"
        >
          <span className="absolute left-0 top-0 h-2.5 w-2.5 border-l border-t border-white/35" />
          <span className="absolute right-0 top-0 h-2.5 w-2.5 border-r border-t border-white/35" />
          <span className="absolute bottom-0 left-0 h-2.5 w-2.5 border-b border-l border-white/35" />
          <span className="absolute bottom-0 right-0 h-2.5 w-2.5 border-b border-r border-white/35" />
        </div>

        {/* 顶部状态徽标 */}
        <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex items-start justify-between gap-2 p-2.5">
          <span className="backdrop-blur-md">
            <ScanStatusChip status={album.scanStatus} />
          </span>
          {issueCount > 0 ? (
            <StatusChip icon={ShieldAlert} tone="warning" className="bg-ink-950/80 backdrop-blur-md">
              {issueCount} 项异常
            </StatusChip>
          ) : null}
        </div>

        {/* 底部暗角信息层 + 嵌入式微进度轨 */}
        {album.counts.total > 0 ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 bg-gradient-to-t from-black/85 via-black/35 to-transparent px-3 pb-2.5 pt-10">
            <div className="flex items-end justify-between gap-2">
              <span className="font-mono text-[10px] tabular-nums tracking-[0.02em] text-ink-200/90">
                已浏览 {album.counts.viewed} / {album.counts.total}
              </span>
              <span className="font-mono text-[10px] font-medium tabular-nums text-accent-300">{progress}%</span>
            </div>
            <div
              role="progressbar"
              aria-label={`${album.name} 浏览进度`}
              aria-valuemin={0}
              aria-valuemax={album.counts.total}
              aria-valuenow={album.counts.viewed}
              className="mt-1.5 h-[2px] w-full overflow-hidden rounded-full bg-white/[0.14]"
            >
              <div
                className="h-full rounded-full bg-accent-400 transition-[width] duration-300"
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>
        ) : null}
      </div>

      {/* 卡片下半部：相册元数据与暗房计数条 */}
      <div className="flex min-h-0 flex-1 flex-col gap-3 p-3.5">
        <div className="flex items-baseline justify-between gap-3">
          <h3
            className="min-w-0 truncate text-[14px] font-semibold tracking-[-0.01em] text-ink-100 transition-colors group-hover:text-white"
            title={album.name}
          >
            {album.name}
          </h3>
          <span className="shrink-0 font-mono text-[10px] text-ink-500">
            {formatRelativeTime(album.lastScannedAt)}
          </span>
        </div>

        {/* 一体化光学数据条（用细发丝分隔替代散碎嵌套框） */}
        <dl className="grid grid-cols-4 divide-x divide-white/[0.06] rounded-md border border-white/[0.06] bg-ink-950/60 py-1.5 text-center">
          <div className="px-1">
            <dt className="text-[9px] uppercase tracking-[0.06em] text-ink-500">照片</dt>
            <dd className="mt-0.5 font-mono text-xs font-medium tabular-nums text-ink-100">{album.counts.total}</dd>
          </div>
          <div className="px-1">
            <dt className="flex items-center justify-center gap-0.5 text-[9px] uppercase tracking-[0.06em] text-ink-500">
              <Star className="h-2.5 w-2.5 text-accent-400" aria-hidden="true" /> 精选
            </dt>
            <dd
              className={cx(
                "mt-0.5 font-mono text-xs font-medium tabular-nums",
                album.counts.selected > 0 ? "text-accent-300" : "text-ink-400",
              )}
            >
              {album.counts.selected}
            </dd>
          </div>
          <div className="px-1">
            <dt className="flex items-center justify-center gap-0.5 text-[9px] uppercase tracking-[0.06em] text-ink-500">
              <Trash2 className="h-2.5 w-2.5 text-red-400/80" aria-hidden="true" /> 待删
            </dt>
            <dd
              className={cx(
                "mt-0.5 font-mono text-xs font-medium tabular-nums",
                album.counts.pendingDelete > 0 ? "text-red-300" : "text-ink-400",
              )}
            >
              {album.counts.pendingDelete}
            </dd>
          </div>
          <div className="px-1">
            <dt className="text-[9px] uppercase tracking-[0.06em] text-ink-500">缺失/冲突</dt>
            <dd
              className={cx(
                "mt-0.5 font-mono text-xs font-medium tabular-nums",
                issueCount > 0 ? "text-amber-300" : "text-ink-400",
              )}
            >
              {album.counts.missing}/{album.counts.conflicts}
            </dd>
          </div>
        </dl>

        {album.scanStatus === "failed" && album.scanError ? (
          <div className="flex items-start gap-2 rounded-md border border-red-400/25 bg-red-500/[0.06] px-2.5 py-2">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-400" aria-hidden="true" />
            <p className="line-clamp-2 min-w-0 flex-1 text-[10px] leading-relaxed text-red-200">{album.scanError}</p>
            <button
              type="button"
              data-testid="album-retry"
              className="relative z-20 shrink-0 rounded border border-red-400/35 px-1.5 py-0.5 text-[10px] font-medium text-red-200 transition-colors hover:bg-red-500/20 disabled:opacity-50"
              disabled={retrying}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onRetry();
              }}
            >
              {retrying ? "重试中…" : "重试"}
            </button>
          </div>
        ) : null}

        <div className="mt-auto flex items-center justify-between gap-2 border-t border-white/[0.05] pt-2.5">
          <span className="truncate font-mono text-[10px] text-ink-500" title={album.relativePath}>
            {album.relativePath}
          </span>
          <span className="inline-flex shrink-0 items-center gap-0.5 text-[10px] font-medium text-ink-500 transition-colors group-hover:text-accent-300">
            进入暗房
            <ArrowUpRight className="h-3 w-3 transition-transform duration-150 group-hover:-translate-y-0.5 group-hover:translate-x-0.5" aria-hidden="true" />
          </span>
        </div>
      </div>
    </article>
  );
}

export default function LibraryPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { toast } = useApp();
  const [sort, setSort] = useState<"name" | "recent">("name");
  const [retryingAlbumId, setRetryingAlbumId] = useState<string | null>(null);
  const albumsQuery = useAlbums(sort);
  const rescanAllMutation = useRescanAllAlbums();

  const retryAlbumMutation = useMutation({
    mutationFn: (albumId: string) => api.rescanAlbum(albumId),
    onSuccess: (result, albumId) => {
      queryClient.setQueryData(queryKeys.album(albumId), (current: AlbumResponse | undefined) =>
        current ? { ...current, album: result.album } : current,
      );
      void queryClient.invalidateQueries({ queryKey: ["albums"] });
      if (result.error) {
        toast({ variant: "error", title: "重新扫描失败", description: result.error });
      } else {
        toast({
          variant: "success",
          title: `${result.album.name} 重新扫描完成`,
          description: `共 ${result.album.counts.total} 张逻辑照片。`,
        });
      }
    },
    onError: (error: unknown) => {
      const friendly = describeError(error);
      toast({ ...friendly, variant: "error" });
    },
    onSettled: () => setRetryingAlbumId(null),
  });

  const data = albumsQuery.data;
  const albums = data?.albums ?? [];
  const totals = albums.reduce(
    (accumulator, album) => ({
      photos: accumulator.photos + album.counts.total,
      selected: accumulator.selected + album.counts.selected,
      pending: accumulator.pending + album.counts.pendingDelete,
      issues: accumulator.issues + album.counts.missing + album.counts.conflicts,
    }),
    { photos: 0, selected: 0, pending: 0, issues: 0 },
  );

  function openAlbum(album: Album) {
    if (!data) return;
    queryClient.setQueryData<AlbumResponse>(queryKeys.album(album.id), {
      album,
      photoRoot: data.photoRoot,
      exportDirName: data.exportDirName,
    });
    navigate(`/albums/${encodeURIComponent(album.id)}`);
  }

  function handleRescanAll() {
    rescanAllMutation.mutate(undefined, {
      onError: (error: unknown) => {
        const friendly = describeError(error);
        toast({ ...friendly, variant: "error" });
      },
      onSuccess: (result: RescanAllResponse) => {
        const failures = result.outcomes.filter((outcome) => outcome.error);
        if (failures.length > 0) {
          toast({
            variant: "error",
            title: `重新扫描完成，${failures.length} 个相册失败`,
            description:
              failures
                .slice(0, 3)
                .map((outcome) => `${outcome.albumName}：${outcome.error}`)
                .join("\n") + (failures.length > 3 ? `\n……另有 ${failures.length - 3} 个失败` : ""),
            durationMs: 12000,
          });
        } else {
          toast({
            variant: "success",
            title: "全部相册重新扫描完成",
            description:
              result.outcomes.length > 0
                ? `已扫描 ${result.outcomes.length} 个相册，共 ${result.outcomes.reduce(
                    (sum, outcome) => sum + (outcome.counts.total ?? 0),
                    0,
                  )} 张逻辑照片。`
                : "当前没有可扫描的相册。",
          });
        }
      },
    });
  }

  return (
    <div data-testid="library-page" className="space-y-6">
      {/* 暗房目录页眉 */}
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-white/[0.06] pb-5">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 font-mono text-[10px] font-medium uppercase tracking-[0.2em] text-accent-400/85">
            <FolderOpen className="h-3 w-3" aria-hidden="true" /> LOCAL CATALOG
          </p>
          <h1 className="mt-1.5 text-2xl font-semibold tracking-[-0.02em] text-ink-100 sm:text-[28px]">相册库</h1>
          <p className="mt-1.5 text-xs leading-relaxed text-ink-400">
            按文件夹管理拍摄相册，RAW+JPG 自动配对成一张逻辑照片。
            {data?.photoRoot ? (
              <>
                {" "}
                根目录：<span className="break-all font-mono text-[11px] text-ink-300">{data.photoRoot}</span>
              </>
            ) : null}
            {data?.exportDirName ? (
              <span className="text-ink-500">（{data.exportDirName} 已排除）</span>
            ) : null}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select
            label="排序"
            data-testid="library-sort"
            value={sort}
            onChange={(event) => setSort(event.target.value === "recent" ? "recent" : "name")}
          >
            <option value="name">按名称</option>
            <option value="recent">最近打开</option>
          </Select>
          <Button
            variant="secondary"
            icon={RefreshCw}
            data-testid="rescan-all-button"
            loading={rescanAllMutation.isPending}
            onClick={handleRescanAll}
          >
            重新扫描全部相册
          </Button>
        </div>
      </div>

      {/* 暗房全局统计遥测条 */}
      {data && albums.length > 0 ? (
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-lg border border-white/[0.07] bg-ink-900/80 px-4 py-2.5 text-[11px] text-ink-400 shadow-darkroom-control">
          <div className="flex items-baseline gap-1.5">
            <span className="font-mono text-sm font-semibold tabular-nums text-ink-100">{albums.length}</span>
            <span className="text-ink-500">个相册</span>
          </div>
          <span className="h-3.5 w-px bg-white/[0.08]" aria-hidden="true" />
          <div className="flex items-baseline gap-1.5">
            <span className="font-mono text-sm font-semibold tabular-nums text-ink-100">{totals.photos}</span>
            <span className="text-ink-500">张逻辑照片</span>
          </div>
          <span className="h-3.5 w-px bg-white/[0.08]" aria-hidden="true" />
          <div className="flex items-baseline gap-1.5">
            <span className="font-mono text-sm font-semibold tabular-nums text-accent-300">{totals.selected}</span>
            <span className="text-accent-400/80">精选</span>
          </div>
          <span className="h-3.5 w-px bg-white/[0.08]" aria-hidden="true" />
          <div className="flex items-baseline gap-1.5">
            <span className={cx("font-mono text-sm font-semibold tabular-nums", totals.pending > 0 ? "text-red-300" : "text-ink-300")}>
              {totals.pending}
            </span>
            <span className={totals.pending > 0 ? "text-red-300/80" : "text-ink-500"}>待删除</span>
          </div>
          <span className="h-3.5 w-px bg-white/[0.08]" aria-hidden="true" />
          <div className="flex items-baseline gap-1.5">
            <span className={cx("font-mono text-sm font-semibold tabular-nums", totals.issues > 0 ? "text-amber-300" : "text-ink-300")}>
              {totals.issues}
            </span>
            <span className={totals.issues > 0 ? "text-amber-300/80" : "text-ink-500"}>项异常</span>
          </div>
          {albumsQuery.isFetching ? (
            <span className="ml-auto font-mono text-[10px] text-ink-500" role="status">
              SYNCING…
            </span>
          ) : null}
        </div>
      ) : null}

      {albumsQuery.isPending ? (
        <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3" aria-label="正在加载相册">
          {[0, 1, 2, 3, 4, 5].map((index) => (
            <div key={index} className="overflow-hidden rounded-[10px] border border-white/[0.06] bg-ink-900">
              <Skeleton className="aspect-[16/10] w-full rounded-none" />
              <div className="space-y-3 p-3.5">
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="h-11 w-full" />
                <Skeleton className="h-3 w-1/2" />
              </div>
            </div>
          ))}
        </div>
      ) : albumsQuery.isError && !data ? (
        <div className="mx-auto max-w-xl py-10">
          <ErrorState
            error={albumsQuery.error}
            title="无法读取相册库"
            onRetry={() => void albumsQuery.refetch()}
          />
          <p className="mt-3 text-center text-xs leading-relaxed text-ink-500">
            请确认本地服务已启动（在项目根目录运行 npm run dev），然后重试。没有任何文件被修改。
          </p>
        </div>
      ) : albums.length === 0 ? (
        <div className="py-10">
          <EmptyState
            icon={Images}
            title="还没有发现相册"
            description={
              <>
                把相册文件夹放在照片根目录下，然后重新扫描。每个一级子文件夹会被识别为一个拍摄相册；
                精选目录、隐藏目录和符号链接目录会被排除。
                {data?.photoRoot ? (
                  <span className="mt-2 block break-all font-mono text-[11px] text-ink-500">{data.photoRoot}</span>
                ) : null}
              </>
            }
            action={
              <Button
                variant="secondary"
                icon={RefreshCw}
                data-testid="rescan-all-button-empty"
                loading={rescanAllMutation.isPending}
                onClick={handleRescanAll}
              >
                重新扫描全部相册
              </Button>
            }
            className="mx-auto max-w-xl"
          />
        </div>
      ) : (
        <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
          {albums.map((album) => (
            <AlbumCard
              key={album.id}
              album={album}
              onOpen={() => openAlbum(album)}
              retrying={retryingAlbumId === album.id}
              onRetry={() => {
                setRetryingAlbumId(album.id);
                retryAlbumMutation.mutate(album.id);
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
