import { useEffect, useRef, useState } from "react";
import { AlertCircle, AlertTriangle, CheckCircle2, Clock3, Download, FolderOpen, Loader2 } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  api,
  type ExportPreflight,
  type ExportStartResponse,
  type Job,
  type OperationDetail,
} from "../../lib/api";
import { useApp } from "../../context/AppContext";
import { describeError } from "../../lib/messages";
import { createId } from "../../lib/id";
import { formatBytes, formatDateTime } from "../../lib/format";
import { useExportJob } from "../../hooks/useApiQueries";
import { useExportStart } from "../../hooks/useMutations";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { ErrorState, Skeleton } from "../ui/StateViews";
import { ItemResultChip, OperationStatusChip, StatusChip } from "../StatusChips";

interface ExportDialogProps {
  open: boolean;
  albumId: string;
  albumName: string | null;
  selectedCount: number;
  onClose: () => void;
  onPauseAutoplay: () => void;
}

function percent(processed: number, total: number): number {
  if (!total) return 0;
  return Math.max(0, Math.min(100, Math.round((processed / total) * 100)));
}

function failedExportItems(operation: OperationDetail | undefined) {
  return (operation?.items ?? []).filter((item) => item.result === "failed" || item.result === "conflict");
}

export function ExportDialog({
  open,
  albumId,
  albumName,
  selectedCount,
  onClose,
  onPauseAutoplay,
}: ExportDialogProps) {
  const { toast } = useApp();
  const queryClient = useQueryClient();
  const startMutation = useExportStart(albumId);

  const [preflight, setPreflight] = useState<ExportPreflight | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [startError, setStartError] = useState<unknown>(null);
  const [startResult, setStartResult] = useState<ExportStartResponse | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [operationDetail, setOperationDetail] = useState<OperationDetail | null>(null);
  const [detailError, setDetailError] = useState<unknown>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const idempotencyKeyRef = useRef<string | null>(null);
  const finishedNoticeRef = useRef<string | null>(null);

  const jobQuery = useExportJob(jobId, open);
  const job: Job | null = jobQuery.data?.job ?? null;

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setPreflight(null);
    setLoadError(null);
    setStartError(null);
    setStartResult(null);
    setJobId(null);
    setOperationDetail(null);
    setDetailError(null);
    idempotencyKeyRef.current = null;
    finishedNoticeRef.current = null;
    setLoading(true);
    onPauseAutoplay();
    api
      .exportPreflight(albumId)
      .then((result) => {
        if (!cancelled) setPreflight(result);
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoadError(error);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 打开时只预检一次
  }, [open, albumId, reloadKey]);

  const finished = job?.status === "success" || job?.status === "failed";

  useEffect(() => {
    if (!finished || !job) return;
    if (finishedNoticeRef.current === job.id) return;
    finishedNoticeRef.current = job.id;
    void queryClient.invalidateQueries({ queryKey: ["photos", albumId] });
    void queryClient.invalidateQueries({ queryKey: ["album", albumId] });
    void queryClient.invalidateQueries({ queryKey: ["albums"] });
    void queryClient.invalidateQueries({ queryKey: ["issues", albumId] });
    void queryClient.invalidateQueries({ queryKey: ["operations"] });
    if (
      job.status === "success" &&
      (job.progress?.failedFiles ?? 0) === 0 &&
      (job.progress?.conflictFiles ?? 0) === 0
    ) {
      const skipped = job.progress?.skippedFiles ?? 0;
      const copied = job.progress?.successFiles ?? 0;
      toast({
        variant: "success",
        title: copied === 0 && skipped > 0 ? "精选目录已是最新" : "精选导出完成",
        description:
          copied === 0 && skipped > 0
            ? `${skipped} 个文件已存在相同内容，已跳过，没有重复复制。`
            : `已处理 ${job.progress?.processedFiles ?? 0} 个文件。源相册未被修改。`,
      });
    } else {
      toast({
        variant: "error",
        title: "导出未全部成功",
        description:
          job.error ??
          `成功 ${job.progress?.successFiles ?? 0}，跳过 ${job.progress?.skippedFiles ?? 0}，冲突 ${
            job.progress?.conflictFiles ?? 0
          }，失败 ${job.progress?.failedFiles ?? 0}。请查看逐文件结果。`,
      });
    }
  }, [finished, job, queryClient, albumId, toast]);

  useEffect(() => {
    if (!finished || !job?.operationId) return;
    let cancelled = false;
    setDetailLoading(true);
    setDetailError(null);
    api
      .getOperation(job.operationId)
      .then((response) => {
        if (!cancelled) setOperationDetail(response.operation);
      })
      .catch((error: unknown) => {
        if (!cancelled) setDetailError(error);
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [finished, job?.operationId]);

  async function handleConfirm() {
    if (!preflight?.token) return;
    onPauseAutoplay();
    setStartError(null);
    if (!idempotencyKeyRef.current) idempotencyKeyRef.current = createId();
    try {
      const response = await startMutation.mutateAsync({
        token: preflight.token,
        idempotencyKey: idempotencyKeyRef.current,
      });
      setStartResult(response);
      if (response.operation) setOperationDetail(response.operation);
      if (response.jobId) {
        setJobId(response.jobId);
      } else if (response.operation) {
        setOperationDetail(response.operation);
        toast({
          variant: response.operation.status === "success" ? "success" : "info",
          title: "该导出已执行过（幂等重放）",
          description: "没有创建新的复制任务，下面是原任务的最新结果。",
        });
      }
    } catch (error) {
      setStartError(error);
      const friendly = describeError(error);
      toast({ ...friendly, variant: "error" });
    }
  }

  function handleClose() {
    if (startMutation.isPending) return;
    onClose();
  }

  const warnings = preflight?.warnings ?? [];
  const failedItems = failedExportItems(operationDetail ?? undefined);
  const progress = job?.progress ?? null;
  const processed = progress?.processedFiles ?? 0;
  const totalFiles = progress?.totalFiles ?? 0;
  const progressPercent = percent(processed, totalFiles);
  const finalOperation = operationDetail ?? startResult?.operation ?? null;

  const footer = (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-[10px] leading-relaxed text-ink-500">
        {jobId && !finished ? "关闭窗口不会中断导出任务；可稍后在操作记录查看结果。" : "复制不会移动或修改源文件。"}
      </p>
      <div className="flex items-center gap-2">
        <Button variant="secondary" data-testid="export-cancel" onClick={handleClose} disabled={startMutation.isPending}>
          关闭
        </Button>
        {!startResult ? (
          <Button
            variant="primary"
            icon={Download}
            data-testid="export-confirm"
            loading={startMutation.isPending}
            disabled={
              loading ||
              !preflight?.token ||
              !preflight ||
              preflight.summary.photoCount === 0 ||
              selectedCount === 0 ||
              Boolean(startError)
            }
            title={
              selectedCount === 0
                ? "当前没有精选照片"
                : preflight?.summary.photoCount === 0
                  ? "当前没有可导出的照片"
                  : "开始复制精选文件"
            }
            onClick={() => void handleConfirm()}
          >
            确认导出
          </Button>
        ) : null}
      </div>
    </div>
  );

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="导出精选"
      description={albumName ? `相册：${albumName} · 增量复制到固定精选目录` : "增量复制到固定精选目录"}
      size="lg"
      closeDisabled={startMutation.isPending}
      testId="export-modal"
      footer={footer}
    >
      {loading ? (
        <div className="space-y-4" aria-label="正在生成导出预检">
          <Skeleton className="h-20 w-full" />
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Skeleton className="h-16" />
            <Skeleton className="h-16" />
            <Skeleton className="h-16" />
            <Skeleton className="h-16" />
          </div>
          <Skeleton className="h-32 w-full" />
          <p className="text-xs text-ink-400">正在扫描当前相册的精选照片并比较目标目录，请稍候…</p>
        </div>
      ) : loadError ? (
        <div>
          <ErrorState error={loadError} title="无法生成导出预检" onRetry={() => setReloadKey((key) => key + 1)} />
          <p className="mt-3 text-xs leading-relaxed text-ink-500">没有复制任何文件。请检查服务状态后重试。</p>
        </div>
      ) : preflight ? (
        <div className="space-y-4">
          <div className="rounded-lg border border-white/[0.07] bg-white/[0.02] px-3 py-2 text-xs leading-relaxed text-ink-300">
            {preflight.message}
          </div>

          <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[
              { label: "精选照片", value: `${preflight.summary.photoCount} 张` },
              { label: "JPG", value: `${preflight.summary.jpgCount} 个` },
              { label: "RAW", value: `${preflight.summary.rawCount} 个` },
              { label: "总字节", value: formatBytes(preflight.summary.totalBytes) },
            ].map((item) => (
              <div key={item.label} className="rounded-lg border border-white/[0.07] bg-ink-850 px-3 py-2">
                <dt className="text-[10px] text-ink-500">{item.label}</dt>
                <dd className="mt-0.5 font-mono text-sm tabular-nums text-ink-100">{item.value}</dd>
              </div>
            ))}
          </dl>

          <div className="grid gap-2 sm:grid-cols-3">
            <div className="rounded-lg border border-white/[0.07] bg-ink-850 px-3 py-2">
              <p className="text-[10px] text-ink-500">将复制</p>
              <p className="font-mono text-sm tabular-nums text-emerald-300">{preflight.summary.toCopyCount}</p>
            </div>
            <div className="rounded-lg border border-white/[0.07] bg-ink-850 px-3 py-2">
              <p className="text-[10px] text-ink-500">已存在，增量跳过</p>
              <p className="font-mono text-sm tabular-nums text-sky-300">{preflight.summary.existingCount}</p>
            </div>
            <div className="rounded-lg border border-white/[0.07] bg-ink-850 px-3 py-2">
              <p className="text-[10px] text-ink-500">同名不同内容冲突</p>
              <p
                className={
                  preflight.summary.conflictCount > 0
                    ? "font-mono text-sm tabular-nums text-amber-300"
                    : "font-mono text-sm tabular-nums text-ink-200"
                }
              >
                {preflight.summary.conflictCount}
              </p>
            </div>
          </div>

          <div className="rounded-lg border border-white/[0.07] bg-white/[0.02] px-3 py-2.5">
            <p className="flex items-center gap-1.5 text-[11px] font-medium text-ink-300">
              <FolderOpen className="h-3.5 w-3.5 text-accent-400" aria-hidden="true" /> 目标目录
            </p>
            <p className="mt-1 break-all font-mono text-[11px] text-ink-200">{preflight.destinationAbsolutePath}</p>
            <p className="mt-1 break-all font-mono text-[10px] text-ink-500">{preflight.destinationRelativePath}/JPG · /RAW</p>
          </div>

          {preflight.summary.conflictCount > 0 ? (
            <p className="flex items-start gap-1.5 rounded-lg border border-amber-500/25 bg-amber-500/[0.06] px-3 py-2 text-[11px] leading-relaxed text-amber-200">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              目标目录存在 {preflight.summary.conflictCount} 个同名但内容不同的文件。导出不会覆盖，它们会被记录为冲突，请在导出结果和异常中心查看。
            </p>
          ) : null}

          {warnings.length > 0 ? (
            <section aria-label="导出警告" className="rounded-lg border border-amber-500/25 bg-amber-500/[0.05] px-3 py-2.5">
              <h3 className="flex items-center gap-1.5 text-xs font-semibold text-amber-200">
                <AlertCircle className="h-3.5 w-3.5" aria-hidden="true" /> {warnings.length} 条警告
              </h3>
              <ul className="mt-2 max-h-40 space-y-1.5 overflow-y-auto pr-1">
                {warnings.map((warning, index) => (
                  <li key={`${warning.code}-${warning.groupId ?? warning.relativePath ?? index}`} className="rounded border border-amber-500/15 bg-black/20 px-2 py-1.5">
                    <p className="text-[11px] text-amber-100">
                      {warning.displayName ? `${warning.displayName}：` : ""}
                      {warning.message}
                    </p>
                    <p className="mt-0.5 break-all font-mono text-[10px] text-ink-500">
                      {[warning.code, warning.relativePath].filter(Boolean).join(" · ")}
                    </p>
                  </li>
                ))}
              </ul>
              <p className="mt-1.5 text-[10px] text-ink-500">警告项目会被排除或单独记录，不会假装成功。</p>
            </section>
          ) : null}

          <p className="flex items-center gap-1.5 text-[10px] text-ink-500">
            <Clock3 className="h-3 w-3" aria-hidden="true" />
            预检在 {preflight.expiresAt ? formatDateTime(preflight.expiresAt) : "一段时间后"} 过期。执行前会再次校验源文件。
          </p>

          {startError ? (
            <div>
              <ErrorState
                error={startError}
                title="导出未启动"
                onRetry={() => {
                  setReloadKey((key) => key + 1);
                }}
                retryLabel="重新预检"
              />
              <p className="mt-2 text-[11px] leading-relaxed text-ink-500">
                如果预检过期或文件发生变化，本次导出不会开始。请重新预检后确认。
              </p>
            </div>
          ) : null}

          {selectedCount === 0 ? (
            <p className="rounded-lg border border-white/[0.07] px-3 py-3 text-xs text-ink-400">
              当前没有精选照片。请先按 F 标记精选，再导出。
            </p>
          ) : null}

          {jobId ? (
            <section
              data-testid="export-progress"
              aria-label="导出进度"
              className="rounded-lg border border-sky-500/25 bg-sky-500/[0.05] px-3 py-3"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="flex items-center gap-1.5 text-xs font-semibold text-sky-200">
                  {finished ? <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" /> : <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
                  {job?.status === "queued" ? "导出排队中" : finished ? "导出任务已结束" : "正在导出精选"}
                </h3>
                {job ? <StatusChip tone={job.status === "failed" ? "danger" : finished ? "success" : "info"}>{job.status === "failed" ? "失败" : finished ? "完成" : "运行中"}</StatusChip> : null}
              </div>
              <div
                className="mt-2 h-2 overflow-hidden rounded-full bg-white/10"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={totalFiles || 100}
                aria-valuenow={totalFiles ? processed : undefined}
                aria-label="导出文件进度"
              >
                <div
                  className={
                    totalFiles
                      ? "h-full rounded-full bg-accent-500 transition-[width] duration-300"
                      : "h-full w-1/3 animate-pulse rounded-full bg-accent-500/70"
                  }
                  style={totalFiles ? { width: `${progressPercent}%` } : undefined}
                />
              </div>
              <p className="mt-1.5 font-mono text-[11px] tabular-nums text-ink-300">
                {totalFiles ? `${processed} / ${totalFiles} 个文件 · ${progressPercent}%` : "正在准备文件清单…"}
              </p>
              <div className="mt-2 grid grid-cols-2 gap-2 text-[11px] sm:grid-cols-4">
                <span className="text-emerald-300">成功 {progress?.successFiles ?? 0}</span>
                <span className="text-sky-300">跳过 {progress?.skippedFiles ?? 0}</span>
                <span className="text-amber-300">冲突 {progress?.conflictFiles ?? 0}</span>
                <span className="text-red-300">失败 {progress?.failedFiles ?? 0}</span>
              </div>
              {jobQuery.isError ? (
                <div className="mt-2">
                  <ErrorState
                    error={jobQuery.error}
                    compact
                    title="无法读取导出任务进度"
                    onRetry={() => void jobQuery.refetch()}
                  />
                  <p className="mt-1 text-[10px] text-ink-500">任务仍在后端运行，可关闭窗口后到操作记录查看。</p>
                </div>
              ) : null}
              {job?.status === "failed" ? (
                <div className="mt-2 rounded-md border border-red-500/25 bg-red-500/[0.08] px-2 py-2" role="alert">
                  <p className="text-xs font-medium text-red-200">导出任务失败</p>
                  <p className="mt-1 whitespace-pre-wrap break-words font-mono text-[10px] leading-relaxed text-ink-300">
                    {job.error ?? "后端未提供错误详情，请查看操作记录。"}
                  </p>
                </div>
              ) : null}
            </section>
          ) : null}

          {startResult && (finished || finalOperation) ? (
            <section
              data-testid="export-result"
              aria-label="导出结果"
              className="rounded-lg border border-white/[0.07] bg-white/[0.02] px-3 py-3"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="flex items-center gap-1.5 text-xs font-semibold text-ink-100">
                  <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" aria-hidden="true" />
                  导出结果
                </h3>
                {finalOperation ? <OperationStatusChip status={finalOperation.status} /> : null}
              </div>
              {startResult.idempotentReplay ? (
                <p className="mt-1 text-[11px] text-ink-500">幂等重放：没有创建新的导出任务。</p>
              ) : null}
              {detailLoading ? <Skeleton className="mt-2 h-14 w-full" /> : null}
              {detailError ? (
                <ErrorState
                  error={detailError}
                  compact
                  title="无法读取逐文件导出明细"
                  onRetry={() => {
                    if (job?.operationId) {
                      setDetailLoading(true);
                      api
                        .getOperation(job.operationId)
                        .then((response) => setOperationDetail(response.operation))
                        .catch((error: unknown) => setDetailError(error))
                        .finally(() => setDetailLoading(false));
                    }
                  }}
                  retryLabel="重新读取"
                />
              ) : null}
              {finalOperation ? (
                <>
                  <p className="mt-1 text-[11px] text-ink-400">
                    照片 {finalOperation.requestedPhotoCount} 张 · 文件 {finalOperation.requestedFileCount} 个 · 成功{" "}
                    {finalOperation.successFileCount} · 跳过 {finalOperation.skippedFileCount} · 冲突{" "}
                    {finalOperation.conflictFileCount} · 失败 {finalOperation.failedFileCount}
                  </p>
                  {finalOperation.errorSummary ? (
                    <p className="mt-1 text-[11px] leading-relaxed text-amber-200">{finalOperation.errorSummary}</p>
                  ) : null}
                  {failedItems.length > 0 ? (
                    <ul className="mt-2 space-y-1.5" aria-label="导出失败与冲突明细">
                      {failedItems.map((item) => (
                        <li key={item.id} className="rounded border border-red-500/25 bg-red-500/[0.05] px-2 py-1.5">
                          <div className="flex flex-wrap items-center gap-2">
                            <ItemResultChip result={item.result} />
                            <span className="break-all font-mono text-[11px] text-ink-200">{item.sourceRelativePath}</span>
                          </div>
                          <p className="mt-0.5 text-[10px] text-red-200">
                            {[item.errorCode, item.errorMessage].filter(Boolean).join(" · ") || "未提供错误信息"}
                          </p>
                          {item.destinationPath ? (
                            <p className="mt-0.5 break-all font-mono text-[10px] text-ink-500">目标：{item.destinationPath}</p>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-1 text-[11px] text-emerald-300">逐文件结果中没有失败或冲突项。</p>
                  )}
                  <p className="mt-1.5 text-[10px] text-ink-500">原相册文件未被改动；取消精选不会删除已导出的副本。</p>
                </>
              ) : finished && job ? (
                <p className="mt-1 text-[11px] text-ink-400">
                  任务已结束，正在读取逐文件明细… 也可以稍后在操作记录中查看。
                </p>
              ) : null}
            </section>
          ) : null}
        </div>
      ) : null}
    </Modal>
  );
}
