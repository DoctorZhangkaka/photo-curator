# 相册精选助手 API 契约（一期）

本文是前后端共同遵守的接口约定。所有接口只监听 `127.0.0.1`，默认 API 端口 `8765`，开发时由 Vite（默认 `7100`）同源代理 `/api`。

## 0. 通用约定

- 请求/响应 JSON 字段一律 **camelCase**；数据库内部使用 snake_case，不对外暴露。
- 时间均为 UTC ISO8601 字符串（`2026-11-22T01:23:45.678Z`）；`captureTime` 例外，是不带时区的拍摄本地时间（`2026-11-20T08:00:00`）。
- 列表分页使用游标，不返回十万级全量数据；`limit` 默认 200，最大 500。
- 错误响应统一为：

```json
{
  "error": {
    "code": "STALE_VERSION",
    "message": "照片状态已在其他窗口更新，请刷新后重试。",
    "details": { "currentVersion": 13 }
  }
}
```

- 写接口（POST/PATCH/DELETE）必须携带 `X-CSRF-Token`。令牌来自 `GET /api/session`，只保存在页面内存中，不写 localStorage、不打印到日志。
- 不启用 CORS；只允许同源/本机回环 Host。跨来源请求会被 403 拒绝。
- 前端必须避免 `innerHTML` 拼接；React 默认转义即可。

## 1. 系统

### `GET /api/session`

```json
{ "token": "..." }
```

### `GET /api/health`

```json
{
  "status": "ok | degraded | error",
  "version": "0.1.0",
  "platform": "darwin",
  "python": "3.12.13",
  "database": { "ok": true, "error": null, "path": "..." },
  "photoRoot": { "path": "...", "exists": true, "readable": true, "writable": true },
  "exportDirectory": { "path": "...", "creatable": true, "reason": null },
  "dependencies": {
    "exiftool": { "available": false, "path": null, "version": null },
    "rawpy": { "available": true, "backend": "rawpy/LibRaw", "version": "0.28.0" },
    "trash": { "available": true, "backend": "NSFileManager.trashItemAtURL", "reason": null },
    "watchdog": { "available": true }
  },
  "disk": { "totalBytes": 0, "freeBytes": 0 }
}
```

### `GET /api/config`

```json
{
  "appVersion": "0.1.0",
  "photoRoot": "/Users/eason/Desktop/相册",
  "exportDirName": "精选原相册",
  "exportRoot": ".../精选原相册",
  "dataDir": "...",
  "apiBase": "/api",
  "supportedFormats": { "jpg": [".jpg", ".jpeg"], "raw": [".raf", ".arw", ".dng"] },
  "features": { "trash": true, "rawPreview": true, "exiftool": false, "watch": true, "sse": true },
  "defaults": { "sort": "capture", "autoplayInterval": 3, "cleanupNoticeSeen": false },
  "thumbnailEdge": 512,
  "previewEdge": 2560
}
```

### `GET /api/settings` / `PATCH /api/settings`

```json
{ "settings": { "defaultSort": "capture", "autoplayInterval": 3, "cleanupNoticeSeen": false } }
```

PATCH 可只传其中一个字段：`defaultSort`（`capture`/`filename`）、`autoplayInterval`（2/3/5/10）、`cleanupNoticeSeen`（bool）。

## 2. 相册

### `GET /api/albums?sort=name|recent`

```json
{
  "albums": [
    {
      "id": "uuid",
      "name": "2026-京都旅行",
      "relativePath": "2026-京都旅行",
      "coverPhotoId": "uuid | null",
      "coverThumbnailUrl": "/api/photos/{id}/thumbnail | null",
      "counts": {
        "total": 480, "viewed": 126, "unseen": 354,
        "selected": 12, "pendingDelete": 3, "missing": 1, "conflicts": 1
      },
      "lastOpenedAt": "ISO | null",
      "lastScannedAt": "ISO | null",
      "scanStatus": "pending | scanning | ready | empty | failed",
      "scanError": null,
      "createdAt": "...",
      "updatedAt": "...",
      "lastScanReport": {}
    }
  ],
  "photoRoot": "...",
  "exportDirName": "精选原相册"
}
```

