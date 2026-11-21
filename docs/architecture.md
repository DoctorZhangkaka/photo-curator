# 架构与安全设计

本文说明一期实现的关键流程、状态不变量和故障处理方式。接口细节见 [api-contract.md](api-contract.md)，产品要求见 [product-spec.md](product-spec.md)。

## 1. 运行拓扑

```text
浏览器（React + Vite，127.0.0.1:7100 开发 / 8765 生产）
        │  同源 /api（开发经 Vite proxy，生产由 FastAPI 托管 dist）
        ▼
FastAPI（127.0.0.1:8765）
  ├── SQLite（WAL、外键、版本化迁移）
  ├── 预览缓存（Pillow / rawpy → 应用数据目录）
  ├── watchdog（当前打开相册，去抖后完整校对扫描）
  ├── JobManager（导出后台线程 + 进度）
  ├── EventBus（SSE 通知）
  └── macOS NSFileManager（原生废纸篓 / 恢复移动）
```

- 前后端都不绑定 `0.0.0.0`；`npm run dev` 同时启动两者，`Ctrl+C` 一起停止。
- SQLite 使用单文件 + WAL；每个 HTTP 请求/后台任务使用独立 Session。
- 后台线程（启动扫描、文件监听、导出、预览）与请求线程共享数据库，但扫描按相册串行化、导出按相册串行化。

## 2. 无永久删除的文件安全不变量

1. 标记待删除只改数据库，不移动文件。
2. 清理分两阶段：预检（写入操作快照 + 短期令牌）→ 用户确认执行；执行前整批重新校验，任一文件变化即 `409 SOURCE_CHANGED`，整批不移动。
3. 每张逻辑照片是一个操作组：JPG＋RAW 必须全部成功；组内一个失败后立即停止该组，回滚已移动文件，不留下静默半组。
4. 回滚失败时组标记为冲突、操作标记失败、写入严重异常，并在明细中保留实际废纸篓位置。
5. 恢复只使用原生 API 返回并持久化的废纸篓位置；原路径已有文件时拒绝覆盖。
6. 应用不存在调用 `os.remove`/`unlink` 删除源照片的路径。`unlink` 只用于本应用的预览/导出临时文件。
7. `PathGuard` 拒绝绝对路径、`..`、超过两级的资产路径、相册内/导出目标中的符号链接；导出根被替换为符号链接时同样拒绝。
8. API 不接受文件路径参数；只接受相册 ID、照片 ID、资产 ID、预检令牌和幂等键。

## 3. 数据模型与身份

SQLite 表：`settings`、`albums`、`photo_groups`、`assets`、`operations`、`operation_items`、`export_conflicts`、`preflight_tokens`、`issues`、`schema_migrations`。

| 实体 | 稳定键 | 说明 |
| --- | --- | --- |
| 相册 | `albums.relative_path` 唯一 | 根目录下一级文件夹名；UUID 主键 |
| 逻辑照片 | `(album_id, normalized_pair_key)` 唯一 | 规范化主文件名（NFC + casefold）；UUID 主键 |
| 资产 | `(photo_group_id, relative_path)` 唯一 | 相对相册根目录；保留原始大小写/Unicode |
| 操作 | UUID，`idempotency_key` 唯一 | 幂等键按相册+类型校验，防止跨相册串用 |
| 预检令牌 | SHA-256 哈希唯一 | 原始令牌不落库；有 TTL 与单次消费 |

- 时间为 UTC ISO8601 字符串（毫秒，`Z` 结尾）；`capture_time` 使用无时区拍摄本地时间。字符串可直接排序，便于游标分页。
- 软删除字段 `deleted_at`、UUID、创建/更新时间均为未来同步预留；一期不做同步。
- 文件暂时缺失不删除 DB 记录：`assets.presence_status=missing`，逻辑组合状态为 `missing`，状态保留。
- 应用自己清理后 `photo_groups.pairing_status=trashed`，下次扫描不会误报为外部缺失；文件若重新出现在原路径则恢复正常并合并原状态。

## 4. 扫描与配对

