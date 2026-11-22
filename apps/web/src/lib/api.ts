/**
 * 相册精选助手 typed API client.
 *
 * - 所有请求同源，路径固定以 /api 开头；
 * - 写请求自动带上内存中的 X-CSRF-Token（令牌只存在内存中）；
 * - 错误统一转换为 ApiRequestError，保留后端错误码、消息和 details。
 */

export type SortMode = "capture" | "filename";
export type AutoplayInterval = 2 | 3 | 5 | 10;
export type ViewedStatus = "unseen" | "viewed";
export type SelectionStatus = "unmarked" | "selected" | "pending_delete";
export type PairingStatus = "normal" | "conflict" | "missing" | "trashed";
export type FormKind = "jpg_raw" | "jpg_only" | "raw_only";
export type ScanStatus = "pending" | "scanning" | "ready" | "empty" | "failed";
export type ViewFilter = "all" | "unseen" | "viewed";
export type SelectionFilter = "all" | SelectionStatus;
export type FormFilter = "all" | FormKind;
export type IssueFilter = "all" | "pairing_conflict" | "missing" | "export_conflict";
export type PresenceStatus = "present" | "missing";
export type PreviewStatus = "pending" | "ok" | "failed" | "unavailable";
export type OperationType =
  | "scan"
  | "cleanup"
  | "restore"
  | "export"
  | "organize"
  | "organize_undo";
export type OperationStatus =
  | "preflight"
  | "executing"
  | "success"
  | "partial_failure"
  | "failed"
  | "restored"
  | "interrupted";
export type OperationItemResult = "pending" | "success" | "skipped" | "conflict" | "failed" | "restored";
export type JobStatus = "queued" | "running" | "success" | "failed";
export type IssueCategory =
  | "pairingConflicts"
  | "missingFiles"
  | "exportConflicts"
  | "previewFailures"
  | "scanErrors"
  | "cleanupIncomplete";

export interface Asset {
  id: string;
  kind: "jpg" | "raw";
  extension: string;
  relativePath: string;
  originalFilename: string;
  sizeBytes: number;
  mtimeNs: number;
  presenceStatus: PresenceStatus;
  previewStatus: PreviewStatus;
  previewError: string | null;
  contentSha256: string | null;
}

export interface PhotoExif {
  captureTime?: string | null;
  cameraMake?: string | null;
  cameraModel?: string | null;
  lensModel?: string | null;
  focalLength?: number | null;
  aperture?: number | null;
  exposureTime?: string | null;
  iso?: number | null;
  width?: number | null;
  height?: number | null;
  orientation?: number | null;
}

export interface PhotoFlags {
  pairingConflict: boolean;
  missingFile: boolean;
  exportConflict: boolean;
  trashed: boolean;
}

export interface Photo {
  id: string;
  albumId: string;
  albumName: string | null;
  displayName: string;
  normalizedPairKey: string;
  viewedStatus: ViewedStatus;
  selectionStatus: SelectionStatus;
  pairingStatus: PairingStatus;
  form: FormKind | null;
  captureTime: string | null;
  naturalKey: string;
  sortKey: string;
  version: number;
  conflictReasons: string[];
  flags: PhotoFlags;
  assets: Asset[];
  fileCount: number;
  totalBytes: number;
  primaryAssetId: string | null;
  thumbnailUrl: string;
  previewUrl: string;
  originalPreviewUrl: string;
  isViewed: boolean;
  isSelected: boolean;
  isPendingDelete: boolean;
  exif?: PhotoExif;
}

export interface AlbumCounts {
  total: number;
  viewed: number;
  unseen: number;
  selected: number;
  pendingDelete: number;
  missing: number;
  conflicts: number;
}

export interface Album {
  id: string;
  name: string;
  relativePath: string;
  coverPhotoId: string | null;
  coverThumbnailUrl: string | null;
  counts: AlbumCounts;
  lastOpenedAt: string | null;
  lastScannedAt: string | null;
  scanStatus: ScanStatus;
  scanError: string | null;
  createdAt: string;
  updatedAt: string;
  lastScanReport: Record<string, unknown> | null;
}

export interface AlbumsResponse {
  albums: Album[];
  photoRoot: string;
  exportDirName: string;
}

