"""精选导出：预检 → 确认 → 后台增量复制。

安全规则：
- 只复制，绝不移动或修改源文件；
- 固定目标结构：<照片根目录>/<精选目录>/<相册>/JPG|RAW/；
- 先写临时文件，校验大小/哈希后再以不覆盖方式发布；
- 同名同内容：跳过；同名不同内容：冲突且不覆盖；
- 每次导出都确保 JPG、RAW 两个目录存在。
"""

from __future__ import annotations

import hashlib
import json
import os
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .config import Settings
from .constants import (
    ITEM_CONFLICT,
    ITEM_FAILED,
    ITEM_PENDING,
    ITEM_SKIPPED,
    ITEM_SUCCESS,
    OP_STATUS_EXECUTING,
    OP_STATUS_FAILED,
    OP_STATUS_PREFLIGHT,
    OP_TYPE_EXPORT,
    PAIRING_CONFLICT,
    PAIRING_NORMAL,
    PREFLIGHT_EXPORT,
    PRESENCE_PRESENT,
    SELECTION_SELECTED,
    SUPPORTED_EXTENSIONS,
)
from .db import Database
from .errors import ApiError, ErrorCode
from .issues import clear_export_conflict, upsert_export_conflict
from .models import Album, Operation, OperationItem, PhotoGroup
from .natural import utcnow_iso
from .operations import (
    create_operation,
    derive_status,
    find_by_idempotency_key,
    finish_operation,
    operation_items,
    set_progress,
)
from .paths import PathGuard
from .preflight import consume_preflight, issue_preflight, load_preflight
from .scanning import ScanService, scan_album_with_session
from .serializers import operation_to_dict

TEMP_PREFIX = ".pc-tmp-"
CHUNK_SIZE = 1024 * 1024


@dataclass
class CopyOutcome:
    result: str  # success / skipped / conflict / failed
    sha256: str | None = None
    destination_size: int | None = None
    error_code: str | None = None
    error_message: str | None = None


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while True:
            chunk = handle.read(CHUNK_SIZE)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def _copy_and_hash(source: Path, destination: Path) -> tuple[str, int]:
    """流式复制到临时文件，返回 (sha256, 字节数)。绝不把整个文件读入内存。"""

    digest = hashlib.sha256()
    written = 0
    with source.open("rb") as src, destination.open("xb") as dst:
        while True:
            chunk = src.read(CHUNK_SIZE)
            if not chunk:
                break
            digest.update(chunk)
            dst.write(chunk)
            written += len(chunk)
        dst.flush()
        os.fsync(dst.fileno())
    return digest.hexdigest(), written