1. 发现：只枚举照片根目录一级子目录；排除隐藏目录、符号链接、`精选原相册`、应用数据目录；根目录直接文件只计入发现报告。
2. 收集：相册根目录 + `RAW`/`JPG` 一级子目录（名称大小写不敏感）；只接受 `.jpg/.jpeg/.raf/.arw/.dng`；符号链接跳过并记入报告；其他嵌套目录中的图片只统计“未纳入”，不导入。
3. 配对：按规范化主文件名分桶；正常组仅允许 1 JPG、1 RAW 或 1 JPG＋1 RAW。两个以上同格式、多个 RAW 格式、大小写/Unicode 造成的同格式歧义 → 冲突组。
4. 合并：按稳定键复用 UUID 与状态；新文件/变化文件重置预览与哈希；未出现的文件标记缺失；重算封面。
5. 元数据：优先 JPG 的 Pillow EXIF；RAW 用 ExifTool 批量读取。元数据指纹变化才重新读取，避免每次打开相册重复解析。拍摄时间缺失时按自然文件名排序，最后以 UUID 保证稳定。
6. 扫描日志：每次扫描写入 `operations(type=scan)`，记录触发原因、耗时、文件数、逻辑照片数、未纳入目录、符号链接与读取错误。

排序键：

- 拍摄时间模式：`sort_key = capture_time or "~" + "|" + natural_key`，再以 `id` 兜底。
- 文件名模式：`natural_key`，再以 `id` 兜底。
- 游标包含排序键 + ID；排序方式与游标不匹配时返回 400。

## 5. 状态与并发

- 浏览状态与筛选状态是两个独立列，互不影响。
- 每次状态变更递增 `version`；`PATCH` 必须带旧版本，使用 `UPDATE ... WHERE version = ?` 原子更新，失败返回 `409 STALE_VERSION`。
- 扫描、清理、恢复只改自己负责的字段；扫描不会覆盖用户状态。
- 计数在查询时聚合，排除 `trashed`；缺失与冲突是独立统计。

## 6. 清理协议

```text
POST cleanup/preflight
  ├─ 强制重新扫描相册（同相册锁）
  ├─ 读取 pending_delete 组
  ├─ 逐文件校验：扩展名、存在、普通文件、根目录内、无符号链接、size/mtime 与 DB 一致
  ├─ 生成 blockers（缺文件/配对冲突/源变化）
  ├─ 创建 operation(status=preflight) + 文件名快照
  └─ 签发一次性 preflight token（哈希入库，TTL 默认 300s）

POST cleanup/execute {token, idempotencyKey}
  ├─ 幂等键已存在 → 返回原操作（校验 album/type 一致）
  ├─ 令牌不存在/类型不符/过期/已用 → 400/410/409
  ├─ 原子占用：UPDATE operation SET executing, idempotency_key WHERE status=preflight
  ├─ 原子消费令牌
  ├─ 再次校验整批（选择状态、配对、路径、size、mtime、扩展名）
  │    └─ 任一变化 → operation=failed，整批不移动，409
  ├─ 逐组执行：JPG → RAW
  │    ├─ 全部成功：group=trashed
  │    └─ 失败：停止该组、回滚已移动文件、记录 restored/failed/ROLLBACK_FAILED
  ├─ 计数与最终状态：success / partial_failure / failed
  └─ 返回 operation + 15 秒撤销窗口
```

恢复（撤销）：

```text
POST operations/{cleanupId}/restore
  ├─ 已完全恢复 → 200 alreadyRestored
  ├─ 仅取 cleanup items(result=success) 的已登记废纸篓位置
  ├─ 原路径已存在 → conflict，不覆盖
  ├─ 原相册目录已不存在 → failed，提示使用 Finder 废纸篓
  ├─ 成功移动 → asset=present，组恢复 normal，cleanup item=restored
  └─ 全部成功 → cleanup.status=restored；否则保留原操作状态，可重试
```

崩溃恢复：启动时把所有 `operations.status=executing` 标记为 `interrupted`（“应用中断，执行结果需人工核对”），绝不当作成功；过期预检自然失效；导出临时文件在启动时清理。

## 7. 导出协议