export interface AlbumResponse {
  album: Album;
  photoRoot: string;
  exportDirName: string;
}

export interface ScanOutcome {
  albumId: string;
  albumName: string;
  status: ScanStatus;
  counts: Partial<AlbumCounts>;
  report: Record<string, unknown> | null;
  error: string | null;
  durationMs: number;
}

export interface RescanAllResponse {
  outcomes: ScanOutcome[];
  albums: Album[];
  failed: number;
}

export interface RescanAlbumResponse {
  album: Album;
  report: Record<string, unknown> | null;
  counts: Partial<AlbumCounts>;
  error: string | null;
}

export interface PhotoPage {
  items: Photo[];
  nextCursor: string | null;
  total: number;
  sort: SortMode;
  limit: number;
}

export interface PhotoQuery {
  viewed?: ViewFilter;
  selection?: SelectionFilter;
  form?: FormFilter;
  issue?: IssueFilter;
  sort?: SortMode;
  cursor?: string | null;
  limit?: number;
}

export interface PhotoDetailResponse {
  photo: Photo;
}

export interface PhotoStatePatch {
  viewedStatus?: ViewedStatus;
  selectionStatus?: SelectionStatus;
  version: number;
}

export interface Settings {
  defaultSort: SortMode;
  autoplayInterval: AutoplayInterval;
  cleanupNoticeSeen: boolean;
}

export interface SettingsResponse {
  settings: Settings;
}

export interface Config {
  appVersion: string;
  photoRoot: string;
  exportDirName: string;
  exportRoot: string;
  dataDir: string;
  apiBase: string;
  supportedFormats: { jpg: string[]; raw: string[] };
  features: { trash: boolean; rawPreview: boolean; exiftool: boolean; watch: boolean; sse: boolean };
  defaults: {
    sort: SortMode;
    autoplayInterval: number;
    cleanupNoticeSeen: boolean;
  };
  thumbnailEdge: number;
  previewEdge: number;
}

export interface SessionResponse {
  token: string;
}

export interface CleanupSummary {
  photoCount: number;
  fileCount: number;
  totalBytes: number;
  jpgCount: number;
  rawCount: number;
}

export interface CleanupBlocker {
  code: string;
  message: string;
  groupId?: string | null;
  displayName?: string | null;
  relativePath?: string | null;
}

export interface CleanupGroupAsset {
  assetId: string;
  relativePath: string;
  kind: "jpg" | "raw";
  extension: string;
  originalFilename: string;
  sizeBytes: number;
  mtimeNs: number;
}

export interface CleanupGroup {
  groupId: string;
  displayName: string;
  selectionStatus: SelectionStatus;
  pairingStatus: PairingStatus;
  version: number;
  blocked?: boolean;
  assets: CleanupGroupAsset[];
}

export interface CleanupPreflight {
  albumId: string;
  token: string | null;
  expiresAt: string | null;
  operationId: string | null;
  summary: CleanupSummary;
  blocked: boolean;
  blockers: CleanupBlocker[];
  groups: CleanupGroup[];
  message: string;
}

export interface CleanupGroupSummary {
  requested: number;
  succeeded: number;
  failed: number;
}

export interface CleanupSeriousError {
  photoGroupId: string | null;
  displayName: string | null;
  sourceRelativePath: string | null;
  actualLocation: string | null;
  message: string;
}

export interface CleanupExecuteResponse {
  operation: OperationDetail;
  undoAvailableUntil: string | null;
  idempotentReplay: boolean;
  groupSummary?: CleanupGroupSummary;
  seriousErrors?: CleanupSeriousError[];
}

export interface OrganizeSummary {
  photoCount: number;
  fileCount: number;
  moveCount: number;
  skipCount: number;
  jpgCount: number;
  rawCount: number;
  totalBytes: number;
}

export interface OrganizeEntry {
  assetId: string;
  groupId: string;
  displayName: string;
  kind: "jpg" | "raw";
  extension: string;
  originalFilename: string;
  sourceRelativePath: string;
  destinationRelativePath: string;
  destinationAbsolutePath: string;
  sourceSizeBytes: number;
  sourceMtimeNs: number;
  action: "move" | "skip";
  groupIndex: number;
}