### `POST /api/albums/rescan`

同步重新扫描全部相册。

```json
{ "outcomes": [{ "albumId": "...", "albumName": "...", "status": "ready", "counts": {}, "report": {}, "error": null, "durationMs": 1234 }], "albums": [], "failed": 0 }
```

### `GET /api/albums/{albumId}`

记录最近打开时间并启动文件监听。

```json
{ "album": {/* AlbumSummary */}, "photoRoot": "...", "exportDirName": "精选原相册" }
```

### `POST /api/albums/{albumId}/rescan`

同步扫描单个相册（打开相册时调用，页面先展示已有数据，不阻塞浏览）。

```json
{ "album": {/* AlbumSummary */}, "report": {}, "counts": {}, "error": null }
```

### `GET /api/albums/{albumId}/events`（SSE）

`text/event-stream`，每 15 秒发送 `: keep-alive`。事件 `data:` 为 JSON：

```json
{ "type": "album_changed | cleanup_finished | restore_finished | export_finished", "albumId": "...", "at": "...", "status": "ready" }
```

前端收到事件后使相册、照片列表、操作记录相关查询失效即可，不依赖事件内容做局部更新。

## 3. 逻辑照片

### `GET /api/albums/{albumId}/photos`

查询参数（均可选）：

| 参数 | 值 | 默认 |
| --- | --- | --- |
| `viewed` | `all` / `unseen` / `viewed` | `all` |
| `selection` | `all` / `unmarked` / `selected` / `pending_delete` | `all` |
| `form` | `all` / `jpg_raw` / `jpg_only` / `raw_only` | `all` |
| `issue` | `all` / `pairing_conflict` / `missing` / `export_conflict` | `all` |
| `sort` | `capture` / `filename` | `capture` |
| `cursor` | 上一次响应的 `nextCursor` | 无 |
| `limit` | 1–500 | 200 |

默认显示全部照片（包含待删除）；已清理（trashed）照片不出现在列表。文件缺失单独标记，不会被当成待删除。

```json
{
  "items": [
    {
      "id": "uuid",
      "albumId": "uuid",
      "albumName": "2026-京都旅行",
      "displayName": "DSCF0001",
      "normalizedPairKey": "dscf0001",
      "viewedStatus": "unseen",
      "selectionStatus": "unmarked",
      "pairingStatus": "normal | conflict | missing | trashed",
      "form": "jpg_raw | jpg_only | raw_only | null",
      "captureTime": "2026-11-20T08:00:00 | null",
      "naturalKey": "...",
      "sortKey": "...",
      "version": 1,
      "conflictReasons": ["duplicate_jpg"],
      "flags": { "pairingConflict": false, "missingFile": false, "exportConflict": false, "trashed": false },
      "assets": [
        {
          "id": "uuid",
          "kind": "jpg",
          "extension": ".JPG",
          "relativePath": "JPG/DSCF0001.JPG",
          "originalFilename": "DSCF0001.JPG",
          "sizeBytes": 123456,
          "mtimeNs": 1760000000000000000,
          "presenceStatus": "present | missing",
          "previewStatus": "pending | ok | failed | unavailable",
          "previewError": null,
          "contentSha256": null
        }
      ],
      "fileCount": 2,
      "totalBytes": 123456,
      "primaryAssetId": "uuid",
      "thumbnailUrl": "/api/photos/{id}/thumbnail?v=123456-1760000000000000000",
      "previewUrl": "/api/photos/{id}/preview?v=...",
      "originalPreviewUrl": "/api/photos/{id}/original-preview?v=...",
      "isViewed": false,
      "isSelected": false,
      "isPendingDelete": false
    }
  ],
  "nextCursor": "base64 | null",
  "total": 480,
  "sort": "capture",
  "limit": 200
}
```

