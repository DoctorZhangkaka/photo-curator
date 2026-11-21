# 测试报告（一期）

- 报告时间：2026-11-22（Asia/Shanghai）
- 环境：macOS 26.4.1（arm64）、Python 3.12.13、Node.js 26.0.0（npm 11.12.1）、rawpy 0.28.0 / LibRaw、PyObjC 13.0
- 真实相册目录 `/Users/eason/Desktop/相册` **未用于任何自动化测试或验收**。所有测试根目录均位于 pytest 临时目录、`tests/.tmp` 或 `/tmp`。
- ExifTool：本机未安装。RAW 元数据回退行为按设计工作（RAW-only 显示“未知”，自然文件名排序），健康检查会提示。

## 1. 结果汇总

| 检查项 | 命令 | 结果 |
| --- | --- | --- |
| 后端单元 + 集成 + 原生废纸篓 + 性能 | `.venv/bin/python -m pytest -q` | **124 passed**，1 warning，5.83s |
| 后端原生 macOS 废纸篓专项 | `.venv/bin/python -m pytest tests/integration/test_trash_macos.py -v` | **2 passed**（真实 `NSFileManager`，夹具已恢复并清理） |
| 大相册性能 | `.venv/bin/python -m pytest tests/performance -q -s` | **1 passed**：扫描 1000 张逻辑照片 **0.71s**，首屏 200 张 **0.010s**，遍历全部 5 页 **0.04s** |
| 前端类型检查 | `npm run typecheck` | **通过**（TypeScript strict，`tsc -b`） |
| 前端单元/交互测试 | `npm test` | **14 passed**（Vitest 5.1.1，2 个测试文件） |
| 前端生产构建 | `npm run build` | **成功**：`dist/assets/index-*.js` 496.74 kB（gzip 148.53 kB），CSS 34.88 kB（gzip 7.42 kB） |
| 依赖安全审计 | `npm audit` | **0 vulnerabilities** |
| Playwright 端到端 | `npm run test:e2e` | **2 passed**，11.0s；使用生产构建 + 临时夹具 + 真实 macOS 废纸篓并撤销 |

测试数量构成：49 个单元测试（配对、自然排序、路径安全）、74 个集成/接口测试、1 个性能测试。

唯一警告来自 FastAPI/Starlette 的测试客户端对 `httpx` 的弃用提示，不影响运行；没有测试被跳过。

## 2. 后端测试覆盖

### 2.1 单元测试

| 文件 | 数量 | 覆盖 |
| --- | --- | --- |
| `tests/unit/test_pairing.py` | 18 | PAIR-001 ~ PAIR-016：大小写、跨 RAW/JPG 目录、JPEG/ARW/DNG、仅单格式、重复 JPG、重复 RAW、多 RAW 格式、Unicode NFC、纯大小写冲突、重命名产生新配对键、JPG 优先展示 |
| `tests/unit/test_paths.py` | 24 | `..`、绝对路径、嵌套深度、导出目录逃逸、文件/目录符号链接、导出目标符号链接、文件名注入 |
| `tests/unit/test_natural.py` | 7 | 数字自然排序（2 < 10）、大小写、Unicode、EXIF 时间格式、预检过期判断 |

### 2.2 集成/接口测试

| 文件 | 数量 | 覆盖 |
| --- | --- | --- |
| `test_albums_scan.py` | 12 | ALB-001 ~ ALB-010：旅行/人像相册、导出目录排除、隐藏目录、根目录文件、大小写 RAW/JPG 子目录、嵌套目录提示、空相册、权限失败隔离、符号链接拒绝并记录安全错误 |
| `test_state_api.py` | 8 | 两个状态维度独立、待删除默认可见、组合过滤、版本冲突 409、重启持久化、非法状态、排序键/游标、媒体缺失、冲突组资产预览 |
| `test_cleanup.py` | 16 | DEL-001 ~ DEL-016：仅标记不动文件、双格式预检、仅 JPG/仅 RAW、双格式组、冲突阻止整批、缺失阻止整批、预检后源变化 409、第二步失败回滚、回滚失败严重错误、幂等、撤销成功、撤销冲突不覆盖、清扫后重扫不误报缺失、Finder 恢复合并状态、无永久删除入口 |
| `test_export.py` | 11 | EXP-001 ~ EXP-016：双格式/单格式导出且两个目录都存在、只导出精选、重复跳过、增量、同名不同内容不覆盖、取消精选不删除历史副本、导出目录不被当相册、幂等、源变化失败、磁盘满无最终文件、预检过期 |
| `test_operations_db.py` | 8 | 迁移版本 1→2 幂等、WAL/外键、`executing` 中断恢复、操作明细不被重扫覆盖、操作过滤与时间校验、扫描记录、设置往返、健康检查、生产静态托管/CSP/SPA 回退 |
| `test_security.py` | 10 | 无/错会话令牌 401、跨源 403、Host 白名单、CORS 关闭、伪造/过期预检、数据库篡改为不支持扩展名被拒、日志无令牌、默认回环监听、媒体无令牌但路径受限 |
| `test_extra.py` | 6 | RAW 解码失败 422 + 异常记录、导出冲突解决后清除、全量重扫/相册排序、启动清理仅删除本应用临时文件、根目录缺失健康降级、废纸篓能力不可用时不删除 |
| `test_watcher.py` | 1 | EXT-001/002：Finder 新增照片触发去抖扫描、删除后标记缺失 |
| `test_trash_macos.py` | 2 | 真实 `NSFileManager` 移入废纸篓并获取实际位置、恢复、原路径冲突不覆盖、缺失文件拒绝 |

