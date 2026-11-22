import type { ComponentType, ReactNode } from "react";
import {
  AlertCircle,
  AlertTriangle,
  Aperture,
  CheckCircle2,
  Clock3,
  CircleDashed,
  Eye,
  EyeOff,
  FileX,
  Image as ImageIcon,
  Images,
  Loader2,
  RotateCcw,
  Star,
  Trash2,
  ChevronsRight,
} from "lucide-react";
import type {
  FormKind,
  OperationItemResult,
  OperationStatus,
  PairingStatus,
  Photo,
  ScanStatus,
  SelectionStatus,
  ViewedStatus,
} from "../lib/api";
import {
  FORM_LABELS,
  ITEM_RESULT_LABELS,
  OPERATION_STATUS_LABELS,
  PAIRING_LABELS,
  SCAN_LABELS,
  SELECTION_LABELS,
  VIEWED_LABELS,
} from "../lib/labels";
import { cx } from "../lib/cx";

export type ChipTone = "neutral" | "accent" | "success" | "danger" | "warning" | "info";

// 暗房校准低眩光色阶：确保徽标清晰可辨而不干扰照片色彩判断
const TONE_CLASSES: Record<ChipTone, string> = {
  neutral: "border-white/[0.09] bg-ink-900/75 text-ink-300",
  accent: "border-accent-400/35 bg-accent-500/[0.14] text-accent-300",
  success: "border-emerald-400/25 bg-emerald-500/[0.11] text-emerald-300",
  danger: "border-red-400/30 bg-red-500/[0.13] text-red-300",
  warning: "border-amber-400/30 bg-amber-500/[0.12] text-amber-300",
  info: "border-sky-400/25 bg-sky-500/[0.11] text-sky-300",
};

interface ChipProps {
  icon?: ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" | "false" }>;
  iconClassName?: string;
  tone?: ChipTone;
  children: ReactNode;
  className?: string;
  title?: string;
}

export function StatusChip({ icon: Icon, iconClassName, tone = "neutral", children, className, title }: ChipProps) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-[4px] border px-1.5 py-[2px] text-[10px] font-medium tracking-[0.01em] leading-4",
        TONE_CLASSES[tone],
        className,
      )}
      title={title}
    >
      {Icon ? <Icon className={cx("h-2.5 w-2.5 shrink-0", iconClassName)} aria-hidden="true" /> : null}
      {children}
    </span>
  );
}

export function ViewedChip({ status }: { status: ViewedStatus }) {
  return status === "viewed" ? (
    <StatusChip icon={Eye} tone="success">
      {VIEWED_LABELS.viewed}
    </StatusChip>
  ) : (
    <StatusChip icon={EyeOff} tone="neutral">
      {VIEWED_LABELS.unseen}
    </StatusChip>
  );
}

export function SelectionChip({ status }: { status: SelectionStatus }) {
  if (status === "selected") {
    return (
      <StatusChip icon={Star} iconClassName="fill-current" tone="accent">
        {SELECTION_LABELS.selected}
      </StatusChip>
    );
  }
  if (status === "pending_delete") {
    return (
      <StatusChip icon={Trash2} tone="danger">
        {SELECTION_LABELS.pending_delete}
      </StatusChip>
    );
  }
  return (
    <StatusChip icon={CircleDashed} tone="neutral">
      {SELECTION_LABELS.unmarked}
    </StatusChip>
  );
}

const FORM_ICONS: Record<FormKind, typeof ImageIcon> = {
  jpg_raw: Images,
  jpg_only: ImageIcon,
  raw_only: Aperture,
};

export function FormChip({ form }: { form: FormKind | null }) {
  if (!form) return <StatusChip tone="neutral">无文件</StatusChip>;
  const Icon = FORM_ICONS[form];
  return (
    <StatusChip icon={Icon} tone="info" className="font-mono">
      {FORM_LABELS[form]}
    </StatusChip>
  );
}