### `GET /api/photos/{photoId}`

```json
{ "photo": { /* 同上，并包含 exif */ "exif": {
  "captureTime": "2026-11-20T08:00:00",
  "cameraMake": "FUJIFILM",
  "cameraModel": "X-T5",
  "lensModel": "XF23mmF1.4 R LM WR",
  "focalLength": 23,
  "aperture": 1.4,
  "exposureTime": "1/250",
  "iso": 400,
  "width": 6240,
  "height": 4160,
  "orientation": 1
} } }
```

### `PATCH /api/photos/{photoId}/state`

请求（可只更新一个维度）：

```json
{ "viewedStatus": "viewed", "selectionStatus": "selected", "version": 12 }
```

成功返回 `{ "photo": {...} }`。`version` 不匹配时返回 `409 STALE_VERSION`，前端刷新后重试，不得静默覆盖。

### 媒体

- `GET /api/photos/{photoId}/thumbnail`：长边 512，JPEG 缓存。
- `GET /api/photos/{photoId}/preview`：长边 2560，JPEG 缓存；RAW-only 由 rawpy 解码。
- `GET /api/photos/{photoId}/original-preview`：JPG 返回原图；RAW 返回高质量解码预览（长边 2560）。
- 可选 `?assetId=` 指定冲突组中的某个文件。
- 响应带 `ETag`、`Cache-Control: private, max-age=31536000, immutable`。URL 中的 `v` 已包含文件指纹，文件变化后 URL 自动变化。
- 缺失文件 `404 ASSET_MISSING`；RAW 解码失败 `422 RAW_PREVIEW_UNAVAILABLE`；冲突组仍可只读预览，但不会解除冲突。

## 4. 清理待删除

### `POST /api/albums/{albumId}/cleanup/preflight`

后端强制重新扫描并生成预检快照：

```json
{
  "albumId": "uuid",
  "token": "短期令牌 | null",
  "expiresAt": "ISO | null",
  "operationId": "uuid | null",
  "summary": { "photoCount": 3, "fileCount": 5, "totalBytes": 12345678, "jpgCount": 3, "rawCount": 2 },
  "blocked": false,
  "blockers": [
    { "code": "PAIRING_CONFLICT | ASSET_MISSING | SOURCE_CHANGED", "message": "...", "groupId": "...", "displayName": "...", "relativePath": "..." }
  ],
  "groups": [
    {
      "groupId": "uuid", "displayName": "DSCF0001", "selectionStatus": "pending_delete",
      "pairingStatus": "normal", "version": 4, "blocked": false,
      "assets": [{ "assetId": "...", "relativePath": "...", "kind": "jpg", "extension": ".JPG", "originalFilename": "...", "sizeBytes": 1, "mtimeNs": 1 }]
    }
  ],
  "message": "将把 3 张逻辑照片的 5 个文件移入 macOS 废纸篓，不会永久删除。"
}
```

存在 `blockers` 时默认整批不执行；一期不提供“忽略异常删除其余”的选项。

### `POST /api/albums/{albumId}/cleanup/execute`

```json
{ "preflightToken": "...", "idempotencyKey": "uuid" }
```

成功或部分成功：

