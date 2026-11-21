import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  AlertCircle,
  ChevronLeft,
  ChevronRight,
  Download,
  History,
  RotateCcw,
  ScanLine,
  SlidersHorizontal,
  Trash2,
} from "lucide-react";
import type { OperationStatus, OperationType } from "../lib/api";
import { dateInputToIso, formatDateTime } from "../lib/format";
import { OPERATION_TYPE_LABELS } from "../lib/labels";
import { useAlbums, useOperations } from "../hooks/useApiQueries";
import { Button } from "../components/ui/Button";
import { DateInput, Select } from "../components/ui/Select";
import { EmptyState, ErrorState, Skeleton } from "../components/ui/StateViews";
import { OperationStatusChip } from "../components/StatusChips";
import { OperationDetailDialog } from "../components/operations/OperationDetailDialog";

const PAGE_SIZE = 50;

const TYPE_ICONS: Record<OperationType, typeof ScanLine> = {
  scan: ScanLine,
  cleanup: Trash2,
  restore: RotateCcw,
  export: Download,
};

const TYPE_OPTIONS: Array<{ value: "all" | OperationType; label: string }> = [
  { value: "all", label: "全部类型" },
  { value: "scan", label: "扫描" },
  { value: "cleanup", label: "清理" },
  { value: "restore", label: "撤销恢复" },
  { value: "export", label: "导出" },
];

const STATUS_OPTIONS: Array<{ value: "all" | OperationStatus; label: string }> = [
  { value: "all", label: "全部状态" },
  { value: "preflight", label: "预检" },
  { value: "executing", label: "执行中" },
  { value: "success", label: "成功" },
  { value: "partial_failure", label: "部分失败" },
  { value: "failed", label: "失败" },
  { value: "restored", label: "已恢复" },
  { value: "interrupted", label: "已中断" },
];