def export_one(
    source: Path,
    target: Path,
    *,
    expected_size: int,
    expected_mtime_ns: int,
    sha256_file=_sha256_file,
    copy_and_hash=_copy_and_hash,
) -> CopyOutcome:
    """复制单个文件；目标存在时先比较内容，绝不覆盖。"""

    if target.exists() or target.is_symlink():
        if target.is_symlink() or not target.is_file():
            return CopyOutcome(
                ITEM_CONFLICT,
                error_code=ErrorCode.DESTINATION_CONFLICT,
                error_message="目标不是普通文件，未覆盖。",
            )
        try:
            destination_size = target.stat().st_size
        except OSError as exc:
            return CopyOutcome(ITEM_FAILED, error_code="DESTINATION_CONFLICT", error_message=f"无法读取目标文件：{exc}")
        if destination_size != expected_size:
            return CopyOutcome(
                ITEM_CONFLICT,
                destination_size=destination_size,
                error_code=ErrorCode.DESTINATION_CONFLICT,
                error_message="目标存在同名但大小不同的文件，未覆盖。",
            )
        try:
            source_hash = sha256_file(source)
            target_hash = sha256_file(target)
        except OSError as exc:
            return CopyOutcome(ITEM_FAILED, error_code="EXPORT_READ_FAILED", error_message=f"读取文件失败：{exc}")
        if source_hash == target_hash:
            return CopyOutcome(ITEM_SKIPPED, sha256=source_hash, destination_size=destination_size)
        return CopyOutcome(
            ITEM_CONFLICT,
            destination_size=destination_size,
            error_code=ErrorCode.DESTINATION_CONFLICT,
            error_message="目标存在同名但内容不同的文件，未覆盖。",
        )

    temporary = target.parent / f"{TEMP_PREFIX}{uuid.uuid4().hex}"
    try:
        try:
            source_hash, written = copy_and_hash(source, temporary)
        except OSError as exc:
            return CopyOutcome(ITEM_FAILED, error_code="EXPORT_WRITE_FAILED", error_message=f"复制失败：{exc}")
        try:
            stat = source.stat()
            temp_stat = temporary.stat()
        except OSError as exc:
            return CopyOutcome(ITEM_FAILED, error_code=ErrorCode.SOURCE_CHANGED, error_message=f"无法校验文件：{exc}")
        if stat.st_size != expected_size or stat.st_mtime_ns != expected_mtime_ns:
            return CopyOutcome(
                ITEM_FAILED,
                sha256=source_hash,
                error_code=ErrorCode.SOURCE_CHANGED,
                error_message="源文件在导出过程中发生变化，该项未完成。",
            )
        if written != expected_size or temp_stat.st_size != expected_size:
            return CopyOutcome(
                ITEM_FAILED,
                sha256=source_hash,
                error_code="EXPORT_INCOMPLETE",
                error_message="复制结果字节数不一致，已删除临时文件。",
            )
        try:
            os.link(temporary, target)
        except FileExistsError:
            # 并发下目标在发布前出现：重新比较内容，绝不覆盖。
            try:
                target_hash = sha256_file(target)
            except OSError as exc:
                return CopyOutcome(ITEM_FAILED, error_code=ErrorCode.DESTINATION_CONFLICT, error_message=str(exc))
            if target_hash == source_hash:
                return CopyOutcome(ITEM_SKIPPED, sha256=source_hash, destination_size=target.stat().st_size)
            return CopyOutcome(
                ITEM_CONFLICT,
                sha256=source_hash,
                destination_size=target.stat().st_size,
                error_code=ErrorCode.DESTINATION_CONFLICT,
                error_message="目标出现同名不同内容文件，未覆盖。",
            )
        except OSError as exc:
            return CopyOutcome(
                ITEM_FAILED,
                error_code="EXPORT_PUBLISH_FAILED",
                error_message=f"发布目标文件失败：{exc}",
            )
        return CopyOutcome(ITEM_SUCCESS, sha256=source_hash, destination_size=written)
    finally:
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass


def cleanup_stale_temp_files(settings: Settings, guard: PathGuard) -> int:
    """启动时清理属于本应用的过期导出临时文件，不触碰其他文件。"""

    removed = 0
    export_root = guard.export_root
    if not export_root.exists() or export_root.is_symlink():
        return 0
    for current, dirnames, filenames in os.walk(export_root, followlinks=False):
        dirnames[:] = [d for d in dirnames if not d.startswith(".") and not os.path.islink(os.path.join(current, d))]
        for filename in filenames:
            if not filename.startswith(TEMP_PREFIX):
                continue
            path = Path(current) / filename
            if path.is_symlink():
                continue
            try:
                path.unlink()
                removed += 1
            except OSError:
                continue
    return removed


