import { isApiError } from "./api";

export interface FriendlyError {
  title: string;
  description: string;
  code?: string;
}

const BY_CODE: Record<string, Omit<FriendlyError, "code">> = {
  NETWORK_ERROR: {
    title: "无法连接到本地服务",
    description: "请确认 npm run dev 仍在运行，然后重试。",
  },
  STALE_VERSION: {
    title: "照片状态已被更新",
    description: "状态已在其他窗口更新，已刷新最新数据，请重试本次操作。",
  },
  PREFLIGHT_EXPIRED: {
    title: "预检已过期",
    description: "文件快照已失效，请重新预检后再执行。",
  },
  PREFLIGHT_INVALID: {
    title: "预检已失效",
    description: "请关闭当前窗口并重新预检。",
  },
  PREFLIGHT_CONSUMED: {
    title: "预检已被执行",
    description: "同一预检不能重复执行，请重新预检。",
  },
  PREFLIGHT_BLOCKED: {
    title: "存在阻止项，整批操作已停止",
    description: "请先在异常中心处理问题，然后重新预检。",
  },
  SOURCE_CHANGED: {
    title: "文件在预检后发生变化",
    description: "本次批量操作已停止，没有移动任何文件。请重新预检。",
  },
  PAIRING_CONFLICT: {
    title: "配对冲突",
    description: "该组文件无法安全配对。请在 Finder 中整理后重新扫描。",
  },
  ASSET_MISSING: {
    title: "文件缺失",
    description: "找不到对应文件，请重新扫描或在 Finder 中确认位置。",
  },
  DESTINATION_CONFLICT: {
    title: "目标文件同名但内容不同",
    description: "未覆盖任何文件。请在 Finder 中处理目标文件后重新导出。",
  },
  TRASH_OPERATION_FAILED: {
    title: "移入废纸篓失败",
    description: "没有执行永久删除。请在 Finder 中确认文件位置后重试。",
  },
  ROLLBACK_FAILED: {
    title: "回滚失败，需要人工核对",
    description: "部分文件可能同时存在于原位置和废纸篓，请先在操作记录中核对实际路径，不要重复操作。",
  },
  RAW_PREVIEW_UNAVAILABLE: {
    title: "RAW 预览不可用",
    description: "可以稍后重试，或检查 rawpy / ExifTool 依赖是否正常。",
  },
  DEPENDENCY_UNAVAILABLE: {
    title: "本地依赖不可用",
    description: "请检查服务健康状态，必要时运行 npm run setup。",
  },
  UNAUTHORIZED: {
    title: "本地会话已失效",
    description: "请刷新页面以重新建立本地会话后再操作。",
  },
  FORBIDDEN_ORIGIN: {
    title: "本地访问受限",
    description: "请通过 http://127.0.0.1:7100 打开页面，不要使用其他来源。",
  },
  FORBIDDEN_HOST: {
    title: "本地访问受限",
    description: "请使用本机回环地址打开页面。",
  },
  ALBUM_NOT_FOUND: {
    title: "相册不存在",
    description: "相册可能已被移除；请返回相册库刷新列表。",
  },
  PHOTO_NOT_FOUND: {
    title: "照片不存在或已清理",
    description: "请重新扫描相册后刷新列表。",
  },
  INVALID_REQUEST: {
    title: "请求参数无效",
    description: "请检查输入后重试。",
  },
  RESTORE_FAILED: {
    title: "恢复未完成",
    description: "请在操作记录中核对每个文件的实际结果，或到 Finder 废纸篓手动恢复。",
  },
  INTERNAL_ERROR: {
    title: "本地服务发生错误",
    description: "请稍后重试；若持续失败，请查看后端日志。",
  },
};

export function describeError(error: unknown): FriendlyError {
  if (isApiError(error)) {
    const known = BY_CODE[error.code];
    if (known) return { ...known, code: error.code };
    return {
      title: "操作未完成",
      description: error.message || "请稍后重试。",
      code: error.code,
    };
  }
  if (error instanceof Error) {
    return {
      title: "操作未完成",
      description: `${error.message || "发生未知错误。"} 请重试；若持续失败，请查看后端日志。`,
    };
  }
  return {
    title: "操作未完成",
    description: "发生未知错误，请重试。",
  };
}

export function errorSummary(error: unknown): string {
  const friendly = describeError(error);
  return friendly.code ? `${friendly.title}（${friendly.code}）` : friendly.title;
}
