/** 人类可读的格式化辅助函数（全部使用中文界面习惯）。 */

const BYTE_UNITS = ["KB", "MB", "GB", "TB"] as const;

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits).replace(/\.0+$/, "").replace(/(\.\d)0$/, "$1")} ${BYTE_UNITS[unit]}`;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** 拍摄时间是不带时区的本地时间（YYYY-MM-DDTHH:mm:ss）。 */
export function formatCaptureTime(value: string | null | undefined): string {
  if (!value) return "未知";
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(value);
  if (!match) return "未知";
  const [, year, month, day, hour, minute] = match;
  return hour && minute ? `${year}-${month}-${day} ${hour}:${minute}` : `${year}-${month}-${day}`;
}

/** 后端时间统一为 UTC ISO；这里按本地时区展示。 */
export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

export function formatDateTimeWithSeconds(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return `${formatDateTime(value)}:${pad(date.getSeconds())}`;
}

export function formatRelativeTime(value: string | null | undefined): string {
  if (!value) return "从未扫描";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "未知";
  const diffMs = Date.now() - date.getTime();
  if (diffMs < 0) return formatDateTime(value);
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 45) return "刚刚";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "昨天";
  if (days < 7) return `${days} 天前`;
  return formatDateTime(value).slice(0, 10);
}

export function formatPercent(value: number, total: number): number {
  if (!total || total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((value / total) * 100)));
}

export function formatDimensions(width?: number | null, height?: number | null): string {
  if (!width || !height) return "未知";
  return `${width} × ${height}`;
}

export function formatFocalLength(value?: number | null): string {
  if (!value) return "未知";
  return `${Number.isInteger(value) ? value : value.toFixed(1)} mm`;
}

export function formatAperture(value?: number | null): string {
  if (!value) return "未知";
  return `f/${Number.isInteger(value) ? value : value.toFixed(1)}`;
}

/** 操作记录筛选使用的日期输入 → ISO 时间范围。 */
export function dateInputToIso(value: string, boundary: "start" | "end"): string | undefined {
  if (!value) return undefined;
  const suffix = boundary === "start" ? "00:00:00.000" : "23:59:59.999";
  const date = new Date(`${value}T${suffix}`);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString();
}

export function formatFileHash(hash: string | null | undefined): string {
  if (!hash) return "未计算";
  return hash.length > 16 ? `${hash.slice(0, 12)}…` : hash;
}

export function formatZoomPercent(value: number): string {
  return `${Math.round(value)}%`;
}

export function formatDurationMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}