### 2.3 性能

`tests/performance/test_large_album.py` 生成 1000 张逻辑照片（其中 334 张带 RAW 占位）：

```text
[performance] scan=0.71s first_page=0.010s paginate_all=0.04s pages=5
```

断言：扫描 < 30s、首屏 < 3s、遍历全部分页 < 8s。实际远低于目标；真实高像素照片的首次缩略图/RAW 解码会更慢，不在此指标内。

## 3. 前端测试覆盖

`npm test`：14 个测试全部通过。

- `src/pages/CullerPage.test.tsx`（11 个）：按 F 精选、X/Delete 只改状态且不移动文件、输入框/select 聚焦时快捷键不触发、自动播放暂停、方向键/胶片栏边界、排序/过滤保留当前照片与回退首张、大图加载成功后才标记已浏览、409 `STALE_VERSION` 刷新重试、虚拟化胶片栏只挂载子集、弹窗焦点约束/Esc、清理预检阻止项、清理成功 + 严重错误 + 组统计 + 撤销、UUID 幂等键。
- `src/components/ui/Modal.test.tsx`（3 个）：焦点陷阱、Esc 关闭、关闭后焦点恢复。

类型检查与生产构建：

```text
tsc -b → 通过
vite v7.3.8 building client environment for production...
✓ 1674 modules transformed.
dist/index.html                   0.45 kB │ gzip:   0.31 kB
dist/assets/index-BwznooAt.css   34.88 kB │ gzip:   7.42 kB
dist/assets/index-kA9pWrpD.js   496.74 kB │ gzip: 148.53 kB
✓ built in 1.15s
```

## 4. 端到端验收（Playwright，生产构建）

命令：`npm run test:e2e`。`tests/e2e/start-server.mjs` 每次重新生成临时夹具（`tests/.tmp/e2e-photos`），构建前端，启动只监听 `127.0.0.1:8799` 的后端；结束后清理临时数据。**不使用真实相册。**

### 链路 1：旅行相册（1 个测试，约 6.2s）

1. 相册库显示 `测试-京都旅行`，封面、5 张逻辑照片、1 项异常。
2. 打开相册，自动后台重扫；大图加载后自动标记已浏览。
3. `F` 精选第一张、方向键切换、`F` 精选第二张。
4. 导出预检显示目标目录；确认后后台导出，100% 进度与逐文件结果；磁盘上出现 `精选原相册/测试-京都旅行/JPG/DSCF0001.JPG` 和 `RAW/DSCF0001.RAF`，源文件仍在。
5. 胶片栏跳到第三张，`X` 标记待删除；磁盘文件保持不变。
6. 清理预检显示 1 张逻辑照片 / 2 个文件与“不会永久删除”；确认后两个文件真实移入 macOS 废纸篓（实际路径来自原生 API）。
7. 15 秒撤销窗口内点击撤销，JPG 与 RAW 均恢复到原路径；清理弹窗显示恢复结果。
8. 操作记录页有扫描/导出/清理/恢复记录，可打开逐文件详情并 Esc 关闭。
9. 异常中心显示配对冲突 `DSCF0030` 及两个同名 JPG 文件，未自动删除或导出。

### 链路 2：键盘、排序与过滤（1 个测试，约 0.5s）

