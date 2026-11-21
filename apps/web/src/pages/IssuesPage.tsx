import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  AlertCircle,
  AlertTriangle,
  ChevronRight,
  FileWarning,
  FileX,
  FolderOpen,
  ImageOff,
  Images,
  RefreshCw,
  ScanLine,
  ShieldAlert,
  Trash2,
} from "lucide-react";
import type { IssueAssetRef, IssueCategory, IssuesResponse } from "../lib/api";
import { useApp } from "../context/AppContext";
import { useAlbums, useIssues } from "../hooks/useApiQueries";
import { useRescanIssues, useRevealAsset } from "../hooks/useMutations";
import { describeError } from "../lib/messages";
import {
  CONFLICT_REASON_LABELS,
  ISSUE_CATEGORY_DESCRIPTIONS,
  ISSUE_CATEGORY_LABELS,
} from "../lib/labels";
import { formatBytes, formatDateTime, formatRelativeTime } from "../lib/format";
import { cx } from "../lib/cx";
import { Button } from "../components/ui/Button";
import { Select } from "../components/ui/Select";
import { EmptyState, ErrorState, Skeleton } from "../components/ui/StateViews";
import { SelectionChip, StatusChip } from "../components/StatusChips";

const CATEGORY_ORDER: IssueCategory[] = [
  "pairingConflicts",
  "missingFiles",
  "exportConflicts",
  "previewFailures",
  "scanErrors",
  "cleanupIncomplete",
];

const CATEGORY_ICONS: Record<IssueCategory, typeof AlertTriangle> = {
  pairingConflicts: AlertTriangle,
  missingFiles: FileX,
  exportConflicts: FileWarning,
  previewFailures: ImageOff,
  scanErrors: ScanLine,
  cleanupIncomplete: Trash2,
};

const CATEGORY_TEST_IDS: Partial<Record<IssueCategory, string>> = {
  pairingConflicts: "issues-pairing",
  missingFiles: "issues-missing",
  exportConflicts: "issues-export",
};

function payloadString(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" ? value : null;
}

function AssetRow({
  asset,
  onReveal,
  revealing,
}: {
  asset: IssueAssetRef;
  onReveal: (assetId: string) => void;
  revealing: boolean;
}) {
  const missing = asset.presenceStatus === "missing";
  return (
    <li className={cx("rounded-md border px-2 py-1.5", missing ? "border-red-500/20 bg-red-500/[0.04]" : "border-white/[0.06] bg-white/[0.02]")}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="rounded border border-white/10 px-1 py-0.5 font-mono text-[9px] uppercase text-ink-400">
              {asset.kind}
            </span>
            <span className="break-all font-mono text-[10px] text-ink-300">{asset.relativePath}</span>
          </div>
          <p className="mt-0.5 text-[10px] text-ink-500">
            {asset.originalFilename} · {formatBytes(asset.sizeBytes)}
            {missing ? " · 文件缺失" : ""}
          </p>
        </div>
        {!missing ? (
          <button
            type="button"
            onClick={() => onReveal(asset.assetId)}
            disabled={revealing}
            className="inline-flex shrink-0 items-center gap-1 rounded border border-white/10 px-1.5 py-0.5 text-[10px] text-ink-300 hover:bg-white/[0.06] hover:text-ink-100 disabled:opacity-50"
          >
            <FolderOpen className="h-3 w-3" aria-hidden="true" />
            在 Finder 中显示
          </button>
        ) : null}
      </div>
    </li>
  );
}

