import { useEffect, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  FileWarning,
  RotateCcw,
  ShieldAlert,
} from "lucide-react";
import type { OperationItem } from "../../lib/api";
import { formatBytes, formatDateTime, formatFileHash } from "../../lib/format";
import { OPERATION_TYPE_LABELS } from "../../lib/labels";
import { describeError } from "../../lib/messages";
import { useApp } from "../../context/AppContext";
import { useOperationDetail } from "../../hooks/useApiQueries";
import { useRestoreOperation } from "../../hooks/useMutations";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { ErrorState, Skeleton } from "../ui/StateViews";
import { ItemResultChip, OperationStatusChip, StatusChip } from "../StatusChips";

interface OperationDetailDialogProps {
  operationId: string | null;
  onClose: () => void;
}

function failedRestoreItems(items: OperationItem[] | undefined): OperationItem[] {
  return (items ?? []).filter((item) => item.result === "failed" || item.result === "conflict");
}

export function OperationDetailDialog({ operationId, onClose }: OperationDetailDialogProps) {
  const { toast } = useApp();
  const detailQuery = useOperationDetail(operationId);
  const restoreMutation = useRestoreOperation();
  const [restoreArmed, setRestoreArmed] = useState(false);
  const [restoreError, setRestoreError] = useState<unknown>(null);
  const [restoreSummary, setRestoreSummary] = useState<string | null>(null);
  const [restoreFailures, setRestoreFailures] = useState<OperationItem[]>([]);

  useEffect(() => {
    setRestoreArmed(false);
    setRestoreError(null);
    setRestoreSummary(null);
    setRestoreFailures([]);
  }, [operationId]);

  const operation = detailQuery.data?.operation;
  const isOrganizeUndo = operation?.type === "organize";
  const destinationLabel =
    operation?.type === "cleanup"
      ? "废纸篓 / 目标位置"
      : operation?.type === "organize"
        ? "整理后目标位置"
        : operation?.type === "organize_undo"
          ? "原路径（目标）"
          : "目标相对路径";

  async function handleRestore() {
    if (!operation) return;
    setRestoreError(null);
    setRestoreSummary(null);
    setRestoreFailures([]);
    try {
      const result = await restoreMutation.mutateAsync(operation.id);
      const restoreOperation = result.operation;
      setRestoreArmed(false);
      setRestoreFailures(failedRestoreItems(restoreOperation?.items));
      const summary = restoreOperation
        ? `成功 ${restoreOperation.successFileCount}，失败 ${restoreOperation.failedFileCount}，冲突 ${restoreOperation.conflictFileCount}。`
        : "该清理操作此前已经完成恢复。";
      setRestoreSummary(summary);
      if (result.alreadyRestored) {
        toast({ variant: "info", title: "该操作已经恢复过", description: "没有文件被重复移动。" });
      } else if (restoreOperation && restoreOperation.status === "success") {
        toast({
          variant: "success",
          title: isOrganizeUndo ? "撤销整理完成" : "恢复完成",
          description: isOrganizeUndo ? "文件已移回整理前的位置。" : "文件已回到原路径。",
        });
      } else {
        toast({
          variant: "error",
          title: isOrganizeUndo ? "撤销整理未全部完成" : "恢复未全部成功",
          description:
            restoreOperation?.errorSummary ??
            (isOrganizeUndo
              ? "部分文件未能移回。请查看逐文件结果，必要时在 Finder 中核对。"
              : "部分文件未能恢复。请查看逐文件结果，必要时到 Finder 废纸篓手动恢复。"),
          durationMs: 12000,
        });
      }
    } catch (error) {
      setRestoreError(error);
      const friendly = describeError(error);
      toast({ ...friendly, variant: "error" });
    }
  }

  const typeLabel = operation ? OPERATION_TYPE_LABELS[operation.type] : "操作";

  return (
    <Modal
      open={Boolean(operationId)}
      onClose={onClose}
      title={`${typeLabel}详情`}
      description={operation ? `操作 ID：${operation.id}` : "清理、恢复、导出、整理与扫描的逐文件记录"}
      size="xl"
      closeDisabled={restoreMutation.isPending}
      testId="operation-detail"
      footer={
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-[10px] text-ink-500">操作记录为追加式审计记录，不会因后续扫描被覆盖。</p>
          <Button variant="secondary" onClick={onClose} disabled={restoreMutation.isPending}>
            关闭
          </Button>
        </div>
      }
    >
      {detailQuery.isPending ? (
        <div className="space-y-3">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      ) : detailQuery.isError ? (
        <ErrorState
          error={detailQuery.error}
          title="无法读取操作详情"
          onRetry={() => void detailQuery.refetch()}
        />
      ) : operation ? (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <OperationStatusChip status={operation.status} />
              <StatusChip tone="neutral">{typeLabel}</StatusChip>
              <span className="text-xs text-ink-300">{operation.albumName ?? "无关联相册"}</span>
              {operation.restoredAt ? <StatusChip tone="accent">已恢复 {formatDateTime(operation.restoredAt)}</StatusChip> : null}
            </div>
            {operation.canRestore ? (
              <Button
                variant="secondary"
                icon={RotateCcw}
                onClick={() => setRestoreArmed(true)}
                disabled={restoreArmed || restoreMutation.isPending}
              >
                {isOrganizeUndo ? "撤销整理" : "尝试恢复"}
              </Button>
            ) : null}
          </div>

          <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[
              { label: "请求照片", value: `${operation.requestedPhotoCount}` },
              { label: "请求文件", value: `${operation.requestedFileCount}` },
              { label: "成功文件", value: `${operation.successFileCount}` },
              { label: "失败 / 冲突", value: `${operation.failedFileCount} / ${operation.conflictFileCount}` },
              { label: "请求时间", value: formatDateTime(operation.requestedAt) },
              { label: "开始时间", value: formatDateTime(operation.startedAt) },
              { label: "结束时间", value: formatDateTime(operation.finishedAt) },
              { label: "跳过文件", value: `${operation.skippedFileCount}` },
            ].map((item) => (
              <div key={item.label} className="rounded-lg border border-white/[0.07] bg-ink-850 px-3 py-2">
                <dt className="text-[10px] text-ink-500">{item.label}</dt>
                <dd className="mt-0.5 truncate font-mono text-[11px] tabular-nums text-ink-100" title={item.value}>
                  {item.value}
                </dd>
              </div>
            ))}
          </dl>

          {operation.errorSummary ? (
            <div className="flex items-start gap-2 rounded-lg border border-red-500/25 bg-red-500/[0.06] px-3 py-2.5" role="alert">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" aria-hidden="true" />
              <div>
                <p className="text-xs font-medium text-red-200">错误摘要</p>
                <p className="mt-0.5 text-[11px] leading-relaxed text-ink-300">{operation.errorSummary}</p>
              </div>
            </div>
          ) : null}

          {restoreArmed ? (
            <div className="rounded-lg border border-sky-500/25 bg-sky-500/[0.06] px-3 py-2.5" role="alert">
              <p className="flex items-center gap-1.5 text-xs font-semibold text-sky-200">
                <ShieldAlert className="h-3.5 w-3.5" aria-hidden="true" />{" "}
                {isOrganizeUndo ? "确认撤销本次整理？" : "确认尝试恢复？"}
              </p>
              <p className="mt-1 text-[11px] leading-relaxed text-ink-300">
                {isOrganizeUndo
                  ? "只会把本次实际移动的文件移回整理前的原路径；原本已在 JPG/RAW 的文件不会移动。原路径已有新文件时不会覆盖。"
                  : "只会把本操作中实际移入废纸篓的文件移回原路径；原路径已有新文件时不会覆盖。废纸篓已清空的项目会失败，可在 Finder 废纸篓中手动恢复。"}
              </p>
              <div className="mt-2 flex items-center gap-2">
                <Button
                  variant="primary"
                  size="sm"
                  icon={RotateCcw}
                  loading={restoreMutation.isPending}
                  onClick={() => void handleRestore()}
                >
                  {isOrganizeUndo ? "确认撤销整理" : "确认恢复"}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setRestoreArmed(false)} disabled={restoreMutation.isPending}>
                  取消
                </Button>
              </div>
            </div>
          ) : null}

          {restoreError ? (
            <ErrorState
              error={restoreError}
              title={isOrganizeUndo ? "撤销整理请求未完成" : "恢复请求未完成"}
              onRetry={() => void handleRestore()}
              retryLabel={isOrganizeUndo ? "再次尝试撤销" : "再次尝试恢复"}
            />
          ) : null}

          {restoreSummary ? (
            <div
              className={
                restoreFailures.length > 0
                  ? "rounded-lg border border-red-500/25 bg-red-500/[0.05] px-3 py-2.5"
                  : "rounded-lg border border-emerald-500/25 bg-emerald-500/[0.05] px-3 py-2.5"
              }
            >
              <p className="flex items-center gap-1.5 text-xs font-medium text-ink-100">
                {restoreFailures.length > 0 ? (
                  <FileWarning className="h-3.5 w-3.5 text-red-300" aria-hidden="true" />
                ) : (
                  <CheckCircle2 className="h-3.5 w-3.5 text-emerald-300" aria-hidden="true" />
                )}
                {isOrganizeUndo ? "撤销整理结果" : "恢复结果"}
              </p>
              <p className="mt-1 text-[11px] text-ink-300">{restoreSummary}</p>
              {restoreFailures.length > 0 ? (
                <ul className="mt-2 space-y-1.5">
                  {restoreFailures.map((item) => (
                    <li key={item.id} className="rounded border border-red-500/20 bg-black/20 px-2 py-1.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <ItemResultChip result={item.result} />
                        <span className="break-all font-mono text-[11px] text-ink-300">{item.sourceRelativePath ?? item.displayName}</span>
                      </div>
                      <p className="mt-0.5 text-[10px] text-red-200">
                        {[item.errorCode, item.errorMessage].filter(Boolean).join(" · ") || "未提供错误信息"}
                      </p>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}

          <section aria-label="逐文件明细">
            <div className="mb-2 flex items-center justify-between gap-2">
              <h3 className="text-xs font-semibold text-ink-200">逐文件明细</h3>
              <span className="text-[10px] text-ink-500">{operation.items.length} 条</span>
            </div>
            {operation.items.length === 0 ? (
              <p className="rounded-lg border border-white/[0.07] px-3 py-6 text-center text-xs text-ink-400">
                该操作没有逐文件明细（例如只读扫描）。
              </p>
            ) : (
              <div className="overflow-x-auto rounded-lg border border-white/[0.07]">
                <table className="w-full min-w-[780px] border-collapse text-left">
                  <thead className="bg-ink-850 text-[10px] uppercase tracking-wide text-ink-500">
                    <tr>
                      <th scope="col" className="px-2.5 py-2 font-medium">文件</th>
                      <th scope="col" className="px-2.5 py-2 font-medium">结果</th>
                      <th scope="col" className="px-2.5 py-2 font-medium">{destinationLabel}</th>
                      <th scope="col" className="px-2.5 py-2 font-medium">大小</th>
                      <th scope="col" className="px-2.5 py-2 font-medium">SHA-256</th>
                      <th scope="col" className="px-2.5 py-2 font-medium">错误</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/[0.05]">
                    {operation.items.map((item) => (
                      <tr key={item.id} className="align-top text-[11px]">
                        <td className="max-w-[260px] px-2.5 py-2">
                          <p className="font-medium text-ink-200">{item.displayName ?? "—"}</p>
                          <p className="mt-0.5 break-all font-mono text-[10px] text-ink-400">{item.sourceRelativePath ?? "—"}</p>
                        </td>
                        <td className="px-2.5 py-2">
                          <ItemResultChip result={item.result} />
                        </td>
                        <td className="max-w-[240px] px-2.5 py-2">
                          <p className="break-all font-mono text-[10px] text-ink-400">{item.destinationPath ?? "—"}</p>
                        </td>
                        <td className="whitespace-nowrap px-2.5 py-2 font-mono tabular-nums text-ink-300">
                          {formatBytes(item.sourceSizeBytes)}
                        </td>
                        <td className="px-2.5 py-2">
                          <span className="font-mono text-[10px] text-ink-400" title={item.contentSha256 ?? "未计算"}>
                            {formatFileHash(item.contentSha256)}
                          </span>
                        </td>
                        <td className="max-w-[220px] px-2.5 py-2">
                          {item.errorCode || item.errorMessage ? (
                            <>
                              <p className="font-mono text-[10px] text-red-300">{item.errorCode ?? "ERROR"}</p>
                              <p className="mt-0.5 break-words text-[10px] leading-relaxed text-ink-400">{item.errorMessage}</p>
                            </>
                          ) : (
                            <span className="text-ink-600">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <p className="text-[10px] leading-relaxed text-ink-500">
            操作记录保存在本地数据库中，不会写入源相册，也不会自动清除。清理记录中的目标位置为 macOS 废纸篓返回的实际路径；整理记录中的目标位置为相册内相对路径。
          </p>
        </div>
      ) : null}
    </Modal>
  );
}