```text
POST exports/preflight
  ├─ 强制重新扫描
  ├─ 只选 selection=selected 且 pairing=normal、资产 present 的组
  ├─ 冲突/缺失组列入 warnings，不导出
  ├─ 计算目标路径与已存在/大小冲突（内容比较在复制阶段完成）
  └─ 创建 operation(preflight) + 令牌

POST exports {token, idempotencyKey} → 202 {operationId, jobId}
  └─ 后台线程按相册锁执行：
      ├─ 确保 <根>/精选原相册/<相册>/JPG 与 RAW 都存在（即使为空）
      ├─ 每个文件：校验源 size/mtime 与快照一致
      ├─ 目标不存在：流式复制到同目录 .pc-tmp-* → fsync → 校验源未变 →
      │    os.link(temp, target) 不覆盖发布 → 删除临时文件
      ├─ 目标已存在：先比大小，再比 SHA-256；同内容 skipped，不同内容 conflict
      ├─ 磁盘满/源变化/发布失败：删除临时文件，item=failed
      └─ 结束时写操作计数；同内容跳过不算失败；冲突不覆盖
```

- 重复幂等键返回原操作/任务，不产生第二次复制。
- 取消精选不会删除历史导出副本。
- 导出冲突写入 `export_conflicts`，在异常中心展示；后续导出若内容恢复一致会清除对应冲突。

## 8. 预览与缓存

- 缓存目录：`<data>/cache/previews`，绝不写入源相册。
- 缓存键：`v1|相册相对路径|资产相对路径|size|mtime_ns|规格`，文件变化自动生成新缓存。
- JPG：Pillow 解码 + EXIF 旋转 + LANCZOS 缩放到 512/2560。
- RAW：rawpy/LibRaw `half_size=True` + 相机白平衡 → 512/2560 JPEG；RAW 解码并发默认 2，同一缓存键加锁去重。
- 预览失败写入 `issues(preview_failure)` 并返回 `422 RAW_PREVIEW_UNAVAILABLE`；成功后按资产前缀解决历史预览异常。
- 响应带 `ETag` 与一年私有 immutable 缓存；URL 中 `v` 为文件指纹。

## 9. 外部变化与实时事件

- 打开相册（`GET /api/albums/{id}`）时启动 watchdog，只监听当前相册；切换相册时停止旧监听。
- 事件过滤到相册根目录和 RAW/JPG 一级子目录；去抖 700ms（测试可配）；只触发一次完整校对扫描。
- 扫描完成后通过 SSE 推送 `album_changed`；清理/恢复/导出完成也推送事件。前端收到事件后使相关查询失效。
- 应用退出期间的变更由下次启动扫描处理；事件永远不是最终事实来源。

## 10. 安全与隐私

- `LocalSecurityMiddleware`：校验 Host 白名单（防 DNS rebinding）、拒绝非白名单 Origin、写 API 校验 `X-CSRF-Token`、统一安全响应头。
- 会话令牌自动生成并保存为 `0600`；不写日志/操作记录；前端只保存在内存。
- 无 CORS；媒体端点只读且必须通过数据库 ID + 路径校验。
- 外部工具（ExifTool、`open -R`）使用参数数组，不使用 shell 字符串。
- 不向第三方上传任何照片、预览或日志；运行期不需要外网。
- 导出目录固定位于照片根目录内；唯一的外写例外是 macOS 废纸篓（原生 API），恢复仍回到根目录内的原路径。

## 11. 测试接缝

- 纯函数：配对、自然排序、路径守卫、导出单文件复制（可注入 `sha256_file`/`copy_and_hash`）。
- 服务级：假废纸篓（临时目录内移动）用于回滚、幂等、撤销冲突故障注入。
- 真实集成：`MacOSTrashService` 受控测试，只操作唯一命名的临时夹具。
- 性能：1000 张逻辑照片扫描与分页测量。
- 端到端：Playwright 使用独立临时根目录与专用端口，不接触真实相册。

## 12. 未来同步预留（一期不实现）

UUID、创建/更新时间、软删除标记、相对于根目录的路径、可追加的操作日志已经就位；未来同步需要补齐的是变更序号/outbox、冲突解决策略和多设备身份，一期不引入会妨碍这些扩展的数据模型。
