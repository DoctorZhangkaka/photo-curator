import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  AlertTriangle,
  ArrowRight,
  FolderInput,
  FolderOpen,
  Loader2,
  RotateCcw,
  ShieldAlert,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  api,
  type OrganizeExecuteResponse,
  type OrganizePreflight,
  type RestoreResponse,
} from "../../lib/api";
import { useApp } from "../../context/AppContext";
import { describeError } from "../../lib/messages";
import { createId } from "../../lib/id";
import { formatBytes, formatDateTime } from "../../lib/format";
import { useRestoreOperation } from "../../hooks/useMutations";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { ErrorState, Skeleton } from "../ui/StateViews";
import { ItemResultChip, OperationStatusChip } from "../StatusChips";

interface OrganizeDialogProps {
  open: boolean;
  albumId: string;
  albumName: string | null;
  onClose: () => void;
  onPauseAutoplay: () => void;
}

function failedOrganizeItems(result: OrganizeExecuteResponse | null) {
  return (result?.operation.items ?? []).filter(
    (item) => item.result === "failed" || item.result === "conflict",
  );
}

function failedRollbackItems(result: RestoreResponse | null) {
  return (result?.operation?.items ?? []).filter(
    (item) => item.result === "failed" || item.result === "conflict",
  );
}