1. 切到文件名排序后，当前照片的 `data-photo-id` 保持不变。
2. 过滤“仅 RAW”后只剩 1 张，当前照片安全回退。
3. `select` 控件聚焦时按 `F` 不改变精选状态。
4. `X`/按钮只改待删除状态，磁盘文件不变；再次点击取消。
5. 自动播放控件存在。

### 截图（真实运行，合成夹具）

| 界面 | 截图 |
| --- | --- |
| 相册库 | [`docs/images/library.png`](images/library.png) |
| 照片筛选器 | [`docs/images/culler.png`](images/culler.png) |
| 清理结果 + 撤销 | [`docs/images/cleanup.png`](images/cleanup.png) |
| 导出结果 | [`docs/images/export.png`](images/export.png) |
| 操作记录 | [`docs/images/operations.png`](images/operations.png) |
| 异常中心 | [`docs/images/issues.png`](images/issues.png) |

浏览器验收还检查了 1440×900、768 宽与 480 宽布局、全屏进入/Esc 退出、适应/100%/缩放、导出重复执行显示“已存在跳过”、清理备份提示只首次出现、会话不可用时的阻断页与重试。截图均使用 `/tmp` 下生成的测试相册。

## 5. 与产品验收链路的对应关系

| 产品要求 | 验证方式 |
| --- | --- |
| 旅行相册完整闭环 | E2E 链路 1 + `test_cleanup`/`test_export`/`test_state_api` |
| 人像约拍相册（通用术语、ARW/RAF 混合、排序、组合过滤、增量导出、外部变化、缺失恢复、操作记录） | `test_albums_scan`（人像相册名）、`test_pairing`（ARW/RAF/DNG）、`test_state_api`（排序/组合过滤）、`test_export`（增量）、`test_watcher`（外部变化）、`test_albums_scan`（缺失与恢复）、`test_operations_db`（记录）；UI 文案检查由前端测试与截图覆盖 |
| 异常链路：JPG 对多 RAW、同名不同内容、第二步失败、恢复冲突、RAW 解码失败 | `test_pairing`、`test_export`、`test_cleanup`（注入失败）、`test_extra`（RAW 失败） |
| 无永久删除 | `test_cleanup`（断言所有执行结果位于废纸篓且无删除入口）、真实原生废纸篓测试 |
| 安全边界 | `test_paths`、`test_security`、静态 CSP/同源测试 |
| 重启状态保留 | `test_state_api::test_state_persists_across_restart` |
| 崩溃恢复 | `test_operations_db::test_recover_interrupted_operations` |
| 1000 张性能 | `tests/performance` |

## 6. 未执行 / 无法在本机验证的项

为避免伪造通过，以下项目明确未验证：

- **真实富士 RAF / 索尼 ARW 相机样本**：仓库和本机测试未提供。RAW 解码路径使用程序生成、LibRaw 可解码的合成 DNG 验证；伪造的 `.RAF/.ARW` 只用于配对与失败提示。真实机型的 RAW 解码取决于 rawpy/LibRaw 对该型号的支持。
- **ExifTool 元数据读取**：本机未安装 ExifTool，未验证真实 RAW 的拍摄时间/镜头信息；仅验证了缺失时回退与健康检查提示。
- **在 Finder 中点击“在 Finder 中显示”**：E2E 未触发系统 Finder 窗口；后端只做了路径校验与参数数组调用，需要人工在真实桌面确认窗口行为（不涉及照片修改）。
- **外接卷/网络卷导出**：导出发布依赖 `os.link`；不支持硬链接的卷会明确失败并记录，未在真实网络卷验证。
- **真实高像素照片性能与内存**：性能测试使用小尺寸合成 JPG；真实 6000 万像素 RAW 的首次解码时间与内存峰值未测。
- **磁盘实际写满**：通过注入 `OSError(ENOSPC)` 验证失败路径，未真实填满磁盘。
- **长时间自动播放/十万张相册**：未做压力测试；性能目标以 1000 张为准。
- **清空 macOS 废纸篓后的恢复**：按设计无法恢复，未做（也不应做）破坏性验证。
- **真实用户相册的只读/清理验证**：按约束明确不执行。

## 7. 测试环境清理

- pytest 临时目录由 pytest 自动删除；`tests/.tmp` 仅用于导入默认应用/ E2E 夹具，已 gitignore。
- 原生废纸篓测试与 E2E 均在成功后恢复/删除自己创建的夹具；检查 `~/.Trash` 中无 `DSCF`/`DSC0`/`pc-trash` 残留。
- 所有测试进程已停止；临时端口 `8799` 不再监听。
- 真实照片目录未被扫描、修改或删除。