export function PairingChip({ status }: { status: PairingStatus }) {
  if (status === "conflict") {
    return (
      <StatusChip icon={AlertTriangle} tone="warning">
        {PAIRING_LABELS.conflict}
      </StatusChip>
    );
  }
  if (status === "missing") {
    return (
      <StatusChip icon={FileX} tone="danger">
        {PAIRING_LABELS.missing}
      </StatusChip>
    );
  }
  if (status === "trashed") {
    return (
      <StatusChip icon={Trash2} tone="neutral">
        {PAIRING_LABELS.trashed}
      </StatusChip>
    );
  }
  return null;
}

export function PhotoFlagChips({ photo }: { photo: Photo }) {
  return (
    <>
      {photo.flags.pairingConflict ? (
        <StatusChip icon={AlertTriangle} tone="warning">
          配对冲突
        </StatusChip>
      ) : null}
      {photo.flags.missingFile ? (
        <StatusChip icon={FileX} tone="danger">
          文件缺失
        </StatusChip>
      ) : null}
      {photo.flags.exportConflict ? (
        <StatusChip icon={AlertCircle} tone="warning">
          导出冲突
        </StatusChip>
      ) : null}
    </>
  );
}

const SCAN_ICONS: Record<ScanStatus, typeof CheckCircle2> = {
  pending: Clock3,
  scanning: Loader2,
  ready: CheckCircle2,
  empty: Images,
  failed: AlertCircle,
};

const SCAN_TONES: Record<ScanStatus, ChipTone> = {
  pending: "neutral",
  scanning: "info",
  ready: "success",
  empty: "neutral",
  failed: "danger",
};

export function ScanStatusChip({ status }: { status: ScanStatus }) {
  const Icon = SCAN_ICONS[status];
  return (
    <StatusChip
      icon={Icon}
      iconClassName={status === "scanning" ? "animate-spin motion-reduce:animate-none" : undefined}
      tone={SCAN_TONES[status]}
    >
      {SCAN_LABELS[status]}
      {status === "scanning" ? <span className="sr-only"> (正在读取文件) </span> : null}
    </StatusChip>
  );
}

const OPERATION_TONES: Record<OperationStatus, ChipTone> = {
  preflight: "info",
  executing: "info",
  success: "success",
  partial_failure: "warning",
  failed: "danger",
  restored: "accent",
  interrupted: "danger",
};

const OPERATION_ICONS: Record<OperationStatus, typeof CheckCircle2> = {
  preflight: Clock3,
  executing: Loader2,
  success: CheckCircle2,
  partial_failure: AlertTriangle,
  failed: AlertCircle,
  restored: RotateCcw,
  interrupted: AlertCircle,
};

export function OperationStatusChip({ status }: { status: OperationStatus }) {
  return (
    <StatusChip
      icon={OPERATION_ICONS[status]}
      iconClassName={status === "executing" ? "animate-spin motion-reduce:animate-none" : undefined}
      tone={OPERATION_TONES[status]}
    >
      {OPERATION_STATUS_LABELS[status]}
    </StatusChip>
  );
}

const ITEM_TONES: Record<OperationItemResult, ChipTone> = {
  pending: "neutral",
  success: "success",
  skipped: "info",
  conflict: "warning",
  failed: "danger",
  restored: "accent",
};

const ITEM_ICONS: Record<OperationItemResult, typeof CheckCircle2> = {
  pending: Clock3,
  success: CheckCircle2,
  skipped: ChevronsRight,
  conflict: AlertTriangle,
  failed: AlertCircle,
  restored: RotateCcw,
};

export function ItemResultChip({ result }: { result: OperationItemResult }) {
  return (
    <StatusChip icon={ITEM_ICONS[result]} tone={ITEM_TONES[result]}>
      {ITEM_RESULT_LABELS[result]}
    </StatusChip>
  );
}