```json
{
  "operation": {
    "id": "uuid", "type": "cleanup", "status": "success | partial_failure | failed",
    "requestedPhotoCount": 3, "requestedFileCount": 5,
    "successFileCount": 5, "failedFileCount": 0, "skippedFileCount": 0, "conflictFileCount": 0,
    "errorSummary": null, "canRestore": true, "progress": null,
    "items": [
      {
        "id": "uuid", "photoGroupId": "uuid", "assetId": "uuid", "displayName": "DSCF0001",
        "sourceRelativePath": "DSCF0001.JPG",
        "destinationPath": "/Users/eason/.Trash/DSCF0001.JPG",
        "sourceSizeBytes": 1, "sourceMtimeNs": 1, "contentSha256": null,
        "result": "success | skipped | conflict | failed | restored | pending",
        "errorCode": null, "errorMessage": null, "groupIndex": 0
      }
    ]
  },
  "groupSummary": { "requested": 3, "succeeded": 3, "failed": 0 },
  "seriousErrors": [],
  "undoAvailableUntil": "ISO（界面保留 15 秒撤销入口）",
  "idempotentReplay": false
}
```

- `seriousErrors` 非空表示存在回滚失败的文件，必须显著展示，不能按成功处理；每项包含 `photoGroupId`、`displayName`、`sourceRelativePath`、`actualLocation`、`message`。
- 预检后任何源文件变化：`409 SOURCE_CHANGED`，整批不移动。
- 重复 `idempotencyKey`：返回原操作状态，不重复移动。
- 任一真实风险都不得报告 `success`。

### `POST /api/operations/{operationId}/restore`

撤销清理：

```json
{
  "operation": { /* restore 操作，items.result 为 restored/failed/conflict */ },
  "originalOperation": { /* 原 cleanup 操作，canRestore 反映是否仍可恢复 */ },
  "alreadyRestored": false
}
```

- 原路径已有新文件：`conflict`，不覆盖。
- 废纸篓文件已被清空：`failed`，提示在 Finder 废纸篓手动恢复。
- 不允许永久删除。

## 5. 精选导出

### `POST /api/albums/{albumId}/exports/preflight`

```json
{
  "albumId": "uuid",
  "token": "短期令牌 | null",
  "expiresAt": "ISO | null",
  "operationId": "uuid | null",
  "summary": {
    "photoCount": 12, "fileCount": 20, "jpgCount": 12, "rawCount": 8,
    "totalBytes": 12345678, "toCopyCount": 18, "existingCount": 2, "conflictCount": 0
  },
  "warnings": [
    { "code": "PAIRING_CONFLICT | ASSET_MISSING | UNSUPPORTED_FILE_TYPE", "groupId": "...", "displayName": "...", "relativePath": "...", "message": "..." }
  ],
  "destinationRelativePath": "精选原相册/2026-京都旅行",
  "destinationAbsolutePath": "...",
  "message": "将复制 20 个文件（JPG 12，RAW 8）到精选目录，源文件不会改变。已存在 2 个，潜在冲突 0 个。"
}
```

### `POST /api/albums/{albumId}/exports`（`202 Accepted`）

```json
{ "operationId": "uuid", "jobId": "uuid", "status": "running", "idempotentReplay": false }
```

目标结构固定为：

```text
<照片根目录>/精选原相册/<原相册文件夹名称>/JPG/
<照片根目录>/精选原相册/<原相册文件夹名称>/RAW/
```

每次导出都确保两个目录存在。同名同内容跳过；同名不同内容记录冲突且不覆盖；取消精选不删除已导出文件。

### `GET /api/jobs/{jobId}`

```json
{
  "job": {
    "id": "uuid", "kind": "export", "operationId": "uuid",
    "status": "queued | running | success | failed",
    "progress": { "processedFiles": 10, "totalFiles": 20, "successFiles": 9, "skippedFiles": 1, "failedFiles": 0, "conflictFiles": 0 },
    "error": null, "createdAt": "...", "finishedAt": "..."
  }
}
```

前端在导出弹窗中轮询该接口（约 500ms），并同时观察 SSE；关闭弹窗后重新打开可通过操作记录继续查看。断线/刷新后可用操作 ID 查询 `GET /api/operations/{id}`。

## 6. 操作记录

### `GET /api/operations?albumId=&type=&status=&from=&to=&limit=50&offset=0`

`type`、`status` 支持逗号分隔多值；`from`/`to` 为 ISO 时间，按 `requestedAt` 过滤。