export default function IssuesPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const albumId = searchParams.get("album") ?? "";
  const { toast } = useApp();
  const albumsQuery = useAlbums("name");
  const issuesQuery = useIssues(albumId || undefined);
  const rescanMutation = useRescanIssues(albumId || undefined);
  const revealMutation = useRevealAsset();
  const [category, setCategory] = useState<IssueCategory>("pairingConflicts");
  const initializedFor = useRef<string | null>(null);

  const albums = albumsQuery.data?.albums ?? [];
  const data: IssuesResponse | undefined = issuesQuery.data;
  const counts = data?.counts;

  useEffect(() => {
    if (!albumId) {
      initializedFor.current = null;
      return;
    }
    if (!data || data.albumId !== albumId || initializedFor.current === albumId) return;
    initializedFor.current = albumId;
    const firstNonEmpty = CATEGORY_ORDER.find((candidate) => data.counts[candidate] > 0);
    setCategory(firstNonEmpty ?? "pairingConflicts");
  }, [albumId, data]);

  function selectAlbum(nextAlbumId: string) {
    const next = new URLSearchParams(searchParams);
    if (nextAlbumId) next.set("album", nextAlbumId);
    else next.delete("album");
    setSearchParams(next, { replace: true });
  }

  function handleReveal(assetId: string) {
    revealMutation
      .mutateAsync(assetId)
      .then((result) => toast({ variant: "info", title: "已在 Finder 中显示", description: result.relativePath }))
      .catch((error: unknown) => {
        const friendly = describeError(error);
        toast({ ...friendly, variant: "error" });
      });
  }

  function handleRescan() {
    if (!albumId) return;
    rescanMutation.mutateAsync().then((result) => {
      if (result.total === 0) {
        toast({ variant: "success", title: "重新扫描完成", description: "未发现配对冲突、文件缺失或导出冲突。" });
      } else {
        toast({
          variant: "info",
          title: "重新扫描完成",
          description: `仍有 ${result.total} 项异常，请查看分类明细。`,
        });
      }
    }).catch((error: unknown) => {
      const friendly = describeError(error);
      toast({ ...friendly, variant: "error" });
    });
  }

  const activeCount = counts ? counts[category] : 0;
  const totalIssues = data?.total ?? 0;

  return (
    <div data-testid="issues-page" className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.16em] text-ink-500">
            <ShieldAlert className="h-3 w-3" aria-hidden="true" /> 安全与一致性
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-ink-100 sm:text-3xl">异常中心</h1>
          <p className="mt-1.5 max-w-2xl text-xs leading-relaxed text-ink-400">
            配对冲突、文件缺失与导出冲突不会被自动删除或覆盖。请在 Finder 中整理文件，然后重新扫描。
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {albumId ? (
            <>
              <Link
                to={`/albums/${encodeURIComponent(albumId)}`}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-white/10 bg-ink-800 px-2.5 text-xs font-medium text-ink-100 hover:bg-ink-700"
              >
                打开相册
                <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
              </Link>
              <Button
                variant="secondary"
                size="sm"
                icon={RefreshCw}
                loading={rescanMutation.isPending}
                onClick={handleRescan}
              >
                重新扫描
              </Button>
            </>
          ) : null}
        </div>
      </div>

      <section aria-label="选择相册" className="flex flex-wrap items-center gap-3 rounded-xl border border-white/[0.07] bg-ink-900 px-3 py-2.5">
        <Select label="相册" value={albumId} onChange={(event) => selectAlbum(event.target.value)}>
          <option value="">选择要检查的相册</option>
          {albums.map((album) => (
            <option key={album.id} value={album.id}>
              {album.name}
            </option>
          ))}
        </Select>
        {data ? (
          <>
            <span className="text-[11px] text-ink-300">{data.albumName}</span>
            <span className="text-ink-700">·</span>
            <span className={totalIssues > 0 ? "text-[11px] text-amber-300" : "text-[11px] text-emerald-300"} data-testid="issues-total">
              {totalIssues} 项异常
            </span>
          </>
        ) : null}
        {issuesQuery.isFetching && data ? (
          <span className="text-[10px] text-ink-500" role="status">
            正在刷新异常…
          </span>
        ) : null}
        <span className="ml-auto text-[10px] text-ink-600">不会自动删除或移动冲突文件</span>
      </section>

      {!albumId ? (
        albumsQuery.isPending ? (
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {[0, 1, 2].map((index) => (
              <Skeleton key={index} className="h-24" />
            ))}
          </div>
        ) : albumsQuery.isError && !albumsQuery.data ? (
          <ErrorState
            error={albumsQuery.error}
            title="无法读取相册列表"
            onRetry={() => void albumsQuery.refetch()}
          />
        ) : albums.length === 0 ? (
          <EmptyState
            icon={Images}
            title="还没有可检查的相册"
            description="相册库为空。先把相册文件夹放入照片根目录并扫描。"
            action={
              <Link to="/" className="text-xs text-accent-400 hover:underline">
                返回相册库
              </Link>
            }
          />
        ) : (
          <div>
            <EmptyState
              icon={ShieldAlert}
              title="选择一个相册开始检查"
              description="异常中心按相册汇总配对冲突、文件缺失、导出冲突、预览失败、扫描错误和清理未完成项。"
              className="mb-4"
            />
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {albums.map((album) => (
                <button
                  key={album.id}
                  type="button"
                  onClick={() => selectAlbum(album.id)}
                  className="flex items-center justify-between gap-3 rounded-lg border border-white/[0.07] bg-ink-900 px-3 py-2.5 text-left transition-colors hover:border-white/20 hover:bg-ink-850"
                >
                  <div className="min-w-0">
                    <p className="truncate text-xs font-medium text-ink-200">{album.name}</p>
                    <p className="mt-0.5 text-[10px] text-ink-500">
                      {album.counts.missing + album.counts.conflicts > 0
                        ? `${album.counts.missing + album.counts.conflicts} 项已知异常`
                        : "未发现已知异常"}
                    </p>
                  </div>
                  <ChevronRight className="h-4 w-4 shrink-0 text-ink-600" aria-hidden="true" />
                </button>
              ))}
            </div>
          </div>
        )
      ) : issuesQuery.isPending ? (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
            {[0, 1, 2, 3, 4, 5].map((index) => (
              <Skeleton key={index} className="h-20" />
            ))}
          </div>
          <Skeleton className="h-48 w-full" />
        </div>
      ) : issuesQuery.isError && !data ? (
        <ErrorState
          error={issuesQuery.error}
          title="无法读取异常列表"
          onRetry={() => void issuesQuery.refetch()}
        />
      ) : data ? (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6" role="tablist" aria-label="异常分类">
            {CATEGORY_ORDER.map((candidate) => {
              const Icon = CATEGORY_ICONS[candidate];
              const count = counts?.[candidate] ?? 0;
              const active = category === candidate;
              return (
                <button
                  key={candidate}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  data-testid={`issues-tab-${candidate}`}
                  title={ISSUE_CATEGORY_DESCRIPTIONS[candidate]}
                  onClick={() => setCategory(candidate)}
                  className={cx(
                    "flex flex-col items-start gap-1 rounded-xl border px-3 py-2.5 text-left transition-colors",
                    active
                      ? "border-accent-500/40 bg-accent-500/[0.08]"
                      : "border-white/[0.07] bg-ink-900 hover:border-white/15 hover:bg-ink-850",
                  )}
                >
                  <span className="flex w-full items-center justify-between gap-2">
                    <Icon className={cx("h-4 w-4", count > 0 ? "text-amber-300" : "text-ink-500")} aria-hidden="true" />
                    <span
                      className={cx(
                        "font-mono text-lg tabular-nums leading-none",
                        count > 0 ? (active ? "text-accent-300" : "text-ink-100") : "text-ink-600",
                      )}
                    >
                      {count}
                    </span>
                  </span>
                  <span className={cx("text-[11px] font-medium", active ? "text-accent-200" : "text-ink-300")}>
                    {ISSUE_CATEGORY_LABELS[candidate]}
                  </span>
                </button>
              );
            })}
          </div>

          <section
            role="tabpanel"
            aria-label={ISSUE_CATEGORY_LABELS[category]}
            data-testid={CATEGORY_TEST_IDS[category]}
            className="rounded-xl border border-white/[0.07] bg-ink-900 p-4"
          >
            <div className="flex flex-wrap items-start justify-between gap-2 border-b border-white/[0.06] pb-3">
              <div>
                <h2 className="flex items-center gap-2 text-sm font-semibold text-ink-100">
                  {ISSUE_CATEGORY_LABELS[category]}
                  <StatusChip tone={activeCount > 0 ? "warning" : "success"}>{activeCount} 项</StatusChip>
                </h2>
                <p className="mt-1 text-[11px] leading-relaxed text-ink-400">{ISSUE_CATEGORY_DESCRIPTIONS[category]}</p>
              </div>
              {category === "scanErrors" ? (
                <Button variant="secondary" size="sm" icon={RefreshCw} loading={rescanMutation.isPending} onClick={handleRescan}>
                  重新扫描
                </Button>
              ) : null}
            </div>

            <div className="mt-3 space-y-2.5">
              {activeCount === 0 ? (
                <EmptyState
                  icon={ShieldAlert}
                  title={`该分类暂无${ISSUE_CATEGORY_LABELS[category]}`}
                  description="如果刚刚在 Finder 中整理过文件，可以重新扫描刷新结果。"
                  className="border-white/[0.06] py-8"
                  action={
                    <Button variant="secondary" size="sm" icon={RefreshCw} loading={rescanMutation.isPending} onClick={handleRescan}>
                      重新扫描相册
                    </Button>
                  }
                />
              ) : category === "pairingConflicts" ? (
                data.pairingConflicts.map((conflict) => (
                  <article key={conflict.groupId} className="rounded-lg border border-amber-500/20 bg-amber-500/[0.03] px-3 py-2.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <AlertTriangle className="h-4 w-4 text-amber-300" aria-hidden="true" />
                        <h3 className="font-mono text-xs font-medium text-ink-100">{conflict.displayName}</h3>
                        {conflict.conflictReasons.map((reason) => (
                          <StatusChip key={reason} tone="warning">
                            {CONFLICT_REASON_LABELS[reason] ?? reason}
                          </StatusChip>
                        ))}
                      </div>
                      <span className="text-[10px] text-ink-500">只读 · 不允许自动清理或导出</span>
                    </div>
                    <ul className="mt-2 space-y-1.5">
                      {conflict.files.map((file) => (
                        <AssetRow
                          key={file.assetId}
                          asset={file}
                          onReveal={handleReveal}
                          revealing={revealMutation.isPending && revealMutation.variables === file.assetId}
                        />
                      ))}
                    </ul>
                    <p className="mt-2 text-[10px] leading-relaxed text-ink-500">
                      请在 Finder 中重命名或整理重复文件，然后重新扫描；冲突解除前该组不会参与清理或导出。
                    </p>
                  </article>
                ))
              ) : category === "missingFiles" ? (
                data.missingFiles.map((missing) => (
                  <article key={missing.groupId} className="rounded-lg border border-red-500/20 bg-red-500/[0.03] px-3 py-2.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <FileX className="h-4 w-4 text-red-300" aria-hidden="true" />
                        <h3 className="font-mono text-xs font-medium text-ink-100">{missing.displayName}</h3>
                        <SelectionChip status={missing.selectionStatus} />
                        <StatusChip tone="danger">文件缺失</StatusChip>
                      </div>
                    </div>
                    <div className="mt-2 rounded-md border border-red-500/15 bg-black/20 px-2 py-1.5">
                      <p className="text-[10px] text-ink-500">数据库中记录的缺失路径</p>
                      <ul className="mt-1 space-y-0.5">
                        {missing.missingPaths.map((path) => (
                          <li key={path} className="break-all font-mono text-[10px] text-red-200">
                            {path}
                          </li>
                        ))}
                      </ul>
                    </div>
                    {missing.files.length > 0 ? (
                      <ul className="mt-2 space-y-1.5">
                        {missing.files.map((file) => (
                          <AssetRow
                            key={file.assetId}
                            asset={file}
                            onReveal={handleReveal}
                            revealing={revealMutation.isPending && revealMutation.variables === file.assetId}
                          />
                        ))}
                      </ul>
                    ) : null}
                    <p className="mt-2 text-[10px] leading-relaxed text-ink-500">
                      文件缺失不是待删除。把文件放回原路径后重新扫描，会恢复显示并合并原有状态。
                    </p>
                  </article>
                ))
              ) : category === "exportConflicts" ? (
                data.exportConflicts.map((conflict) => (
                  <article key={conflict.id} className="rounded-lg border border-amber-500/20 bg-amber-500/[0.03] px-3 py-2.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h3 className="flex items-center gap-2 text-xs font-medium text-ink-100">
                        <FileWarning className="h-4 w-4 text-amber-300" aria-hidden="true" />
                        同名不同内容，未覆盖
                      </h3>
                      <span className="text-[10px] text-ink-500">最近发现 {formatRelativeTime(conflict.lastSeenAt)}</span>
                    </div>
                    <dl className="mt-2 grid gap-1.5 text-[10px] sm:grid-cols-2">
                      <div className="rounded border border-white/[0.06] bg-black/20 px-2 py-1.5">
                        <dt className="text-ink-500">源文件</dt>
                        <dd className="mt-0.5 break-all font-mono text-ink-300">{conflict.sourceRelativePath}</dd>
                        <dd className="mt-0.5 text-ink-500">{formatBytes(conflict.sourceSizeBytes)}</dd>
                      </div>
                      <div className="rounded border border-white/[0.06] bg-black/20 px-2 py-1.5">
                        <dt className="text-ink-500">目标文件（未覆盖）</dt>
                        <dd className="mt-0.5 break-all font-mono text-ink-300">{conflict.destinationRelativePath}</dd>
                        <dd className="mt-0.5 text-ink-500">{formatBytes(conflict.destinationSizeBytes)}</dd>
                      </div>
                    </dl>
                    {conflict.sourceAssets.length > 0 ? (
                      <ul className="mt-2 space-y-1.5">
                        {conflict.sourceAssets.map((file) => (
                          <AssetRow
                            key={file.assetId}
                            asset={file}
                            onReveal={handleReveal}
                            revealing={revealMutation.isPending && revealMutation.variables === file.assetId}
                          />
                        ))}
                      </ul>
                    ) : null}
                    <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                      <p className="text-[10px] text-ink-500">
                        请在 Finder 中处理目标目录的同名文件后重新导出；不会自动加后缀或覆盖。
                      </p>
                      {conflict.operationId ? (
                        <Link
                          to={`/operations?operation=${encodeURIComponent(conflict.operationId)}`}
                          className="text-[10px] text-accent-400 hover:underline"
                        >
                          查看相关操作记录
                        </Link>
                      ) : null}
                    </div>
                  </article>
                ))
              ) : category === "previewFailures" ? (
                data.previewFailures.map((issue) => {
                  const assetId = payloadString(issue.payload, "assetId");
                  const relativePath = payloadString(issue.payload, "relativePath");
                  return (
                    <article key={issue.id} className="rounded-lg border border-white/[0.07] bg-white/[0.02] px-3 py-2.5">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <h3 className="flex items-center gap-2 text-xs font-medium text-ink-100">
                          <ImageOff className="h-4 w-4 text-amber-300" aria-hidden="true" /> RAW 或缩略图预览失败
                        </h3>
                        <span className="text-[10px] text-ink-500">{formatRelativeTime(issue.lastSeenAt)}</span>
                      </div>
                      <p className="mt-1 text-[11px] leading-relaxed text-ink-300">{issue.message}</p>
                      {relativePath ? (
                        <p className="mt-1 break-all font-mono text-[10px] text-ink-500">{relativePath}</p>
                      ) : null}
                      <div className="mt-1.5 flex items-center gap-2">
                        {assetId ? (
                          <button
                            type="button"
                            onClick={() => handleReveal(assetId)}
                            disabled={revealMutation.isPending}
                            className="inline-flex items-center gap-1 rounded border border-white/10 px-1.5 py-0.5 text-[10px] text-ink-300 hover:bg-white/[0.06] disabled:opacity-50"
                          >
                            <FolderOpen className="h-3 w-3" aria-hidden="true" /> 在 Finder 中显示
                          </button>
                        ) : null}
                        <span className="text-[10px] text-ink-500">原文件不会被修改；可稍后重试预览。</span>
                      </div>
                    </article>
                  );
                })
              ) : category === "scanErrors" ? (
                data.scanErrors.map((issue) => (
                  <article key={issue.id} className="rounded-lg border border-red-500/20 bg-red-500/[0.03] px-3 py-2.5">
                    <div className="flex items-start gap-2">
                      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-300" aria-hidden="true" />
                      <div className="min-w-0 flex-1">
                        <h3 className="text-xs font-medium text-ink-100">扫描或读取错误</h3>
                        <p className="mt-1 break-words text-[11px] leading-relaxed text-ink-300">{issue.message}</p>
                        <p className="mt-1 text-[10px] text-ink-500">{formatDateTime(issue.lastSeenAt)}</p>
                      </div>
                    </div>
                  </article>
                ))
              ) : (
                data.cleanupIncomplete.map((issue) => {
                  const displayName = payloadString(issue.payload, "displayName");
                  const operationId = payloadString(issue.payload, "operationId") ?? issue.operationId;
                  return (
                    <article key={issue.id} className="rounded-lg border border-red-500/25 bg-red-500/[0.04] px-3 py-2.5">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <h3 className="flex items-center gap-2 text-xs font-medium text-red-100">
                          <ShieldAlert className="h-4 w-4 text-red-300" aria-hidden="true" /> 清理未完成，需要人工核对
                        </h3>
                        <span className="text-[10px] text-ink-500">{formatRelativeTime(issue.lastSeenAt)}</span>
                      </div>
                      <p className="mt-1 text-[11px] leading-relaxed text-ink-300">{issue.message}</p>
                      {displayName ? <p className="mt-1 font-mono text-[10px] text-ink-400">{displayName}</p> : null}
                      {operationId ? (
                        <Link
                          to={`/operations?operation=${encodeURIComponent(operationId)}`}
                          className="mt-1 inline-block text-[10px] text-accent-400 hover:underline"
                        >
                          查看操作记录与实际位置
                        </Link>
                      ) : null}
                    </article>
                  );
                })
              )}
            </div>
          </section>

          <p className="flex items-center gap-1.5 text-[10px] leading-relaxed text-ink-600">
            <ShieldAlert className="h-3 w-3" aria-hidden="true" />
            本页不存在“删除冲突”或“永久删除”入口。所有整理操作都应在 Finder 中完成。
          </p>
        </>
      ) : null}
    </div>
  );
}