export interface OrganizeBlocker {
  code: string;
  message: string;
  groupId?: string | null;
  displayName?: string | null;
  relativePath?: string | null;
  destinationRelativePath?: string | null;
}

export interface OrganizePreflight {
  albumId: string;
  albumName: string;
  token: string | null;
  expiresAt: string | null;
  operationId: string | null;
  summary: OrganizeSummary;
  blocked: boolean;
  blockers: OrganizeBlocker[];
  entries: OrganizeEntry[];
  message: string;
}

export interface OrganizeExecuteResponse {
  operation: OperationDetail;
  summary: OrganizeSummary | null;
  blockers: OrganizeBlocker[];
  idempotentReplay: boolean;
}

export interface OperationItem {
  id: string;
  operationId?: string;
  photoGroupId: string | null;
  assetId: string | null;
  displayName: string | null;
  sourceRelativePath: string | null;
  destinationPath: string | null;
  sourceSizeBytes: number | null;
  sourceMtimeNs: number | null;
  contentSha256: string | null;
  result: OperationItemResult;
  errorCode: string | null;
  errorMessage: string | null;
  groupIndex: number | null;
}

export interface OperationProgress {
  processedFiles?: number;
  totalFiles?: number;
  successFiles?: number;
  skippedFiles?: number;
  failedFiles?: number;
  conflictFiles?: number;
}

export interface Operation {
  id: string;
  type: OperationType;
  status: OperationStatus;
  albumId: string | null;
  albumName: string | null;
  parentOperationId: string | null;
  requestedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  requestedPhotoCount: number;
  requestedFileCount: number;
  successFileCount: number;
  skippedFileCount: number;
  failedFileCount: number;
  conflictFileCount: number;
  errorSummary: string | null;
  progress: OperationProgress | null;
  restoredAt: string | null;
  restoreOperationId: string | null;
  canRestore: boolean;
  requestSnapshot: Record<string, unknown> | null;
  createdAt: string;
  items?: OperationItem[];
}

export interface OperationDetail extends Operation {
  items: OperationItem[];
}

export interface OperationsResponse {
  items: Operation[];
  total: number;
  limit: number;
  offset: number;
}

export interface OperationDetailResponse {
  operation: OperationDetail;
}

export interface RestoreResponse {
  operation: OperationDetail | null;
  originalOperation: OperationDetail;
  alreadyRestored: boolean;
}

export interface ExportWarning {
  code: string;
  groupId?: string | null;
  displayName?: string | null;
  relativePath?: string | null;
  message: string;
}

export interface ExportSummary {
  photoCount: number;
  fileCount: number;
  jpgCount: number;
  rawCount: number;
  totalBytes: number;
  toCopyCount: number;
  existingCount: number;
  conflictCount: number;
}

export interface ExportPreflight {
  albumId: string;
  token: string | null;
  expiresAt: string | null;
  operationId: string | null;
  summary: ExportSummary;
  warnings: ExportWarning[];
  destinationRelativePath: string;
  destinationAbsolutePath: string;
  message: string;
}

export interface ExportStartResponse {
  operationId: string;
  jobId: string | null;
  status: string;
  idempotentReplay: boolean;
  operation?: OperationDetail;
}

