import { useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Info,
  RotateCcw,
  ShieldAlert,
  Trash2,
  Undo2,
} from "lucide-react";
import {
  api,
  type CleanupExecuteResponse,
  type CleanupPreflight,
  type OperationItem,
  type RestoreResponse,
} from "../../lib/api";
import { useApp } from "../../context/AppContext";
import { describeError } from "../../lib/messages";
import { createId } from "../../lib/id";
import { formatBytes, formatDateTime } from "../../lib/format";
import { useCleanupExecute, useRestoreOperation } from "../../hooks/useMutations";
import { Modal } from "../ui/Modal";
import { HoverPreview } from "../ui/HoverPreview";
import { Button } from "../ui/Button";
import { ErrorState, Skeleton } from "../ui/StateViews";
import { ItemResultChip, OperationStatusChip, StatusChip } from "../StatusChips";

interface CleanupDialogProps {
  open: boolean;
  albumId: string;
  albumName: string | null;
  onClose: () => void;
  onPauseAutoplay: () => void;
}

const WARNING_TEXT = "文件将移入 macOS 废纸篓，不会永久删除。";

function failedItems(items: OperationItem[] | undefined): OperationItem[] {
  return (items ?? []).filter((item) => item.result === "failed" || item.result === "conflict");
}

export function CleanupDialog({ open, albumId, albumName, onClose, onPauseAutoplay }: CleanupDialogProps) {
  const { settings, updateSettings, toast } = useApp();
  const cleanupMutation = useCleanupExecute(albumId);
  const restoreMutation = useRestoreOperation();

  const [preflight, setPreflight] = useState<CleanupPreflight | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [executeResult, setExecuteResult] = useState<CleanupExecuteResponse | null>(null);
  const [executeError, setExecuteError] = useState<unknown>(null);
  const [undoResult, setUndoResult] = useState<RestoreResponse | null>(null);
  const [undoError, setUndoError] = useState<unknown>(null);
  const [showBackupNotice, setShowBackupNotice] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const idempotencyKeyRef = useRef<string | null>(null);
  const backupNoticeMarkedRef = useRef(false);

  useEffect(() => {
    if (!open) return;
    setPreflight(null);
    setLoadError(null);
    setExecuteResult(null);
    setExecuteError(null);
    setUndoResult(null);
    setUndoError(null);
    idempotencyKeyRef.current = null;
    backupNoticeMarkedRef.current = false;
    setShowBackupNotice(!settings.cleanupNoticeSeen);
    onPauseAutoplay();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在打开/重试时读取一次设置
  }, [open, reloadKey]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    setPreflight(null);
    api
      .cleanupPreflight(albumId)
      .then((result) => {
        if (cancelled) return;
        setPreflight(result);
        if (!backupNoticeMarkedRef.current && !settings.cleanupNoticeSeen) {
          backupNoticeMarkedRef.current = true;
          void updateSettings({ cleanupNoticeSeen: true }).catch(() => undefined);
        }
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- settings 只影响首次提示，不应重新请求预检
  }, [open, albumId, reloadKey]);

  useEffect(() => {
    if (!open) return;
    const until = executeResult?.undoAvailableUntil;
    if (!until) {
      setSecondsLeft(0);
      return;
    }
    const end = new Date(until).getTime();
    const update = () => setSecondsLeft(Math.max(0, Math.ceil((end - Date.now()) / 1000)));
    update();
    const timer = window.setInterval(update, 250);
    return () => window.clearInterval(timer);
  }, [executeResult, open]);

  const operation = executeResult?.operation ?? null;
  const blocked = Boolean(preflight?.blocked);
  const noPhotos = Boolean(preflight && preflight.summary.photoCount === 0);
  const busy = cleanupMutation.isPending || restoreMutation.isPending;
  const failed = failedItems(operation?.items);
  const undoFailed = failedItems(undoResult?.operation?.items);
  const seriousErrors = executeResult?.seriousErrors ?? [];
  const groupSummary = executeResult?.groupSummary ?? null;

  async function handleConfirm() {
    if (!preflight?.token) return;
    onPauseAutoplay();
    setExecuteError(null);
    setUndoResult(null);
    setUndoError(null);
    if (!idempotencyKeyRef.current) idempotencyKeyRef.current = createId();
    try {
      const result = await cleanupMutation.mutateAsync({
        token: preflight.token,
        idempotencyKey: idempotencyKeyRef.current,
      });
      setExecuteResult(result);
      if ((result.seriousErrors?.length ?? 0) > 0) {
        toast({
          variant: "error",
          title: "清理出现严重错误，请立即核对",
          description:
            result.operation.errorSummary ??
            "部分文件回滚失败，可能同时存在于原位置和废纸篓。请查看严重错误列表，不要重复操作。",
          durationMs: 15000,
        });
      } else if (result.operation.status === "success") {
        toast({
          variant: "success",
          title: "清理完成",
          description: `已把 ${result.operation.successFileCount} 个文件移入 macOS 废纸篓。可在 15 秒内撤销。`,
        });
      } else {
        toast({
          variant: "error",
          title: "清理未全部成功",
          description:
            result.operation.errorSummary ??
            `成功 ${result.operation.successFileCount}，失败 ${result.operation.failedFileCount}，冲突 ${result.operation.conflictFileCount}。`,
        });
      }
    } catch (error) {
      setExecuteError(error);
      const friendly = describeError(error);
      toast({ ...friendly, variant: "error" });
    }
  }

  async function handleUndo() {
    if (!operation) return;
    setUndoError(null);
    try {
      const result = await restoreMutation.mutateAsync(operation.id);
      setUndoResult(result);
      if (result.alreadyRestored) {
        toast({ variant: "info", title: "该清理操作已经恢复过", description: "没有文件被重复移动。" });
      } else if (result.operation && result.operation.status === "success") {
        toast({ variant: "success", title: "撤销成功", description: "文件已恢复到原路径。" });
      } else {
        toast({
          variant: "error",
          title: "撤销未全部成功",
          description:
            result.operation?.errorSummary ?? "部分文件未能恢复，请查看逐文件结果或到 Finder 废纸篓手动恢复。",
        });
      }
    } catch (error) {
      setUndoError(error);
      const friendly = describeError(error);
      toast({ ...friendly, variant: "error" });
    }
  }

  function handleClose() {
    if (busy) return;
    onClose();
  }

  const footer = executeResult ? (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {operation?.canRestore && secondsLeft > 0 && !undoResult ? (
        <Button
          variant="secondary"
          icon={Undo2}
          data-testid="cleanup-undo"
          loading={restoreMutation.isPending}
          onClick={() => void handleUndo()}
        >
          撤销清理（{secondsLeft}s）
        </Button>
      ) : null}
      <Button variant="secondary" onClick={handleClose} disabled={busy}>
        关闭
      </Button>
    </div>
  ) : (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <Button variant="secondary" data-testid="cleanup-cancel" onClick={handleClose} disabled={busy}>
        取消
      </Button>
      <Button
        variant="danger"
        icon={Trash2}
        data-testid="cleanup-confirm"
        loading={cleanupMutation.isPending}
        disabled={loading || !preflight?.token || blocked || noPhotos || Boolean(executeError)}
        title={blocked ? "存在阻止项，无法执行清理" : noPhotos ? "没有待删除照片" : "确认移入废纸篓"}
        onClick={() => void handleConfirm()}
      >
        确认移入废纸篓
      </Button>
    </div>
  );

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="清理待删除"
      description={albumName ? `相册：${albumName} · 清理前会强制重新扫描并校验文件指纹` : "清理前会强制重新扫描并校验文件指纹"}
      size="lg"
      closeDisabled={busy}
      testId="cleanup-modal"
      footer={footer}
    >
      {loading ? (
        <div className="space-y-4" aria-label="正在生成清理预检">
          <Skeleton className="h-24 w-full" />
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Skeleton className="h-16" />
            <Skeleton className="h-16" />
            <Skeleton className="h-16" />
            <Skeleton className="h-16" />
          </div>
          <Skeleton className="h-40 w-full" />
          <p className="text-xs text-ink-400">正在重新扫描相册并校验文件，请稍候…</p>
        </div>
      ) : loadError ? (
        <div>
          <ErrorState error={loadError} title="无法生成清理预检" onRetry={() => setReloadKey((key) => key + 1)} />
          <p className="mt-3 text-xs leading-relaxed text-ink-500">
            没有任何文件被移动。请检查后端状态，或在异常中心查看相册问题后重试。
          </p>
        </div>
      ) : preflight ? (
        <div className="space-y-4">
          <div
            className={
              blocked
                ? "flex items-start gap-2.5 rounded-lg border border-red-500/30 bg-red-500/[0.07] px-3 py-2.5"
                : "flex items-start gap-2.5 rounded-lg border border-amber-500/25 bg-amber-500/[0.06] px-3 py-2.5"
            }
          >
            <ShieldAlert
              className={blocked ? "mt-0.5 h-4 w-4 shrink-0 text-red-400" : "mt-0.5 h-4 w-4 shrink-0 text-amber-300"}
              aria-hidden="true"
            />
            <div>
              <p className={blocked ? "text-sm font-semibold text-red-200" : "text-sm font-semibold text-amber-200"}>
                {WARNING_TEXT}
              </p>
              <p className="mt-1 text-[11px] leading-relaxed text-ink-400">
                清理会把 JPG 与配对的 RAW 作为一组同时移入系统废纸篓，不会写入原文件，也不提供永久删除。
              </p>
            </div>
          </div>

          {showBackupNotice ? (
            <div className="rounded-lg border border-sky-500/25 bg-sky-500/[0.06] px-3 py-2.5">
              <p className="flex items-center gap-1.5 text-xs font-medium text-sky-200">
                <Info className="h-3.5 w-3.5" aria-hidden="true" /> 首次清理提示
              </p>
              <ul className="mt-1.5 list-disc space-y-1 pl-4 text-[11px] leading-relaxed text-ink-300">
                <li>本应用只把文件移入 macOS 废纸篓，不执行永久删除。</li>
                <li>重要照片仍建议保留独立备份。</li>
                <li>清空 macOS 废纸篓后，本应用无法保证恢复。</li>
              </ul>
            </div>
          ) : null}

          <div className="rounded-lg border border-white/[0.07] bg-white/[0.02] px-3 py-2 text-xs leading-relaxed text-ink-300">
            {preflight.message}
          </div>

          <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[
              { label: "待删除照片", value: `${preflight.summary.photoCount} 张` },
              { label: "将移动文件", value: `${preflight.summary.fileCount} 个` },
              { label: "预计释放", value: formatBytes(preflight.summary.totalBytes) },
              {
                label: "JPG / RAW",
                value: `${preflight.summary.jpgCount} / ${preflight.summary.rawCount}`,
              },
            ].map((item) => (
              <div key={item.label} className="rounded-lg border border-white/[0.07] bg-ink-850 px-3 py-2">
                <dt className="text-[10px] text-ink-500">{item.label}</dt>
                <dd className="mt-0.5 font-mono text-sm tabular-nums text-ink-100">{item.value}</dd>
              </div>
            ))}
          </dl>

          {preflight.blockers.length > 0 ? (
            <div
              data-testid="cleanup-blockers"
              role="alert"
              className="rounded-lg border border-red-500/30 bg-red-500/[0.06] px-3 py-2.5"
            >
              <p className="flex items-center gap-1.5 text-xs font-semibold text-red-200">
                <AlertCircle className="h-3.5 w-3.5" aria-hidden="true" />
                存在 {preflight.blockers.length} 个阻止项，整批清理已禁用
              </p>
              <p className="mt-1 text-[11px] leading-relaxed text-ink-400">
                一期不支持“忽略异常并删除其余文件”。请先在异常中心处理文件缺失或配对冲突，再重新预检。
              </p>
              <ul className="mt-2 space-y-1.5">
                {preflight.blockers.map((blocker, index) => (
                  <li key={`${blocker.code}-${blocker.groupId ?? index}`} className="rounded border border-red-500/15 bg-black/20 px-2 py-1.5">
                    <p className="text-[11px] text-red-200">
                      {blocker.displayName ? `${blocker.displayName}：` : ""}
                      {blocker.message}
                    </p>
                    <p className="mt-0.5 font-mono text-[10px] text-ink-500">
                      {[blocker.code, blocker.relativePath].filter(Boolean).join(" · ")}
                    </p>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <section aria-label="待清理照片文件清单">
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-xs font-semibold text-ink-200">文件清单</h3>
              <span className="text-[10px] text-ink-500">按逻辑照片分组</span>
            </div>
            {preflight.groups.length === 0 ? (
              <div className="rounded-lg border border-white/[0.07] px-3 py-6 text-center text-xs text-ink-400">
                当前没有标记为待删除的照片。
              </div>
            ) : (
              <ul className="max-h-64 space-y-2 overflow-y-auto pr-1">
                {preflight.groups.map((group) => {
                  const primaryAsset =
                    group.assets.find((asset) => asset.kind === "jpg") ?? group.assets[0];
                  const version = primaryAsset?.mtimeNs ?? 0;
                  const thumbnailUrl = primaryAsset
                    ? `/api/photos/${group.groupId}/thumbnail?v=${version}`
                    : null;
                  const previewUrl = primaryAsset
                    ? `/api/photos/${group.groupId}/preview?v=${version}`
                    : null;
                  const groupBytes = group.assets.reduce((total, asset) => total + asset.sizeBytes, 0);
                  return (
                    <li
                      key={group.groupId}
                      className={
                        group.blocked
                          ? "rounded-lg border border-red-500/25 bg-red-500/[0.04] px-3 py-2"
                          : "rounded-lg border border-white/[0.07] bg-ink-850/60 px-3 py-2"
                      }
                    >
                      <div className="flex gap-2.5">
                        {thumbnailUrl && previewUrl ? (
                          <HoverPreview
                            thumbnailUrl={thumbnailUrl}
                            previewUrl={previewUrl}
                            alt={`${group.displayName} 待删除照片`}
                            caption={`${group.displayName} · ${group.assets.length} 个文件 · ${formatBytes(groupBytes)}`}
                            testId="cleanup-thumbnail"
                          />
                        ) : null}
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="font-mono text-xs text-ink-200">{group.displayName}</span>
                            <div className="flex items-center gap-1.5">
                              <StatusChip tone={group.pairingStatus === "normal" ? "neutral" : "warning"}>
                                {group.pairingStatus === "normal"
                                  ? "配对正常"
                                  : group.pairingStatus === "conflict"
                                    ? "配对冲突"
                                    : "文件缺失"}
                              </StatusChip>
                              {group.blocked ? (
                                <StatusChip icon={AlertTriangle} tone="danger">
                                  已阻止
                                </StatusChip>
                              ) : null}
                            </div>
                          </div>
                          <ul className="mt-1.5 space-y-1">
                            {group.assets.map((asset) => (
                              <li key={asset.assetId} className="flex items-center justify-between gap-2">
                                <span className="break-all font-mono text-[10px] text-ink-400">{asset.relativePath}</span>
                                <span className="shrink-0 text-[10px] text-ink-600">{formatBytes(asset.sizeBytes)}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {executeError ? (
            <div>
              <ErrorState
                error={executeError}
                title="清理未执行"
                onRetry={() => {
                  setReloadKey((key) => key + 1);
                }}
                retryLabel="重新预检"
              />
              <p className="mt-2 text-[11px] leading-relaxed text-ink-500">
                如果文件在预检后发生变化，整批操作会停止，不会移动任何文件。
              </p>
            </div>
          ) : null}

          {executeResult ? null : (
            <p className="flex items-center gap-1.5 text-[10px] text-ink-500">
              <Clock3 className="h-3 w-3" aria-hidden="true" />
              预检在 {preflight.expiresAt ? formatDateTime(preflight.expiresAt) : "一段时间后"} 过期；过期后需重新预检。
            </p>
          )}
        </div>
      ) : null}

      {executeResult && operation ? (
        <div className="mt-5 space-y-4 border-t border-white/[0.07] pt-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-ink-100">
              {seriousErrors.length > 0 ? (
                <AlertCircle className="h-4 w-4 text-red-400" aria-hidden="true" />
              ) : (
                <CheckCircle2 className="h-4 w-4 text-emerald-400" aria-hidden="true" />
              )}
              清理结果
            </h3>
            <OperationStatusChip status={operation.status} />
          </div>

          {seriousErrors.length > 0 ? (
            <section
              role="alert"
              aria-label="清理严重错误"
              className="rounded-lg border-2 border-red-500/50 bg-red-500/[0.1] px-3 py-3"
            >
              <h4 className="flex items-center gap-1.5 text-sm font-semibold text-red-200">
                <AlertCircle className="h-4 w-4" aria-hidden="true" />
                严重错误：{seriousErrors.length} 组文件回滚失败，需要人工核对
              </h4>
              <p className="mt-1 text-[11px] font-medium leading-relaxed text-red-100">
                这些组并非成功完成。文件可能同时存在于原位置和废纸篓，请先按下列实际位置核对，不要重复清理。
              </p>
              <ul className="mt-2 space-y-2">
                {seriousErrors.map((error, index) => (
                  <li key={`${error.photoGroupId ?? index}`} className="rounded border border-red-500/30 bg-black/30 px-2 py-2">
                    <p className="font-mono text-[11px] text-red-100">{error.displayName ?? error.photoGroupId ?? "未知照片组"}</p>
                    <p className="mt-1 text-[11px] leading-relaxed text-red-200">{error.message}</p>
                    {error.sourceRelativePath ? (
                      <p className="mt-1 break-all font-mono text-[10px] text-ink-400">源相对路径：{error.sourceRelativePath}</p>
                    ) : null}
                    {error.actualLocation ? (
                      <p className="mt-0.5 break-all font-mono text-[10px] text-ink-400">实际位置：{error.actualLocation}</p>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {groupSummary ? (
            <dl className="grid grid-cols-3 gap-2">
              {[
                { label: "请求组数", value: groupSummary.requested, tone: "text-ink-100" },
                { label: "成功组数", value: groupSummary.succeeded, tone: "text-emerald-300" },
                { label: "失败组数", value: groupSummary.failed, tone: groupSummary.failed > 0 ? "text-red-300" : "text-ink-200" },
              ].map((item) => (
                <div key={item.label} className="rounded-lg border border-white/[0.07] bg-ink-850 px-3 py-2">
                  <dt className="text-[10px] text-ink-500">{item.label}</dt>
                  <dd className={`mt-0.5 font-mono text-sm tabular-nums ${item.tone}`}>{item.value}</dd>
                </div>
              ))}
            </dl>
          ) : null}

          <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[
              { label: "成功文件", value: operation.successFileCount, tone: "text-emerald-300" },
              { label: "跳过", value: operation.skippedFileCount, tone: "text-sky-300" },
              { label: "失败", value: operation.failedFileCount, tone: "text-red-300" },
              { label: "冲突", value: operation.conflictFileCount, tone: "text-amber-300" },
            ].map((item) => (
              <div key={item.label} className="rounded-lg border border-white/[0.07] bg-ink-850 px-3 py-2">
                <dt className="text-[10px] text-ink-500">{item.label}</dt>
                <dd className={`mt-0.5 font-mono text-sm tabular-nums ${item.tone}`}>{item.value}</dd>
              </div>
            ))}
          </dl>
          {operation.errorSummary ? (
            <p className="rounded-lg border border-amber-500/25 bg-amber-500/[0.06] px-3 py-2 text-xs leading-relaxed text-amber-200">
              {operation.errorSummary}
            </p>
          ) : null}
          {executeResult.idempotentReplay ? (
            <p className="text-[11px] text-ink-500">这是一次幂等重放，没有重复移动文件。</p>
          ) : null}

          {failed.length > 0 ? (
            <section className="rounded-lg border border-red-500/25 bg-red-500/[0.05] px-3 py-2.5" aria-label="清理失败明细">
              <h4 className="flex items-center gap-1.5 text-xs font-semibold text-red-200">
                <AlertCircle className="h-3.5 w-3.5" aria-hidden="true" /> 以下文件未能成功处理
              </h4>
              <ul className="mt-2 space-y-1.5">
                {failed.map((item) => (
                  <li key={item.id} className="rounded border border-red-500/15 bg-black/20 px-2 py-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <ItemResultChip result={item.result} />
                      <span className="font-mono text-[11px] text-ink-200">{item.sourceRelativePath ?? item.displayName}</span>
                    </div>
                    <p className="mt-1 text-[10px] text-red-200">
                      {[item.errorCode, item.errorMessage].filter(Boolean).join(" · ") || "未提供错误信息"}
                    </p>
                    {item.destinationPath ? (
                      <p className="mt-0.5 break-all font-mono text-[10px] text-ink-500">废纸篓：{item.destinationPath}</p>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : (
            <p className="text-xs text-ink-400">逐文件结果均成功，没有失败项。</p>
          )}

          {undoResult ? (
            <p className="flex items-center gap-1.5 text-xs text-emerald-300">
              <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
              已尝试撤销，结果见下方。操作记录中仍保留完整审计信息。
            </p>
          ) : secondsLeft > 0 && operation.canRestore ? (
            <p className="flex items-center gap-1.5 text-xs text-ink-300">
              <Clock3 className="h-3.5 w-3.5" aria-hidden="true" />
              可在 {secondsLeft} 秒内撤销。窗口结束后仍可在操作记录详情中“尝试恢复”。
            </p>
          ) : (
            <p className="text-[11px] leading-relaxed text-ink-500">
              撤销窗口已结束。操作详情中仍保留“尝试恢复”，但若废纸篓已被清空则无法保证恢复。
            </p>
          )}

          {undoError ? (
            <ErrorState
              error={undoError}
              title="撤销未完成"
              onRetry={() => void handleUndo()}
              retryLabel="再次尝试恢复"
            />
          ) : null}

          {undoResult ? (
            <section className="rounded-lg border border-white/[0.07] bg-white/[0.02] px-3 py-2.5" aria-label="撤销结果">
              <div className="flex items-center justify-between gap-2">
                <h4 className="text-xs font-semibold text-ink-200">
                  {undoResult.alreadyRestored ? "此前已经恢复" : "撤销结果"}
                </h4>
                {undoResult.operation ? <OperationStatusChip status={undoResult.operation.status} /> : null}
              </div>
              {undoResult.operation ? (
                <p className="mt-1 text-[11px] text-ink-400">
                  成功恢复 {undoResult.operation.successFileCount} 个，失败 {undoResult.operation.failedFileCount} 个，冲突{" "}
                  {undoResult.operation.conflictFileCount} 个。
                </p>
              ) : null}
              {undoFailed.length > 0 ? (
                <ul className="mt-2 space-y-1.5">
                  {undoFailed.map((item) => (
                    <li key={item.id} className="rounded border border-red-500/20 bg-red-500/[0.05] px-2 py-1.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <ItemResultChip result={item.result} />
                        <span className="font-mono text-[11px] text-ink-300">{item.sourceRelativePath ?? item.displayName}</span>
                      </div>
                      <p className="mt-0.5 text-[10px] text-red-200">
                        {[item.errorCode, item.errorMessage].filter(Boolean).join(" · ") || "未提供错误信息"}
                      </p>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-1 flex items-center gap-1 text-[11px] text-emerald-300">
                  <RotateCcw className="h-3 w-3" aria-hidden="true" /> 文件已恢复到原路径。
                </p>
              )}
            </section>
          ) : null}
        </div>
      ) : null}
    </Modal>
  );
}