```json
{
  "items": [
    {
      "id": "uuid", "type": "scan | cleanup | restore | export",
      "status": "preflight | executing | success | partial_failure | failed | restored | interrupted",
      "albumId": "uuid", "albumName": "2026-京都旅行",
      "parentOperationId": null,
      "requestedAt": "...", "startedAt": "...", "finishedAt": "...",
      "requestedPhotoCount": 3, "requestedFileCount": 5,
      "successFileCount": 5, "skippedFileCount": 0, "failedFileCount": 0, "conflictFileCount": 0,
      "errorSummary": null, "progress": null, "restoredAt": null, "restoreOperationId": null,
      "canRestore": false, "requestSnapshot": {}, "createdAt": "..."
    }
  ],
  "total": 42, "limit": 50, "offset": 0
}
```

### `GET /api/operations/{operationId}`

同上并包含 `items[]`（字段见清理执行示例），`canRestore` 表示是否还可撤销。

## 7. 异常中心

### `GET /api/albums/{albumId}/issues`

```json
{
  "albumId": "uuid", "albumName": "...",
  "counts": { "pairingConflicts": 1, "missingFiles": 1, "exportConflicts": 0, "previewFailures": 0, "scanErrors": 0, "cleanupIncomplete": 0 },
  "total": 2,
  "pairingConflicts": [
    { "groupId": "uuid", "displayName": "DSCF0030", "pairingStatus": "conflict", "conflictReasons": ["duplicate_jpg"], "files": [{ "assetId": "...", "relativePath": "...", "originalFilename": "...", "kind": "jpg", "sizeBytes": 1, "presenceStatus": "present" }] }
  ],
  "missingFiles": [
    { "groupId": "uuid", "displayName": "...", "pairingStatus": "missing", "selectionStatus": "pending_delete", "missingPaths": ["..."], "files": [] }
  ],
  "exportConflicts": [
    { "id": "uuid", "operationId": "uuid", "sourceRelativePath": "...", "destinationRelativePath": "精选原相册/.../JPG/...", "conflictType": "same_name_different_content", "sourceSizeBytes": 1, "destinationSizeBytes": 2, "lastSeenAt": "...", "sourceAssets": [] }
  ],
  "previewFailures": [{ "id": "uuid", "kind": "preview_failure", "severity": "warning", "message": "...", "operationId": null, "lastSeenAt": "...", "payload": {} }],
  "scanErrors": [],
  "cleanupIncomplete": []
}
```

### `POST /api/albums/{albumId}/issues/rescan`

重新扫描并返回同样结构，额外包含 `report`。

### `POST /api/assets/{assetId}/reveal-in-finder`

仅 macOS，参数数组调用 `open -R`，路径必须通过数据库与根目录校验。返回 `{"revealed": true, "relativePath": "..."}`。

## 8. 标准错误码

| code | HTTP | 含义 |
| --- | --- | --- |
| `ALBUM_NOT_FOUND` | 404 | 相册不存在 |
| `PHOTO_NOT_FOUND` | 404 | 逻辑照片不存在或已清理 |
| `ASSET_NOT_FOUND` / `ASSET_MISSING` | 404 | 资产不存在/已缺失 |
| `STALE_VERSION` | 409 | 乐观锁版本冲突 |
| `PREFLIGHT_INVALID` | 400 | 预检令牌无效/不匹配 |
| `PREFLIGHT_EXPIRED` | 410 | 预检过期 |
| `PREFLIGHT_CONSUMED` | 409 | 预检已执行 |
| `PREFLIGHT_BLOCKED` | 409 | 预检存在阻止项 |
| `SOURCE_CHANGED` | 409 | 预检后源文件变化 |
| `PAIRING_CONFLICT` | 409 | 配对冲突，禁止自动操作 |
| `DESTINATION_CONFLICT` | 409 | 目标同名不同内容，未覆盖 |
| `PATH_OUTSIDE_ROOT` | 403 | 路径穿越/符号链接逃逸 |
| `TRASH_OPERATION_FAILED` | 500 | 移入废纸篓失败 |
| `ROLLBACK_FAILED` | 500 | 回滚失败，需人工核对 |
| `RAW_PREVIEW_UNAVAILABLE` | 422 | RAW 预览不可用 |
| `DEPENDENCY_UNAVAILABLE` | 500/501 | 依赖不可用 |
| `UNAUTHORIZED` | 401 | 缺少/错误本地会话令牌 |
| `FORBIDDEN_ORIGIN` | 403 | 跨来源请求被拒绝 |
| `INVALID_REQUEST` | 400 | 参数非法 |