export interface Job {
  id: string;
  kind: string;
  operationId: string | null;
  status: JobStatus;
  progress: OperationProgress | null;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface JobResponse {
  job: Job;
}

export interface IssueAssetRef {
  assetId: string;
  relativePath: string;
  originalFilename: string;
  kind: "jpg" | "raw";
  sizeBytes: number;
  presenceStatus: PresenceStatus;
}

export interface PairingConflictIssue {
  groupId: string;
  displayName: string;
  pairingStatus: PairingStatus;
  conflictReasons: string[];
  files: IssueAssetRef[];
}

export interface MissingFileIssue {
  groupId: string;
  displayName: string;
  pairingStatus: PairingStatus;
  selectionStatus: SelectionStatus;
  missingPaths: string[];
  files: IssueAssetRef[];
}

export interface ExportConflictIssue {
  id: string;
  operationId: string | null;
  sourceRelativePath: string;
  destinationRelativePath: string;
  conflictType: string;
  sourceSizeBytes: number | null;
  destinationSizeBytes: number | null;
  lastSeenAt: string;
  sourceAssets: IssueAssetRef[];
}

export interface AppIssue {
  id: string;
  kind: string;
  severity: string;
  message: string;
  operationId: string | null;
  lastSeenAt: string | null;
  payload: Record<string, unknown>;
}

export interface IssueCounts {
  pairingConflicts: number;
  missingFiles: number;
  exportConflicts: number;
  previewFailures: number;
  scanErrors: number;
  cleanupIncomplete: number;
}

export interface IssuesResponse {
  albumId: string;
  albumName: string;
  counts: IssueCounts;
  total: number;
  pairingConflicts: PairingConflictIssue[];
  missingFiles: MissingFileIssue[];
  exportConflicts: ExportConflictIssue[];
  previewFailures: AppIssue[];
  scanErrors: AppIssue[];
  cleanupIncomplete: AppIssue[];
  report?: Record<string, unknown> | null;
}

export interface RevealResponse {
  revealed: boolean;
  relativePath: string;
}

export interface OperationQuery {
  albumId?: string;
  type?: OperationType | "all";
  status?: OperationStatus | "all";
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

type QueryValue = string | number | boolean | null | undefined;

function withQuery(path: string, params: Record<string, QueryValue>): string {
  const search = new URLSearchParams();
  for (const [key, raw] of Object.entries(params)) {
    if (raw === undefined || raw === null || raw === "" || raw === "all") continue;
    search.set(key, String(raw));
  }
  const suffix = search.toString();
  return suffix ? `${path}?${suffix}` : path;
}

let csrfToken: string | null = null;

/** 会话令牌只保存在页面内存中，不写 localStorage / sessionStorage。 */
export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

export class ApiRequestError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: Record<string, unknown>;

  constructor(code: string, message: string, status: number, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "ApiRequestError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function isApiError(error: unknown): error is ApiRequestError {
  return error instanceof ApiRequestError;
}

interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  signal?: AbortSignal;
}

interface ErrorEnvelope {
  error?: { code?: unknown; message?: unknown; details?: unknown };
}

const MUTATING = new Set(["POST", "PATCH", "DELETE"]);

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? "GET";
  const headers: Record<string, string> = { Accept: "application/json" };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (MUTATING.has(method) && csrfToken) headers["X-CSRF-Token"] = csrfToken;

  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers,
      credentials: "same-origin",
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new ApiRequestError(
      "NETWORK_ERROR",
      "无法连接到本地服务，请确认 npm run dev 仍在运行。",
      0,
      { reason: error instanceof Error ? error.message : String(error) },
    );
  }

  if (!response.ok) {
    let envelope: ErrorEnvelope = {};
    try {
      envelope = (await response.json()) as ErrorEnvelope;
    } catch {
      // 非 JSON 错误响应：保留 HTTP 状态。
    }
    const payload = envelope.error;
    const code = typeof payload?.code === "string" ? payload.code : `HTTP_${response.status}`;
    const message =
      typeof payload?.message === "string" && payload.message.trim()
        ? payload.message
        : `请求失败（HTTP ${response.status}）。`;
    const details =
      payload?.details && typeof payload.details === "object"
        ? (payload.details as Record<string, unknown>)
        : {};
    throw new ApiRequestError(code, message, response.status, details);
  }

  if (response.status === 204) return undefined as T;
  const text = await response.text();
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiRequestError("INVALID_RESPONSE", "本地服务返回了无法解析的响应。", response.status);
  }
}