export default function OperationsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const detailId = searchParams.get("operation");
  const [albumId, setAlbumId] = useState("");
  const [type, setType] = useState<"all" | OperationType>("all");
  const [status, setStatus] = useState<"all" | OperationStatus>("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(0);

  useEffect(() => {
    setPage(0);
  }, [albumId, type, status, from, to]);

  const query = useMemo(
    () => ({
      albumId: albumId || undefined,
      type,
      status,
      from: dateInputToIso(from, "start"),
      to: dateInputToIso(to, "end"),
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
    }),
    [albumId, type, status, from, to, page],
  );

  const operationsQuery = useOperations(query);
  const albumsQuery = useAlbums("name");
  const albums = albumsQuery.data?.albums ?? [];
  const operations = operationsQuery.data?.items ?? [];
  const total = operationsQuery.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const filtersActive = Boolean(albumId) || type !== "all" || status !== "all" || Boolean(from) || Boolean(to);

  function openDetail(operationId: string) {
    const next = new URLSearchParams(searchParams);
    next.set("operation", operationId);
    setSearchParams(next, { replace: true });
  }

  function closeDetail() {
    const next = new URLSearchParams(searchParams);
    next.delete("operation");
    setSearchParams(next, { replace: true });
  }

  function resetFilters() {
    setAlbumId("");
    setType("all");
    setStatus("all");
    setFrom("");
    setTo("");
    setPage(0);
  }

  return (
    <div data-testid="operations-page" className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.16em] text-ink-500">
            <History className="h-3 w-3" aria-hidden="true" /> 审计记录
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-ink-100 sm:text-3xl">操作记录</h1>
          <p className="mt-1.5 text-xs leading-relaxed text-ink-400">
            清理、撤销恢复、导出与扫描的追加式记录。失败与冲突会单独列出，不会被后续扫描覆盖。
          </p>
        </div>
        <span className="rounded-lg border border-white/[0.07] bg-white/[0.02] px-3 py-2 font-mono text-xs tabular-nums text-ink-300">
          共 {operationsQuery.data ? total : "—"} 条
        </span>
      </div>

      <section
        aria-label="操作记录筛选"
        className="rounded-xl border border-white/[0.07] bg-ink-900 p-3"
      >
        <div className="flex flex-wrap items-end gap-2">
          <Select label="相册" value={albumId} onChange={(event) => setAlbumId(event.target.value)}>
            <option value="">全部相册</option>
            {albums.map((album) => (
              <option key={album.id} value={album.id}>
                {album.name}
              </option>
            ))}
          </Select>
          <Select
            label="类型"
            value={type}
            onChange={(event) => setType(event.target.value as "all" | OperationType)}
          >
            {TYPE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
          <Select
            label="状态"
            value={status}
            onChange={(event) => setStatus(event.target.value as "all" | OperationStatus)}
          >
            {STATUS_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
          <DateInput label="起始日期" value={from} onChange={(event) => setFrom(event.target.value)} />
          <DateInput label="结束日期" value={to} onChange={(event) => setTo(event.target.value)} />
          {filtersActive ? (
            <Button variant="ghost" size="sm" icon={SlidersHorizontal} onClick={resetFilters}>
              重置筛选
            </Button>
          ) : null}
          {operationsQuery.isFetching ? (
            <span className="ml-auto text-[10px] text-ink-500" role="status">
              正在刷新…
            </span>
          ) : null}
        </div>
      </section>

      <div className="overflow-hidden rounded-xl border border-white/[0.07] bg-ink-900">
        <div className="hidden grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)_180px_24px] gap-3 border-b border-white/[0.07] px-4 py-2 text-[10px] uppercase tracking-wide text-ink-500 md:grid">
          <span>类型 / 状态 / 相册</span>
          <span>计数与错误</span>
          <span>时间</span>
          <span className="sr-only">查看</span>
        </div>

        {operationsQuery.isPending ? (
          <div className="space-y-2 p-3">
            {[0, 1, 2, 3, 4].map((index) => (
              <Skeleton key={index} className="h-16 w-full" />
            ))}
          </div>
        ) : operationsQuery.isError && !operationsQuery.data ? (
          <div className="p-4">
            <ErrorState
              error={operationsQuery.error}
              title="无法读取操作记录"
              onRetry={() => void operationsQuery.refetch()}
            />
          </div>
        ) : operations.length === 0 ? (
          <div className="p-4">
            <EmptyState
              icon={History}
              title={filtersActive ? "没有符合条件的操作记录" : "还没有操作记录"}
              description={
                filtersActive
                  ? "尝试调整相册、类型、状态或时间范围。"
                  : "执行清理、恢复、导出或扫描后，逐文件结果会记录在这里。"
              }
              action={
                filtersActive ? (
                  <Button variant="secondary" size="sm" icon={SlidersHorizontal} onClick={resetFilters}>
                    重置筛选
                  </Button>
                ) : undefined
              }
            />
          </div>
        ) : (
          <ul className="divide-y divide-white/[0.05]">
            {operations.map((operation) => {
              const Icon = TYPE_ICONS[operation.type];
              return (
                <li key={operation.id}>
                  <button
                    type="button"
                    data-testid="operation-row"
                    data-operation-id={operation.id}
                    onClick={() => openDetail(operation.id)}
                    className="grid w-full grid-cols-[auto_minmax(0,1fr)] items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-white/[0.03] focus-visible:bg-white/[0.04] focus-visible:outline focus-visible:outline-2 focus-visible:outline-inset focus-visible:outline-accent-400 md:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)_180px_24px] md:items-center"
                  >
                    <div className="col-span-2 flex min-w-0 items-start gap-3 md:col-span-1 md:items-center">
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-white/[0.08] bg-white/[0.03] text-ink-300">
                        <Icon className="h-4 w-4" aria-hidden="true" />
                      </span>
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-xs font-medium text-ink-100">
                            {OPERATION_TYPE_LABELS[operation.type]}
                          </span>
                          <OperationStatusChip status={operation.status} />
                          <span className="truncate text-[11px] text-ink-400">{operation.albumName ?? "无关联相册"}</span>
                        </div>
                        <p className="mt-0.5 font-mono text-[10px] text-ink-600">{operation.id.slice(0, 8)}…</p>
                      </div>
                    </div>

                    <div className="col-span-2 min-w-0 md:col-span-1">
                      <p className="text-[11px] text-ink-300">
                        照片 <span className="font-mono tabular-nums">{operation.requestedPhotoCount}</span> · 文件{" "}
                        <span className="font-mono tabular-nums">{operation.requestedFileCount}</span>
                        <span className="mx-1.5 text-ink-600">|</span>
                        成功 <span className="font-mono tabular-nums text-emerald-300">{operation.successFileCount}</span>
                        <span className="mx-1.5 text-ink-600">/ 跳过</span>{" "}
                        <span className="font-mono tabular-nums text-sky-300">{operation.skippedFileCount}</span>
                        <span className="mx-1.5 text-ink-600">/ 失败</span>{" "}
                        <span
                          className={
                            operation.failedFileCount > 0
                              ? "font-mono tabular-nums text-red-300"
                              : "font-mono tabular-nums text-ink-400"
                          }
                        >
                          {operation.failedFileCount}
                        </span>
                        {operation.conflictFileCount > 0 ? (
                          <>
                            <span className="mx-1.5 text-ink-600">/ 冲突</span>{" "}
                            <span className="font-mono tabular-nums text-amber-300">{operation.conflictFileCount}</span>
                          </>
                        ) : null}
                      </p>
                      {operation.errorSummary ? (
                        <p className="mt-1 flex items-start gap-1 text-[10px] leading-relaxed text-red-300">
                          <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
                          <span className="line-clamp-2">{operation.errorSummary}</span>
                        </p>
                      ) : null}
                    </div>

                    <div
                      className="col-span-2 text-left text-[10px] text-ink-500 md:col-span-1 md:text-right"
                      title={`请求时间 ${formatDateTime(operation.requestedAt)}`}
                    >
                      <p className="font-mono tabular-nums">
                        开始 {formatDateTime(operation.startedAt ?? operation.requestedAt)}
                      </p>
                      <p className="mt-0.5 font-mono tabular-nums text-ink-600">
                        {operation.finishedAt ? `结束 ${formatDateTime(operation.finishedAt)}` : "尚未结束"}
                      </p>
                    </div>

                    <span className="col-span-2 hidden justify-self-end text-ink-600 md:col-span-1 md:inline-flex">
                      <ChevronRight className="h-4 w-4" aria-hidden="true" />
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {total > 0 ? (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-white/[0.07] px-4 py-2.5">
            <span className="text-[10px] text-ink-500">
              第 {page + 1} / {pageCount} 页 · 每页 {PAGE_SIZE} 条
            </span>
            <div className="flex items-center gap-1.5">
              <Button
                variant="ghost"
                size="sm"
                icon={ChevronLeft}
                disabled={page === 0 || operationsQuery.isFetching}
                onClick={() => setPage((value) => Math.max(0, value - 1))}
              >
                上一页
              </Button>
              <Button
                variant="ghost"
                size="sm"
                icon={ChevronRight}
                disabled={page + 1 >= pageCount || operationsQuery.isFetching}
                onClick={() => setPage((value) => value + 1)}
              >
                下一页
              </Button>
            </div>
          </div>
        ) : null}
      </div>

      <p className="text-[10px] leading-relaxed text-ink-600">
        时间按本机时区展示；错误、跳过与冲突均保留逐文件快照。点击任意记录查看详情与恢复入口。
      </p>

      <OperationDetailDialog operationId={detailId} onClose={closeDetail} />
    </div>
  );
}