export function OrganizeDialog({
  open,
  albumId,
  albumName,
  onClose,
  onPauseAutoplay,
}: OrganizeDialogProps) {
  const { toast } = useApp();
  const queryClient = useQueryClient();
  const restoreMutation = useRestoreOperation();

  const [preflight, setPreflight] = useState<OrganizePreflight | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [startError, setStartError] = useState<unknown>(null);
  const [result, setResult] = useState<OrganizeExecuteResponse | null>(null);
  const [starting, setStarting] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [restoreError, setRestoreError] = useState<unknown>(null);
  const [restoreResult, setRestoreResult] = useState<RestoreResponse | null>(null);
  const [restoreArmed, setRestoreArmed] = useState(false);
  const idempotencyKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setPreflight(null);
    setLoadError(null);
    setStartError(null);
    setResult(null);
    setConfirmation("");
    setRestoreError(null);
    setRestoreResult(null);
    setRestoreArmed(false);
    idempotencyKeyRef.current = null;
    setLoading(true);
    onPauseAutoplay();
    api
      .organizePreflight(albumId)
      .then((payload) => {
        if (!cancelled) setPreflight(payload);
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

  async function handleConfirm() {
    if (!preflight?.token || confirmation !== (albumName ?? "")) return;
    onPauseAutoplay();
    setStartError(null);
    setStarting(true);
    if (!idempotencyKeyRef.current) idempotencyKeyRef.current = createId();
    try {
      const response = await api.organizeExecute(albumId, {
        preflightToken: preflight.token,
        idempotencyKey: idempotencyKeyRef.current,
      });
      setResult(response);
      void queryClient.invalidateQueries({ queryKey: ["photos", albumId] });
      void queryClient.invalidateQueries({ queryKey: ["album", albumId] });
      void queryClient.invalidateQueries({ queryKey: ["albums"] });
      void queryClient.invalidateQueries({ queryKey: ["issues", albumId] });
      void queryClient.invalidateQueries({ queryKey: ["operations"] });
      if (response.operation.status === "success") {
        toast({
          variant: "success",
          title: "整理完成",
          description: `已移动 ${response.operation.successFileCount} 个文件；可随时撤销。`,
        });
      } else {
        toast({
          variant: "error",
          title: "整理未全部完成",
          description: response.operation.errorSummary ?? "请查看逐文件结果。",
          durationMs: 12000,
        });
      }
    } catch (error) {
      setStartError(error);
      const friendly = describeError(error);
      toast({ ...friendly, variant: "error" });
    } finally {
      setStarting(false);
    }
  }

  async function handleRestore() {
    if (!result?.operation.canRestore) return;
    onPauseAutoplay();
    setRestoreError(null);
    setRestoreArmed(false);
    try {
      const response = await restoreMutation.mutateAsync(result.operation.id);
      setRestoreResult(response);
      const operation = response.operation;
      if (!operation) {
        toast({ variant: "info", title: "该整理已经撤销", description: "没有文件被重复移动。" });
      } else if (operation.status === "success") {
        toast({ variant: "success", title: "撤销整理完成", description: "文件已移回整理前的位置。" });
      } else {
        toast({
          variant: "error",
          title: "撤销整理未全部完成",
          description: operation.errorSummary ?? "请查看逐文件结果，必要时在 Finder 中核对。",
          durationMs: 12000,
        });
      }
    } catch (error) {
      setRestoreError(error);
      const friendly = describeError(error);
      toast({ ...friendly, variant: "error" });
    }
  }

  const failedItems = failedOrganizeItems(result);
  const rollbackFailures = failedRollbackItems(restoreResult);
  const entries = preflight?.entries ?? [];
  const moveEntries = entries.filter((entry) => entry.action === "move");
  const skipEntries = entries.filter((entry) => entry.action === "skip");
  const canConfirm =
    Boolean(preflight?.token) &&
    !preflight?.blocked &&
    confirmation === (albumName ?? "") &&
    !starting;
  const rollbackComplete =
    Boolean(restoreResult) &&
    (restoreResult?.alreadyRestored || restoreResult?.operation?.status === "success");

  const footer = (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-[10px] leading-relaxed text-ink-500">
        {result
          ? "移动的是源文件；操作记录已写入本地数据库。"
          : "这是移动源文件，不是复制到精选目录。目标已存在时会拒绝执行。"}
      </p>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button variant="secondary" data-testid="organize-cancel" onClick={onClose} disabled={starting || restoreMutation.isPending}>
          关闭
        </Button>
        {!result ? (
          <Button
            variant="primary"
            icon={FolderInput}
            data-testid="organize-confirm"
            loading={starting}
            disabled={!canConfirm}
            title={
              !preflight?.token
                ? "没有可移动的文件或预检未通过"
                : confirmation !== (albumName ?? "")
                  ? "请输入相册名以确认"
                  : "开始移动源文件"
            }
            onClick={() => void handleConfirm()}
          >
            确认移动
          </Button>
        ) : result.operation.canRestore ? (
          restoreArmed ? (
            <>
              <Button
                variant="danger"
                data-testid="organize-undo-confirm"
                icon={RotateCcw}
                loading={restoreMutation.isPending}
                onClick={() => void handleRestore()}
              >
                确认撤销整理
              </Button>
              <Button
                variant="ghost"
                onClick={() => setRestoreArmed(false)}
                disabled={restoreMutation.isPending}
              >
                取消
              </Button>
            </>
          ) : (
            <Button
              variant="secondary"
              data-testid="organize-undo"
              icon={RotateCcw}
              onClick={() => setRestoreArmed(true)}
              disabled={rollbackComplete || restoreMutation.isPending}
            >
              撤销整理
            </Button>
          )
        ) : null}
      </div>
    </div>
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="整理 JPG / RAW"
      description={
        albumName
          ? `相册：${albumName} · 原地移动到 JPG/、RAW/ 子目录`
          : "原地移动到 JPG/、RAW/ 子目录"
      }
      size="xl"
      closeDisabled={starting || restoreMutation.isPending}
      testId="organize-modal"
      footer={footer}
    >
      {loading ? (
        <div className="space-y-4" aria-label="正在生成整理预检">
          <Skeleton className="h-20 w-full" />
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Skeleton className="h-16" />
            <Skeleton className="h-16" />
            <Skeleton className="h-16" />
            <Skeleton className="h-16" />
          </div>
          <Skeleton className="h-40 w-full" />
          <p className="text-xs text-ink-400">正在扫描相册并核对每个文件的目标位置…</p>
        </div>
      ) : loadError ? (
        <div>
          <ErrorState
            error={loadError}
            title="无法生成整理预检"
            onRetry={() => setReloadKey((key) => key + 1)}
          />
          <p className="mt-3 text-xs leading-relaxed text-ink-500">
            没有移动任何文件。请检查服务状态或相册权限后重试。
          </p>
        </div>
      ) : preflight ? (
        <div className="space-y-4">
          <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/[0.06] px-3 py-2.5" role="alert">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" aria-hidden="true" />
            <div>
              <p className="text-xs font-semibold text-amber-100">原地移动源文件，不会删除或覆盖</p>
              <p className="mt-0.5 text-[11px] leading-relaxed text-ink-300">
                JPG 移到相册内的 <code className="font-mono text-ink-200">JPG/</code>，RAW 移到{" "}
                <code className="font-mono text-ink-200">RAW/</code>。原文件仍在相册里，但路径会改变；不会写入精选目录。
              </p>
            </div>
          </div>

          <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[
              { label: "逻辑照片", value: `${preflight.summary.photoCount} 张` },
              { label: "将移动", value: `${preflight.summary.moveCount} 个` },
              { label: "已就位", value: `${preflight.summary.skipCount} 个` },
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
              <p className="text-[10px] text-ink-500">JPG 移动</p>
              <p className="font-mono text-sm tabular-nums text-ink-100">{preflight.summary.jpgCount}</p>
            </div>
            <div className="rounded-lg border border-white/[0.07] bg-ink-850 px-3 py-2">
              <p className="text-[10px] text-ink-500">RAW 移动</p>
              <p className="font-mono text-sm tabular-nums text-ink-100">{preflight.summary.rawCount}</p>
            </div>
            <div className="rounded-lg border border-white/[0.07] bg-ink-850 px-3 py-2">
              <p className="text-[10px] text-ink-500">目标结构</p>
              <p className="truncate font-mono text-[11px] text-ink-200">{albumName ?? "相册"}/JPG · /RAW</p>
            </div>
          </div>

          <div className="rounded-lg border border-white/[0.07] bg-white/[0.02] px-3 py-2 text-xs leading-relaxed text-ink-300">
            {preflight.message}
          </div>

          {preflight.blockers.length > 0 ? (
            <section aria-label="整理阻止项" className="rounded-lg border border-red-500/25 bg-red-500/[0.05] px-3 py-2.5">
              <h3 className="flex items-center gap-1.5 text-xs font-semibold text-red-200">
                <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" /> {preflight.blockers.length} 个阻止项
              </h3>
              <ul className="mt-2 max-h-40 space-y-1.5 overflow-y-auto pr-1">
                {preflight.blockers.map((blocker, index) => (
                  <li key={`${blocker.code}-${blocker.destinationRelativePath ?? blocker.relativePath ?? index}`} className="rounded border border-red-500/15 bg-black/20 px-2 py-1.5">
                    <p className="text-[11px] text-red-100">
                      {blocker.displayName ? `${blocker.displayName}：` : ""}
                      {blocker.message}
                    </p>
                    <p className="mt-0.5 break-all font-mono text-[10px] text-ink-500">
                      {[blocker.code, blocker.relativePath, blocker.destinationRelativePath].filter(Boolean).join(" · ")}
                    </p>
                  </li>
                ))}
              </ul>
              <p className="mt-1.5 text-[10px] text-ink-500">存在阻止项时不会移动任何文件。</p>
            </section>
          ) : null}

          {entries.length > 0 ? (
            <section aria-label="整理文件清单" className="overflow-hidden rounded-lg border border-white/[0.07]">
              <div className="flex items-center justify-between gap-2 border-b border-white/[0.06] bg-ink-850 px-3 py-2">
                <h3 className="flex items-center gap-1.5 text-xs font-semibold text-ink-200">
                  <FolderOpen className="h-3.5 w-3.5 text-accent-400" aria-hidden="true" /> 文件清单
                </h3>
                <span className="text-[10px] text-ink-500">
                  {moveEntries.length} 移动 · {skipEntries.length} 已就位
                </span>
              </div>
              <ul className="max-h-56 divide-y divide-white/[0.04] overflow-y-auto">
                {entries.slice(0, 200).map((entry) => (
                  <li key={entry.assetId} className="flex flex-wrap items-center gap-2 px-3 py-1.5 text-[11px]">
                    <span className={entry.action === "skip" ? "font-mono text-sky-300" : "font-mono text-emerald-300"}>
                      {entry.action === "skip" ? "已就位" : "移动"}
                    </span>
                    <span className="min-w-0 break-all font-mono text-[10px] text-ink-300">{entry.sourceRelativePath}</span>
                    <ArrowRight className="h-3 w-3 shrink-0 text-ink-600" aria-hidden="true" />
                    <span className="min-w-0 break-all font-mono text-[10px] text-ink-200">{entry.destinationRelativePath}</span>
                  </li>
                ))}
              </ul>
              {entries.length > 200 ? (
                <p className="border-t border-white/[0.06] px-3 py-1.5 text-[10px] text-ink-500">
                  仅列出前 200 个；其余 {entries.length - 200} 个同样会按预检计划处理。
                </p>
              ) : null}
            </section>
          ) : null}

          {preflight.token ? (
            <section className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-3">
              <label className="block text-xs font-medium text-ink-200" htmlFor="organize-confirm-input">
                输入相册名以确认移动
              </label>
              <p className="mt-0.5 text-[10px] text-ink-500">
                这是对源文件的原地操作；请确认相册名后执行。批量移动完成后可在本窗口或操作记录中撤销。
              </p>
              <input
                id="organize-confirm-input"
                data-testid="organize-confirm-input"
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
                placeholder={albumName ?? "相册名"}
                autoComplete="off"
                className="field mt-2 w-full px-2.5 py-2 text-xs"
              />
              <p className="mt-1.5 flex items-center gap-1.5 text-[10px] text-ink-500">
                <Loader2 className="h-3 w-3" aria-hidden="true" />
                预检在 {preflight.expiresAt ? formatDateTime(preflight.expiresAt) : "几分钟后"} 过期；执行前会再次校验源文件。
              </p>
            </section>
          ) : null}

          {startError ? (
            <ErrorState
              error={startError}
              title="整理未执行"
              onRetry={() => setReloadKey((key) => key + 1)}
              retryLabel="重新预检"
            />
          ) : null}

          {result ? (
            <section data-testid="organize-result" className="space-y-3 rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <OperationStatusChip status={result.operation.status} />
                <span className="text-xs font-medium text-ink-100">整理结果</span>
                <span className="font-mono text-[10px] text-ink-500">{result.operation.id.slice(0, 8)}…</span>
              </div>
              <p className="text-[11px] leading-relaxed text-ink-300">
                成功移动 <span className="font-mono text-emerald-300">{result.operation.successFileCount}</span> 个文件，
                已就位 <span className="font-mono text-sky-300">{result.operation.skippedFileCount}</span> 个，
                失败/冲突 <span className="font-mono text-red-300">{result.operation.failedFileCount + result.operation.conflictFileCount}</span> 个。
              </p>
              {result.operation.errorSummary ? (
                <p className="rounded border border-red-500/20 bg-red-500/[0.05] px-2.5 py-2 text-[11px] leading-relaxed text-red-200">
                  {result.operation.errorSummary}
                </p>
              ) : null}
              {failedItems.length > 0 ? (
                <ul className="max-h-40 space-y-1.5 overflow-y-auto">
                  {failedItems.map((item) => (
                    <li key={item.id} className="rounded border border-red-500/15 bg-black/20 px-2 py-1.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <ItemResultChip result={item.result} />
                        <span className="break-all font-mono text-[10px] text-ink-300">{item.sourceRelativePath}</span>
                      </div>
                      <p className="mt-0.5 text-[10px] text-red-200">
                        {[item.errorCode, item.errorMessage].filter(Boolean).join(" · ") || "未提供错误信息"}
                      </p>
                    </li>
                  ))}
                </ul>
              ) : null}
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Link
                  to={`/operations?operation=${encodeURIComponent(result.operation.id)}`}
                  className="inline-flex items-center gap-1 text-[11px] text-accent-300 hover:text-accent-200"
                  onClick={onClose}
                >
                  查看操作记录 <ArrowRight className="h-3 w-3" aria-hidden="true" />
                </Link>
                {result.operation.canRestore ? (
                  <span className="text-[10px] text-ink-500">可使用下方“撤销整理”恢复原路径。</span>
                ) : null}
              </div>
              {restoreArmed ? (
                <div className="rounded border border-amber-500/25 bg-amber-500/[0.06] px-2.5 py-2" role="alert">
                  <p className="flex items-center gap-1.5 text-xs font-semibold text-amber-100">
                    <ShieldAlert className="h-3.5 w-3.5" aria-hidden="true" /> 确认撤销本次整理？
                  </p>
                  <p className="mt-0.5 text-[11px] leading-relaxed text-ink-300">
                    会把本次实际移动的文件移回整理前的原路径。原本已在 JPG/RAW 的文件不会移动；若原路径已有新文件则不会覆盖。
                  </p>
                </div>
              ) : null}
              {restoreError ? (
                <ErrorState error={restoreError} title="撤销整理未完成" onRetry={() => void handleRestore()} retryLabel="再次尝试撤销" />
              ) : null}
              {restoreResult ? (
                <div data-testid="organize-undo-result" className="rounded border border-white/[0.08] bg-black/20 px-2.5 py-2">
                  <p className="text-xs font-medium text-ink-100">
                    {restoreResult.operation ? "撤销整理结果" : "此前已撤销整理"}
                  </p>
                  {restoreResult.operation ? (
                    <p className="mt-0.5 text-[11px] leading-relaxed text-ink-300">
                      成功 {restoreResult.operation.successFileCount}，失败/冲突{" "}
                      {restoreResult.operation.failedFileCount + restoreResult.operation.conflictFileCount}。
                      {restoreResult.operation.errorSummary ? ` ${restoreResult.operation.errorSummary}` : ""}
                    </p>
                  ) : null}
                  {rollbackFailures.length > 0 ? (
                    <ul className="mt-1.5 space-y-1">
                      {rollbackFailures.map((item) => (
                        <li key={item.id} className="break-all font-mono text-[10px] text-red-200">
                          {item.sourceRelativePath}: {item.errorMessage ?? item.errorCode ?? "失败"}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}
            </section>
          ) : null}
        </div>
      ) : null}
    </Modal>
  );
}