export const api = {
  // 系统
  getSession: () => request<SessionResponse>("/api/session"),
  getConfig: () => request<Config>("/api/config"),
  getSettings: () => request<SettingsResponse>("/api/settings"),
  patchSettings: (patch: Partial<Settings>) =>
    request<SettingsResponse>("/api/settings", { method: "PATCH", body: patch }),

  // 相册
  listAlbums: (sort: "name" | "recent") => request<AlbumsResponse>(withQuery("/api/albums", { sort })),
  rescanAllAlbums: () => request<RescanAllResponse>("/api/albums/rescan", { method: "POST" }),
  getAlbum: (albumId: string) => request<AlbumResponse>(`/api/albums/${encodeURIComponent(albumId)}`),
  rescanAlbum: (albumId: string) =>
    request<RescanAlbumResponse>(`/api/albums/${encodeURIComponent(albumId)}/rescan`, { method: "POST" }),

  // 逻辑照片
  listPhotos: (albumId: string, query: PhotoQuery = {}) =>
    request<PhotoPage>(
      withQuery(`/api/albums/${encodeURIComponent(albumId)}/photos`, {
        viewed: query.viewed ?? "all",
        selection: query.selection ?? "all",
        form: query.form ?? "all",
        issue: query.issue ?? "all",
        sort: query.sort ?? "capture",
        cursor: query.cursor ?? undefined,
        limit: query.limit ?? 200,
      }),
    ),
  getPhoto: (photoId: string) => request<PhotoDetailResponse>(`/api/photos/${encodeURIComponent(photoId)}`),
  patchPhotoState: (photoId: string, payload: PhotoStatePatch) =>
    request<PhotoDetailResponse>(`/api/photos/${encodeURIComponent(photoId)}/state`, {
      method: "PATCH",
      body: payload,
    }),

  // 清理 / 撤销
  cleanupPreflight: (albumId: string) =>
    request<CleanupPreflight>(`/api/albums/${encodeURIComponent(albumId)}/cleanup/preflight`, {
      method: "POST",
    }),
  cleanupExecute: (albumId: string, payload: { preflightToken: string; idempotencyKey: string }) =>
    request<CleanupExecuteResponse>(`/api/albums/${encodeURIComponent(albumId)}/cleanup/execute`, {
      method: "POST",
      body: payload,
    }),
  restoreOperation: (operationId: string) =>
    request<RestoreResponse>(`/api/operations/${encodeURIComponent(operationId)}/restore`, { method: "POST" }),

  // 导出
  exportPreflight: (albumId: string) =>
    request<ExportPreflight>(`/api/albums/${encodeURIComponent(albumId)}/exports/preflight`, { method: "POST" }),
  startExport: (albumId: string, payload: { preflightToken: string; idempotencyKey: string }) =>
    request<ExportStartResponse>(`/api/albums/${encodeURIComponent(albumId)}/exports`, {
      method: "POST",
      body: payload,
    }),

  // 原地整理 JPG/RAW
  organizePreflight: (albumId: string) =>
    request<OrganizePreflight>(`/api/albums/${encodeURIComponent(albumId)}/organize/preflight`, {
      method: "POST",
    }),
  organizeExecute: (albumId: string, payload: { preflightToken: string; idempotencyKey: string }) =>
    request<OrganizeExecuteResponse>(`/api/albums/${encodeURIComponent(albumId)}/organize/execute`, {
      method: "POST",
      body: payload,
    }),
  getJob: (jobId: string) => request<JobResponse>(`/api/jobs/${encodeURIComponent(jobId)}`),

  // 操作记录
  listOperations: (query: OperationQuery = {}) =>
    request<OperationsResponse>(
      withQuery("/api/operations", {
        albumId: query.albumId,
        type: query.type,
        status: query.status,
        from: query.from,
        to: query.to,
        limit: query.limit ?? 50,
        offset: query.offset ?? 0,
      }),
    ),
  getOperation: (operationId: string) =>
    request<OperationDetailResponse>(`/api/operations/${encodeURIComponent(operationId)}`),

  // 异常中心
  getIssues: (albumId: string) =>
    request<IssuesResponse>(`/api/albums/${encodeURIComponent(albumId)}/issues`),
  rescanIssues: (albumId: string) =>
    request<IssuesResponse>(`/api/albums/${encodeURIComponent(albumId)}/issues/rescan`, { method: "POST" }),
  revealAsset: (assetId: string) =>
    request<RevealResponse>(`/api/assets/${encodeURIComponent(assetId)}/reveal-in-finder`, { method: "POST" }),
};

/** 在媒体 URL 上追加查询参数（URL 已包含 ?v= 指纹）。 */
export function appendMediaParam(url: string, key: string, value: string | number): string {
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`;
}
