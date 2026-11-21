import type {
  FormKind,
  IssueCategory,
  IssueCounts,
  OperationItemResult,
  OperationStatus,
  OperationType,
  PairingStatus,
  ScanStatus,
  SelectionStatus,
  ViewedStatus,
} from "./api";

export const VIEWED_LABELS: Record<ViewedStatus, string> = {
  unseen: "未浏览",
  viewed: "已浏览",
};

export const SELECTION_LABELS: Record<SelectionStatus, string> = {
  unmarked: "未筛选",
  selected: "精选",
  pending_delete: "待删除",
};

export const PAIRING_LABELS: Record<PairingStatus, string> = {
  normal: "配对正常",
  conflict: "配对冲突",
  missing: "文件缺失",
  trashed: "已清理",
};

export const FORM_LABELS: Record<FormKind, string> = {
  jpg_raw: "JPG＋RAW",
  jpg_only: "仅 JPG",
  raw_only: "仅 RAW",
};

export const SCAN_LABELS: Record<ScanStatus, string> = {
  pending: "待扫描",
  scanning: "扫描中",
  ready: "就绪",
  empty: "空相册",
  failed: "扫描失败",
};

export const OPERATION_TYPE_LABELS: Record<OperationType, string> = {
  scan: "扫描",
  cleanup: "清理",
  restore: "撤销恢复",
  export: "导出",
};

export const OPERATION_STATUS_LABELS: Record<OperationStatus, string> = {
  preflight: "预检",
  executing: "执行中",
  success: "成功",
  partial_failure: "部分失败",
  failed: "失败",
  restored: "已恢复",
  interrupted: "已中断",
};

export const ITEM_RESULT_LABELS: Record<OperationItemResult, string> = {
  pending: "待处理",
  success: "成功",
  skipped: "跳过",
  conflict: "冲突",
  failed: "失败",
  restored: "已恢复",
};

export const ISSUE_CATEGORY_LABELS: Record<IssueCategory, string> = {
  pairingConflicts: "配对冲突",
  missingFiles: "文件缺失",
  exportConflicts: "导出冲突",
  previewFailures: "预览失败",
  scanErrors: "扫描错误",
  cleanupIncomplete: "清理未完成",
};

export const ISSUE_CATEGORY_DESCRIPTIONS: Record<IssueCategory, string> = {
  pairingConflicts: "同名文件无法安全配对；处理前不会自动清理或导出。",
  missingFiles: "数据库仍有记录，但文件已不在原位置。",
  exportConflicts: "目标目录存在同名但内容不同的文件，未覆盖。",
  previewFailures: "RAW 解码或缩略图生成失败，原文件不会因此改变。",
  scanErrors: "读取目录或文件时发生错误，请检查权限。",
  cleanupIncomplete: "清理过程中存在需要人工核对的文件。",
};

export const CONFLICT_REASON_LABELS: Record<string, string> = {
  duplicate_jpg: "同名 JPG 重复",
  duplicate_raw: "同名 RAW 重复",
  multiple_raw_formats: "多种 RAW 格式并存",
  case_unicode_collision: "大小写或 Unicode 归一化冲突",
};

export function issueCategoryCount(counts: IssueCounts | undefined, category: IssueCategory): number {
  return counts ? counts[category] : 0;
}