class ExportService:
    def __init__(
        self,
        settings: Settings,
        database: Database,
        guard: PathGuard,
        scan_service: ScanService,
        jobs,  # noqa: ANN001
        events=None,  # noqa: ANN001
    ) -> None:
        self.settings = settings
        self.database = database
        self.guard = guard
        self.scan_service = scan_service
        self.jobs = jobs
        self.events = events

    # ------------------------------------------------------------------
    # 预检
    # ------------------------------------------------------------------
    def preflight(self, album_id: str) -> dict[str, Any]:
        session = self.database.session()
        try:
            album = session.get(Album, album_id)
            if album is None or album.deleted_at is not None:
                raise ApiError(ErrorCode.ALBUM_NOT_FOUND, "相册不存在。", status_code=404)
            lock = self.scan_service.album_lock(album_id)
            with lock:
                outcome = scan_album_with_session(
                    session,
                    album,
                    settings=self.settings,
                    guard=self.guard,
                    trigger="export_preflight",
                    record_operation=True,
                    exiftool_path=self.settings.exiftool_path,
                )
                if outcome.error:
                    raise ApiError(
                        ErrorCode.SOURCE_CHANGED,
                        "导出前重新扫描相册失败，请检查目录权限后重试。",
                        status_code=409,
                        details={"reason": outcome.error[:500]},
                    )
                return self._build_preflight(session, album)
        finally:
            session.close()

    def _build_preflight(self, session: Session, album: Album) -> dict[str, Any]:
        selected = list(
            session.scalars(
                select(PhotoGroup)
                .where(
                    PhotoGroup.album_id == album.id,
                    PhotoGroup.selection_status == SELECTION_SELECTED,
                    PhotoGroup.deleted_at.is_(None),
                )
                .order_by(PhotoGroup.sort_key.asc(), PhotoGroup.id.asc())
            )
        )
        groups: list[dict[str, Any]] = []
        warnings: list[dict[str, Any]] = []
        file_count = 0
        total_bytes = 0
        jpg_count = 0
        raw_count = 0
        existing_count = 0
        conflict_count = 0
        to_copy = 0

        for group in selected:
            if group.pairing_status != PAIRING_NORMAL:
                warnings.append(
                    {
                        "code": ErrorCode.PAIRING_CONFLICT
                        if group.pairing_status == PAIRING_CONFLICT
                        else ErrorCode.ASSET_MISSING,
                        "groupId": group.id,
                        "displayName": group.display_name,
                        "message": (
                            "配对冲突，已排除导出。"
                            if group.pairing_status == PAIRING_CONFLICT
                            else "存在缺失文件，已排除导出。"
                        ),
                    }
                )
                continue
            assets = sorted(
                [asset for asset in group.assets if asset.presence_status == PRESENCE_PRESENT],
                key=lambda a: (0 if a.kind == "jpg" else 1, a.relative_path),
            )
            if not assets:
                warnings.append(
                    {
                        "code": ErrorCode.ASSET_MISSING,
                        "groupId": group.id,
                        "displayName": group.display_name,
                        "message": "没有可导出的文件。",
                    }
                )
                continue
            asset_snapshots: list[dict[str, Any]] = []
            for asset in assets:
                extension = asset.extension.lower()
                if extension not in SUPPORTED_EXTENSIONS:
                    warnings.append(
                        {
                            "code": ErrorCode.UNSUPPORTED_FILE_TYPE,
                            "groupId": group.id,
                            "displayName": group.display_name,
                            "relativePath": asset.relative_path,
                            "message": "不支持的文件扩展名，已跳过。",
                        }
                    )
                    continue
                kind_dir = "JPG" if asset.kind == "jpg" else "RAW"
                try:
                    target = self.guard.export_file_path(
                        album.relative_path, kind_dir, asset.original_filename, must_exist=False
                    )
                except ApiError as exc:
                    warnings.append(
                        {
                            "code": exc.code,
                            "groupId": group.id,
                            "displayName": group.display_name,
                            "relativePath": asset.relative_path,
                            "message": f"导出目标不可用：{exc.message}",
                        }
                    )
                    continue
                exists = target.exists()
                same_size = False
                if exists and target.is_file() and not target.is_symlink():
                    try:
                        same_size = target.stat().st_size == asset.size_bytes
                    except OSError:
                        same_size = False
                if exists:
                    if same_size:
                        existing_count += 1
                    else:
                        conflict_count += 1
                else:
                    to_copy += 1
                asset_snapshots.append(
                    {
                        "assetId": asset.id,
                        "relativePath": asset.relative_path,
                        "kind": asset.kind,
                        "extension": asset.extension,
                        "originalFilename": asset.original_filename,
                        "sizeBytes": asset.size_bytes,
                        "mtimeNs": asset.mtime_ns,
                        "targetRelativePath": str(target.relative_to(self.settings.photo_root)),
                        "targetExists": exists,
                        "targetSameSize": same_size,
                    }
                )
                file_count += 1
                total_bytes += asset.size_bytes
                if asset.kind == "jpg":
                    jpg_count += 1
                else:
                    raw_count += 1
            if asset_snapshots:
                groups.append(
                    {
                        "groupId": group.id,
                        "displayName": group.display_name,
                        "selectionStatus": group.selection_status,
                        "assets": asset_snapshots,
                    }
                )

        summary = {
            "photoCount": len(groups),
            "fileCount": file_count,
            "jpgCount": jpg_count,
            "rawCount": raw_count,
            "totalBytes": total_bytes,
            "toCopyCount": to_copy,
            "existingCount": existing_count,
            "conflictCount": conflict_count,
        }
        destination_relative = f"{self.settings.export_dir_name}/{album.relative_path}"
        if not groups:
            return {
                "albumId": album.id,
                "token": None,
                "expiresAt": None,
                "operationId": None,
                "summary": summary,
                "warnings": warnings,
                "destinationRelativePath": destination_relative,
                "destinationAbsolutePath": str(self.settings.export_root / album.relative_path),
                "message": "当前没有可导出的精选照片。",
            }

        operation = create_operation(
            session,
            album_id=album.id,
            type=OP_TYPE_EXPORT,
            status=OP_STATUS_PREFLIGHT,
            requested_photo_count=summary["photoCount"],
            requested_file_count=summary["fileCount"],
            request_snapshot={"groups": groups, "warnings": warnings, "summary": summary},
        )
        session.commit()
        raw_token, expires_at = issue_preflight(
            session,
            album_id=album.id,
            kind=PREFLIGHT_EXPORT,
            operation_id=operation.id,
            payload={"groups": groups, "summary": summary},
            ttl_seconds=self.settings.export_preflight_ttl_seconds,
        )
        return {
            "albumId": album.id,
            "token": raw_token,
            "expiresAt": expires_at,
            "operationId": operation.id,
            "summary": summary,
            "warnings": warnings,
            "destinationRelativePath": destination_relative,
            "destinationAbsolutePath": str(self.settings.export_root / album.relative_path),
            "message": (
                f"将复制 {summary['fileCount']} 个文件（JPG {jpg_count}，RAW {raw_count}）到精选目录，"
                f"源文件不会改变。已存在 {existing_count} 个，潜在冲突 {conflict_count} 个。"
            ),
        }

    # ------------------------------------------------------------------
    # 执行
    # ------------------------------------------------------------------
    def execute(self, album_id: str, *, token: str, idempotency_key: str) -> dict[str, Any]:
        if not idempotency_key or len(idempotency_key) > 128:
            raise ApiError(ErrorCode.INVALID_REQUEST, "缺少有效的幂等键。", status_code=400)
        session = self.database.session()
        try:
            album = session.get(Album, album_id)
            if album is None or album.deleted_at is not None:
                raise ApiError(ErrorCode.ALBUM_NOT_FOUND, "相册不存在。", status_code=404)
            existing = find_by_idempotency_key(session, idempotency_key)
            if existing is not None:
                if existing.album_id != album_id or existing.type != OP_TYPE_EXPORT:
                    raise ApiError(
                        ErrorCode.INVALID_REQUEST,
                        "该幂等键已被其他操作使用，请重新发起。",
                        status_code=409,
                    )
                return self._replay(session, existing)
            token_row = load_preflight(session, raw_token=token, kind=PREFLIGHT_EXPORT, album_id=album_id)
            payload = json.loads(token_row.payload_json)
            operation_id = token_row.operation_id
            try:
                claimed = session.execute(
                    update(Operation)
                    .where(
                        Operation.id == operation_id,
                        Operation.status == OP_STATUS_PREFLIGHT,
                        Operation.idempotency_key.is_(None),
                    )
                    .values(
                        status=OP_STATUS_EXECUTING,
                        idempotency_key=idempotency_key,
                        started_at=utcnow_iso(),
                    )
                )
                if claimed.rowcount != 1:
                    session.rollback()
                    existing = find_by_idempotency_key(session, idempotency_key)
                    if existing is not None:
                        if existing.album_id != album_id or existing.type != OP_TYPE_EXPORT:
                            raise ApiError(
                                ErrorCode.INVALID_REQUEST,
                                "该幂等键已被其他操作使用，请重新发起。",
                                status_code=409,
                            ) from None
                        return self._replay(session, existing)
                    raise ApiError(
                        ErrorCode.PREFLIGHT_CONSUMED, "该预检已被执行，请重新预检。", status_code=409
                    ) from None
                consume_preflight(session, token_row)
                session.commit()
            except IntegrityError:
                session.rollback()
                existing = find_by_idempotency_key(session, idempotency_key)
                if existing is not None:
                    if existing.album_id != album_id or existing.type != OP_TYPE_EXPORT:
                        raise ApiError(
                            ErrorCode.INVALID_REQUEST,
                            "该幂等键已被其他操作使用，请重新发起。",
                            status_code=409,
                        ) from None
                    return self._replay(session, existing)
                raise ApiError(ErrorCode.PREFLIGHT_CONSUMED, "该预检已被执行，请重新预检。", status_code=409) from None

            job_id = self.jobs.submit(
                kind="export",
                operation_id=operation_id,
                run=lambda job: self._run_export(operation_id, album_id, payload, job),
            )
            return {
                "operationId": operation_id,
                "jobId": job_id,
                "status": "running",
                "idempotentReplay": False,
            }
        finally:
            session.close()

    def _replay(self, session: Session, operation: Operation) -> dict[str, Any]:
        album = session.get(Album, operation.album_id) if operation.album_id else None
        job = self.jobs.for_operation(operation.id)
        items = operation_items(session, operation.id)
        return {
            "operationId": operation.id,
            "jobId": job.id if job else None,
            "status": job.status if job else operation.status,
            "operation": operation_to_dict(
                operation,
                album_name=album.name if album else None,
                items=items,
                can_restore=False,
            ),
            "idempotentReplay": True,
        }

    def _run_export(self, operation_id: str, album_id: str, payload: dict[str, Any], job) -> None:  # noqa: ANN001
        session = self.database.session()
        try:
            album = session.get(Album, album_id)
            operation = session.get(Operation, operation_id)
            if album is None or operation is None:
                raise ApiError(ErrorCode.ALBUM_NOT_FOUND, "相册或操作记录不存在。", status_code=404)
            operation_id_captured = operation.id
            lock = self.scan_service.album_lock(album_id)
            with lock:
                try:
                    self._export_locked(session, album, operation, payload, job)
                except Exception:
                    session.rollback()
                    failed_operation = session.get(Operation, operation_id_captured)
                    if failed_operation is not None and failed_operation.status == OP_STATUS_EXECUTING:
                        finish_operation(
                            session,
                            failed_operation,
                            status=OP_STATUS_FAILED,
                            failed=failed_operation.requested_file_count,
                            error_summary="导出任务异常中止，请查看操作记录。",
                        )
                    raise
        finally:
            session.close()

    def _export_locked(
        self,
        session: Session,
        album: Album,
        operation: Operation,
        payload: dict[str, Any],
        job,  # noqa: ANN001
    ) -> None:
        groups = payload.get("groups", [])
        total_files = sum(len(group["assets"]) for group in groups)
        album_export_dir = self.guard.export_dir_for_album(album.relative_path)
        try:
            album_export_dir.mkdir(parents=True, exist_ok=True)
            self.guard.ensure_still_inside(album_export_dir, base=self.guard.export_root)
            for kind_dir in ("JPG", "RAW"):
                (album_export_dir / kind_dir).mkdir(exist_ok=True)
        except OSError as exc:
            finish_operation(
                session,
                operation,
                status=OP_STATUS_FAILED,
                failed=total_files,
                error_summary=f"无法创建导出目录：{exc}",
            )
            raise ApiError(ErrorCode.DEPENDENCY_UNAVAILABLE, f"无法创建导出目录：{exc}", status_code=500) from exc

        items: list[OperationItem] = []
        for group_index, group in enumerate(groups):
            for asset in group["assets"]:
                item = OperationItem(
                    operation_id=operation.id,
                    photo_group_id=group["groupId"],
                    asset_id=asset["assetId"],
                    display_name=group["displayName"],
                    source_relative_path=asset["relativePath"],
                    destination_path_snapshot=asset["targetRelativePath"],
                    source_size_bytes=asset["sizeBytes"],
                    source_mtime_ns=asset["mtimeNs"],
                    result=ITEM_PENDING,
                    group_index=group_index,
                )
                session.add(item)
                items.append(item)
        session.commit()

        processed = 0
        success = 0
        skipped = 0
        failed = 0
        conflicts = 0
        for group in groups:
            for asset, item in zip(
                group["assets"],
                [i for i in items if i.photo_group_id == group["groupId"]],
                strict=False,
            ):
                processed += 1
                try:
                    source = self.guard.asset_path(album.relative_path, asset["relativePath"], must_exist=True)
                    stat = source.stat()
                    if stat.st_size != asset["sizeBytes"] or stat.st_mtime_ns != asset["mtimeNs"]:
                        item.result = ITEM_FAILED
                        item.error_code = ErrorCode.SOURCE_CHANGED
                        item.error_message = "预检后源文件发生变化，该项未导出。"
                        failed += 1
                        session.commit()
                        self._progress(
                            session,
                            operation,
                            job,
                            processed,
                            total_files,
                            success,
                            skipped,
                            failed,
                            conflicts,
                        )
                        continue
                    kind_dir = "JPG" if asset["kind"] == "jpg" else "RAW"
                    target = self.guard.export_file_path(
                        album.relative_path, kind_dir, asset["originalFilename"], must_exist=False
                    )
                    target.parent.mkdir(parents=True, exist_ok=True)
                    outcome = export_one(
                        source,
                        target,
                        expected_size=asset["sizeBytes"],
                        expected_mtime_ns=asset["mtimeNs"],
                    )
                except ApiError as exc:
                    item.result = ITEM_FAILED
                    item.error_code = exc.code
                    item.error_message = exc.message
                    failed += 1
                    session.commit()
                    self._progress(session, operation, job, processed, total_files, success, skipped, failed, conflicts)
                    continue
                except OSError as exc:
                    item.result = ITEM_FAILED
                    item.error_code = "EXPORT_FAILED"
                    item.error_message = f"导出失败：{exc}"
                    failed += 1
                    session.commit()
                    self._progress(session, operation, job, processed, total_files, success, skipped, failed, conflicts)
                    continue

                item.content_sha256 = outcome.sha256
                if outcome.result == ITEM_SUCCESS:
                    item.result = ITEM_SUCCESS
                    success += 1
                    clear_export_conflict(
                        session,
                        album_id=album.id,
                        source_relative_path=asset["relativePath"],
                        destination_relative_path=asset["targetRelativePath"],
                    )
                elif outcome.result == ITEM_SKIPPED:
                    item.result = ITEM_SKIPPED
                    item.error_code = None
                    item.error_message = "目标已存在相同内容，跳过。"
                    skipped += 1
                    clear_export_conflict(
                        session,
                        album_id=album.id,
                        source_relative_path=asset["relativePath"],
                        destination_relative_path=asset["targetRelativePath"],
                    )
                elif outcome.result == ITEM_CONFLICT:
                    item.result = ITEM_CONFLICT
                    item.error_code = outcome.error_code
                    item.error_message = outcome.error_message
                    conflicts += 1
                    upsert_export_conflict(
                        session,
                        album_id=album.id,
                        source_relative_path=asset["relativePath"],
                        destination_relative_path=asset["targetRelativePath"],
                        operation_id=operation.id,
                        source_size=asset["sizeBytes"],
                        destination_size=outcome.destination_size,
                    )
                else:
                    item.result = ITEM_FAILED
                    item.error_code = outcome.error_code
                    item.error_message = outcome.error_message
                    failed += 1
                session.commit()
                self._progress(session, operation, job, processed, total_files, success, skipped, failed, conflicts)

        status = derive_status(total=total_files, success=success, failed=failed, conflicts=conflicts)
        summary_parts = [f"成功 {success} 个"]
        if skipped:
            summary_parts.append(f"跳过 {skipped} 个（内容相同）")
        if conflicts:
            summary_parts.append(f"冲突 {conflicts} 个（未覆盖）")
        if failed:
            summary_parts.append(f"失败 {failed} 个")
        finish_operation(
            session,
            operation,
            status=status,
            success=success,
            skipped=skipped,
            failed=failed,
            conflicts=conflicts,
            error_summary="；".join(summary_parts) if (failed or conflicts) else None,
        )
        self._progress(session, operation, job, processed, total_files, success, skipped, failed, conflicts)
        if self.events is not None:
            self.events.publish(album.id, "export_finished", {"operationId": operation.id, "status": status})

    def _progress(
        self,
        session: Session,
        operation: Operation,
        job,  # noqa: ANN001
        processed: int,
        total: int,
        success: int,
        skipped: int,
        failed: int,
        conflicts: int,
    ) -> None:
        progress = {
            "processedFiles": processed,
            "totalFiles": total,
            "successFiles": success,
            "skippedFiles": skipped,
            "failedFiles": failed,
            "conflictFiles": conflicts,
        }
        if job is not None:
            self.jobs.update_progress(job.id, progress)
        set_progress(
            session,
            operation,
            processed_files=processed,
            total_files=total,
            success=success,
            skipped=skipped,
            failed=failed,
            conflicts=conflicts,
        )
