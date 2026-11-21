import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  FolderOpen,
  Images,
  RefreshCw,
  ChevronRight,
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
      className="group relative flex flex-col overflow-hidden rounded-xl border border-white/[0.08] bg-ink-900 transition-colors hover:border-white/20 hover:bg-ink-850 focus-within:border-accent-500/50"
      data-testid="album-card"
      data-album-name={album.name}
    >
      <Link
        to={`/albums/${encodeURIComponent(album.id)}`}
        aria-label={`打开相册 ${album.name}`}
        onClick={onOpen}
        className="absolute inset-0 z-10 rounded-xl"
      >
        <span className="sr-only">打开相册 {album.name}</span>
      </Link>

      <div className="relative aspect-[16/10] w-full overflow-hidden bg-ink-950">
        {album.coverThumbnailUrl && !coverFailed ? (
          <img
            src={appendMediaParam(album.coverThumbnailUrl, "updated", album.updatedAt)}
            alt={`相册封面：${album.name}`}
            loading="lazy"
            decoding="async"
            className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.03]"
            onError={() => setCoverFailed(true)}
          />
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-[radial-gradient(circle_at_50%_30%,rgba(255,255,255,0.06),transparent_60%)] text-ink-600">
            {album.scanStatus === "failed" ? (
              <AlertCircle className="h-7 w-7 text-red-400/70" aria-hidden="true" />
            ) : (
              <Images className="h-7 w-7" aria-hidden="true" />
            )}
            <span className="text-[10px]">{album.counts.total === 0 ? "暂无照片" : "暂无封面"}</span>
          </div>
        )}
        <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex items-start justify-between gap-2 p-2.5">
          <ScanStatusChip status={album.scanStatus} />
          {issueCount > 0 ? (
            <StatusChip icon={ShieldAlert} tone="warning" className="bg-ink-950/80 backdrop-blur-sm">
              {issueCount} 项异常
            </StatusChip>
          ) : null}
        </div>
        {album.counts.total > 0 ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex items-end justify-between gap-2 bg-gradient-to-t from-black/80 to-transparent px-2.5 pb-2 pt-8">
            <span className="font-mono text-[10px] tabular-nums text-ink-200">
              已浏览 {album.counts.viewed} / {album.counts.total}
            </span>
            <span className="font-mono text-[10px] tabular-nums text-accent-400">{progress}%</span>
          </div>
        ) : null}
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 p-3.5">
        <div className="flex items-start justify-between gap-2">
          <h3 className="min-w-0 truncate text-sm font-semibold tracking-tight text-ink-100" title={album.name}>
            {album.name}
          </h3>
          <span className="shrink-0 text-[10px] text-ink-500">{formatRelativeTime(album.lastScannedAt)}</span>
        </div>

        {album.counts.total > 0 ? (
          <div
            role="progressbar"
            aria-label={`${album.name} 浏览进度`}
            aria-valuemin={0}
            aria-valuemax={album.counts.total}
            aria-valuenow={album.counts.viewed}
            className="h-1 w-full overflow-hidden rounded-full bg-white/[0.06]"
          >
            <div className="h-full rounded-full bg-accent-500/80" style={{ width: `${progress}%` }} />
          </div>
        ) : null}

        <dl className="grid grid-cols-4 gap-1.5 text-center">
          <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-1 py-1.5">
            <dt className="text-[9px] text-ink-500">照片</dt>
            <dd className="font-mono text-xs tabular-nums text-ink-100">{album.counts.total}</dd>
          </div>
          <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-1 py-1.5">
            <dt className="flex items-center justify-center gap-0.5 text-[9px] text-ink-500">
              <Star className="h-2.5 w-2.5 text-accent-400" aria-hidden="true" /> 精选
            </dt>
            <dd className={cx("font-mono text-xs tabular-nums", album.counts.selected > 0 ? "text-accent-300" : "text-ink-300")}>
              {album.counts.selected}
            </dd>
          </div>
          <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-1 py-1.5">
            <dt className="flex items-center justify-center gap-0.5 text-[9px] text-ink-500">
              <Trash2 className="h-2.5 w-2.5 text-red-300" aria-hidden="true" /> 待删
            </dt>
            <dd className={cx("font-mono text-xs tabular-nums", album.counts.pendingDelete > 0 ? "text-red-300" : "text-ink-300")}>
              {album.counts.pendingDelete}
            </dd>
          </div>
          <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-1 py-1.5">
            <dt className="text-[9px] text-ink-500">缺失/冲突</dt>
            <dd className={cx("font-mono text-xs tabular-nums", issueCount > 0 ? "text-amber-300" : "text-ink-300")}>
              {album.counts.missing} / {album.counts.conflicts}
            </dd>
          </div>
        </dl>

        {album.scanStatus === "failed" && album.scanError ? (
          <div className="flex items-start gap-2 rounded-lg border border-red-500/25 bg-red-500/[0.05] px-2.5 py-2">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-400" aria-hidden="true" />
            <p className="line-clamp-2 min-w-0 flex-1 text-[10px] leading-relaxed text-red-200">{album.scanError}</p>
            <button
              type="button"
              data-testid="album-retry"
              className="relative z-20 shrink-0 rounded border border-red-500/30 px-1.5 py-0.5 text-[10px] text-red-200 hover:bg-red-500/15 disabled:opacity-50"
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
          <span className="truncate font-mono text-[10px] text-ink-600" title={album.relativePath}>
            {album.relativePath}
          </span>
          <span className="inline-flex shrink-0 items-center gap-1 text-[10px] text-ink-500 group-hover:text-accent-400">
            打开
            <ChevronRight className="h-3 w-3" aria-hidden="true" />
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
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.16em] text-ink-500">
            <FolderOpen className="h-3 w-3" aria-hidden="true" /> 本地照片
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-ink-100 sm:text-3xl">相册库</h1>
          <p className="mt-1.5 text-xs leading-relaxed text-ink-400">
            按文件夹管理拍摄相册，RAW＋JPG 自动配对成一张逻辑照片。
            {data?.photoRoot ? (
              <>
                {" "}
                照片根目录：<span className="break-all font-mono text-[11px] text-ink-300">{data.photoRoot}</span>
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

      {data && albums.length > 0 ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-white/[0.06] bg-white/[0.015] px-3.5 py-2 text-[11px] text-ink-400">
          <span>
            <span className="font-mono tabular-nums text-ink-200">{albums.length}</span> 个相册
          </span>
          <span className="text-ink-700">·</span>
          <span>
            <span className="font-mono tabular-nums text-ink-200">{totals.photos}</span> 张照片
          </span>
          <span className="text-ink-700">·</span>
          <span className="text-accent-400/90">
            <span className="font-mono tabular-nums">{totals.selected}</span> 精选
          </span>
          <span className="text-ink-700">·</span>
          <span className={totals.pending > 0 ? "text-red-300" : undefined}>
            <span className="font-mono tabular-nums">{totals.pending}</span> 待删除
          </span>
          <span className="text-ink-700">·</span>
          <span className={totals.issues > 0 ? "text-amber-300" : undefined}>
            <span className="font-mono tabular-nums">{totals.issues}</span> 项异常
          </span>
          {albumsQuery.isFetching ? (
            <span className="ml-auto text-ink-500" role="status">
              正在刷新列表…
            </span>
          ) : null}
        </div>
      ) : null}

      {albumsQuery.isPending ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" aria-label="正在加载相册">
          {[0, 1, 2, 3, 4, 5].map((index) => (
            <div key={index} className="overflow-hidden rounded-xl border border-white/[0.06] bg-ink-900">
              <Skeleton className="aspect-[16/10] w-full rounded-none" />
              <div className="space-y-3 p-3.5">
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="h-1 w-full" />
                <div className="grid grid-cols-4 gap-1.5">
                  <Skeleton className="h-9" />
                  <Skeleton className="h-9" />
                  <Skeleton className="h-9" />
                  <Skeleton className="h-9" />
                </div>
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
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
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