## 9. 前端必须满足的交互约束

这些来自产品文档，属于验收项：

1. 中文界面，统一使用“相册”/“拍摄相册”，不得出现“旅行专用”逻辑。
2. 浏览状态与筛选状态是两个独立维度；只有大图**加载成功后**才自动标记已浏览，胶片栏缩略图加载不标记。
3. 快捷键：`←` `→` 切换，`F` 精选，`X`/`Delete` 待删除，`Space` 自动播放，`I` 信息面板，`U` 切换浏览状态，`Esc` 关闭弹窗/退出全屏。输入框、文本域、`contenteditable` 聚焦时不触发。
4. 自动播放默认 3 秒，可选 2/3/5/10；到末尾停止；用户执行精选/待删除/清理/导出时自动暂停。
5. 排序切换后保留当前逻辑照片；过滤导致当前照片不在列表中时，选择新列表第一张并保持稳定。
6. 预加载当前照片前后各至少 2 张。
7. 胶片栏虚拟化（建议 `@tanstack/react-virtual`），不能一次挂载全部图片。
8. 大图支持适应屏幕/100%/放大缩小/拖动；全屏。
9. 右侧信息面板可折叠（`I`），显示两个状态、文件形态、EXIF、文件清单（相对路径、大小、缺失标记）；冲突组可只读预览文件。
10. 清理：预检弹窗展示照片数、文件数、释放空间、阻止项、明确的“移入废纸篓，不会永久删除”；有阻止项时禁用确认；成功后 15 秒撤销入口；操作详情可“尝试恢复”。
11. 导出：预检展示照片/JPG/RAW/字节数、目标目录、跳过与冲突；确认后显示进度；结束时展示成功/跳过/冲突/失败明细。
12. 操作记录：按相册、类型、状态、时间过滤，可展开查看逐文件明细。
13. 异常中心：分类展示配对冲突/缺失/导出冲突/RAW 预览失败/扫描错误；提供“在 Finder 中显示”和“重新扫描”，不提供自动删除冲突。
14. 视觉：深色/中性背景，照片为视觉中心；精选/待删除同时用颜色、图标、文字表达；按钮有可读标签；焦点清晰；弹窗支持 Esc 与焦点约束；200% 缩放仍可用；窄窗口信息面板可折叠、胶片栏不挤没大图。
15. 错误提示必须可读，并给出下一步（例如 409 后“刷新后重试”）。

## 10. 前端工程约定

- React 18/19 + TypeScript + Vite + Tailwind CSS + TanStack Query；图标可用轻量依赖。
- 源码位于 `apps/web/src`；构建产物 `apps/web/dist` 由后端同源托管。
- 开发服务器只监听 `127.0.0.1`；根目录 `npm run dev` 同时启动前后端，并把 CLI 的 `--host/--port` 转发给 Vite。
- API 客户端统一处理：会话令牌、`X-CSRF-Token`、错误结构、409 冲突提示。
- 不要写入密钥、真实照片路径、本机私人数据；测试夹具全部由脚本生成。
- 单元测试用 Vitest + React Testing Library；E2E 用 Playwright。
