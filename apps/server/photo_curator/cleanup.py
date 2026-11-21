"""待删除清理：预检 → 确认执行 → 分组移入废纸篓 → 撤销恢复。

安全原则：
- 标记待删除绝不移动文件；
- 预检后任何文件变化都会让整批执行失败（409），不做半批；
- 每张逻辑照片是一个操作组，JPG＋RAW 必须全部成功，否则回滚该组；
- 组内任一文件失败后立即停止该组，不继续移动剩余文件；
- 回滚失败必须标记为严重失败并保留实际位置，绝不报告成功；
- 只使用 macOS 原生废纸篓 API，不存在永久删除路径。
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .config import Settings
from .constants import (
    ISSUE_CLEANUP_INCOMPLETE,
    ITEM_CONFLICT,
    ITEM_FAILED,
    ITEM_PENDING,
    ITEM_RESTORED,
    ITEM_SUCCESS,
    OP_STATUS_EXECUTING,
    OP_STATUS_FAILED,
    OP_STATUS_PARTIAL_FAILURE,
    OP_STATUS_PREFLIGHT,
    OP_STATUS_RESTORED,
    OP_STATUS_SUCCESS,
    OP_TYPE_CLEANUP,
    OP_TYPE_RESTORE,
    PAIRING_CONFLICT,
    PAIRING_MISSING,
    PAIRING_NORMAL,
    PAIRING_TRASHED,
    PREFLIGHT_CLEANUP,
    PRESENCE_MISSING,
    PRESENCE_PRESENT,
    PREVIEW_PENDING,
    SELECTION_PENDING_DELETE,
    SUPPORTED_EXTENSIONS,
)
from .db import Database
from .errors import ApiError, ErrorCode
from .models import Album, Asset, Operation, OperationItem, PhotoGroup
from .natural import iso_after, utcnow_iso
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
from .trash import BaseTrashService, RestoreResult, TrashResult

UNDO_WINDOW_SECONDS = 15


def can_restore_cleanup(operation: Operation, items: list[OperationItem]) -> bool:
    if operation.type != OP_TYPE_CLEANUP:
        return False
    if operation.restored_at is not None:
        return False
    if operation.status not in {OP_STATUS_SUCCESS, OP_STATUS_PARTIAL_FAILURE}:
        return False
    return any(item.result == ITEM_SUCCESS and item.destination_path_snapshot for item in items)


def _group_summary(items: list[OperationItem]) -> dict[str, int]:
    groups: dict[int, list[OperationItem]] = {}
    for item in items:
        groups.setdefault(item.group_index, []).append(item)
    succeeded = sum(1 for group_items in groups.values() if all(i.result == ITEM_SUCCESS for i in group_items))
    return {
        "requested": len(groups),
        "succeeded": succeeded,
        "failed": len(groups) - succeeded,
    }


def _serious_errors(items: list[OperationItem]) -> list[dict[str, Any]]:
    return [
        {
            "photoGroupId": item.photo_group_id,
            "displayName": item.display_name,
            "sourceRelativePath": item.source_relative_path,
            "actualLocation": item.destination_path_snapshot,
            "message": item.error_message,
        }
        for item in items
        if item.error_code == ErrorCode.ROLLBACK_FAILED
    ]


def _snapshot_group(group: PhotoGroup) -> dict[str, Any]:
    assets = sorted(
        [asset for asset in group.assets if asset.presence_status == PRESENCE_PRESENT],
        key=lambda a: (0 if a.kind == "jpg" else 1, a.relative_path),
    )
    return {
        "groupId": group.id,
        "displayName": group.display_name,
        "selectionStatus": group.selection_status,
        "pairingStatus": group.pairing_status,
        "version": group.version,
        "assets": [
            {
                "assetId": asset.id,
                "relativePath": asset.relative_path,
                "kind": asset.kind,
                "extension": asset.extension,
                "originalFilename": asset.original_filename,
                "sizeBytes": asset.size_bytes,
                "mtimeNs": asset.mtime_ns,
            }
            for asset in assets
        ],
    }


class CleanupService:
    def __init__(
        self,
        settings: Settings,
        database: Database,
        guard: PathGuard,
        scan_service: ScanService,
        trash_service: BaseTrashService,
        events=None,  # noqa: ANN001
    ) -> None:
        self.settings = settings
        self.database = database
        self.guard = guard
        self.scan_service = scan_service
        self.trash = trash_service
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
                    trigger="cleanup_preflight",
                    record_operation=True,
                    exiftool_path=self.settings.exiftool_path,
                )
                if outcome.error:
                    raise ApiError(
                        ErrorCode.SOURCE_CHANGED,
                        "清理前重新扫描相册失败，请检查目录权限后重试。",
                        status_code=409,
                        details={"reason": outcome.error[:500]},
                    )
                return self._build_preflight(session, album)
        finally:
            session.close()

    def _build_preflight(self, session: Session, album: Album) -> dict[str, Any]:
        candidates = list(
            session.scalars(
                select(PhotoGroup)
                .where(
                    PhotoGroup.album_id == album.id,
                    PhotoGroup.selection_status == SELECTION_PENDING_DELETE,
                    PhotoGroup.pairing_status != PAIRING_TRASHED,
                    PhotoGroup.deleted_at.is_(None),
                )
                .order_by(PhotoGroup.sort_key.asc(), PhotoGroup.id.asc())
            )
        )
        groups: list[dict[str, Any]] = []
        blockers: list[dict[str, Any]] = []
        total_bytes = 0
        file_count = 0

        for group in candidates:
            snapshot = _snapshot_group(group)
            group_blocked = False
            if group.pairing_status == PAIRING_CONFLICT:
                blockers.append(
                    {
                        "code": ErrorCode.PAIRING_CONFLICT,
                        "message": "配对冲突，不能自动清理。",
                        "groupId": group.id,
                        "displayName": group.display_name,
                    }
                )
                group_blocked = True
            elif group.pairing_status != PAIRING_NORMAL:
                blockers.append(
                    {
                        "code": ErrorCode.ASSET_MISSING,
                        "message": "逻辑照片存在缺失文件，不能清理。",
                        "groupId": group.id,
                        "displayName": group.display_name,
                    }
                )
                group_blocked = True

            if not snapshot["assets"]:
                blockers.append(
                    {
                        "code": ErrorCode.ASSET_MISSING,
                        "message": "没有可移动的文件。",
                        "groupId": group.id,
                        "displayName": group.display_name,
                    }
                )
                group_blocked = True

            for asset_snapshot in snapshot["assets"]:
                if asset_snapshot["extension"].lower() not in SUPPORTED_EXTENSIONS:
                    blockers.append(
                        {
                            "code": ErrorCode.UNSUPPORTED_FILE_TYPE,
                            "message": "文件扩展名不受支持，拒绝清理。",
                            "groupId": group.id,
                            "displayName": group.display_name,
                            "relativePath": asset_snapshot["relativePath"],
                        }
                    )
                    group_blocked = True
                    continue
                try:
                    path = self.guard.asset_path(album.relative_path, asset_snapshot["relativePath"], must_exist=True)
                    stat = path.stat()
                except ApiError as exc:
                    blockers.append(
                        {
                            "code": exc.code,
                            "message": exc.message,
                            "groupId": group.id,
                            "displayName": group.display_name,
                            "relativePath": asset_snapshot["relativePath"],
                        }
                    )
                    group_blocked = True
                    continue
                if stat.st_size != asset_snapshot["sizeBytes"] or stat.st_mtime_ns != asset_snapshot["mtimeNs"]:
                    blockers.append(
                        {
                            "code": ErrorCode.SOURCE_CHANGED,
                            "message": "文件在扫描后发生了变化，请重新扫描。",
                            "groupId": group.id,
                            "displayName": group.display_name,
                            "relativePath": asset_snapshot["relativePath"],
                        }
                    )
                    group_blocked = True
                total_bytes += stat.st_size
                file_count += 1

            snapshot["blocked"] = group_blocked
            groups.append(snapshot)

        summary = {
            "photoCount": len(groups),
            "fileCount": file_count,
            "totalBytes": total_bytes,
            "jpgCount": sum(1 for g in groups for a in g["assets"] if a["kind"] == "jpg"),
            "rawCount": sum(1 for g in groups for a in g["assets"] if a["kind"] == "raw"),
        }

        if not groups:
            return {
                "albumId": album.id,
                "token": None,
                "expiresAt": None,
                "operationId": None,
                "summary": summary,
                "blocked": False,
                "blockers": [],
                "groups": [],
                "message": "当前没有标记为待删除的照片。",
            }

        operation = create_operation(
            session,
            album_id=album.id,
            type=OP_TYPE_CLEANUP,
            status=OP_STATUS_PREFLIGHT,
            requested_photo_count=summary["photoCount"],
            requested_file_count=summary["fileCount"],
            request_snapshot={"groups": groups, "blockers": blockers, "summary": summary},
        )
        group_index = 0
        for snapshot in groups:
            for asset_snapshot in snapshot["assets"]:
                session.add(
                    OperationItem(
                        operation_id=operation.id,
                        photo_group_id=snapshot["groupId"],
                        asset_id=asset_snapshot["assetId"],
                        display_name=snapshot["displayName"],
                        source_relative_path=asset_snapshot["relativePath"],
                        source_size_bytes=asset_snapshot["sizeBytes"],
                        source_mtime_ns=asset_snapshot["mtimeNs"],
                        result=ITEM_PENDING,
                        group_index=group_index,
                    )
                )
            group_index += 1
        session.commit()

        raw_token, expires_at = issue_preflight(
            session,
            album_id=album.id,
            kind=PREFLIGHT_CLEANUP,
            operation_id=operation.id,
            payload={"groups": groups, "blockers": blockers, "summary": summary},
            ttl_seconds=self.settings.preflight_ttl_seconds,
        )
        return {
            "albumId": album.id,
            "token": raw_token,
            "expiresAt": expires_at,
            "operationId": operation.id,
            "summary": summary,
            "blocked": bool(blockers),
            "blockers": blockers,
            "groups": groups,
            "message": (
                "存在阻止项，整批清理已禁止。请先处理异常后重新预检。"
                if blockers
                else (
                    f"将把 {summary['photoCount']} 张逻辑照片的 {summary['fileCount']} 个文件"
                    "移入 macOS 废纸篓，不会永久删除。"
                )
            ),
        }

    # ------------------------------------------------------------------
    # 执行
    # ------------------------------------------------------------------
    def execute(self, album_id: str, *, token: str, idempotency_key: str) -> dict[str, Any]:
        if not idempotency_key or len(idempotency_key) > 128:
            raise ApiError(ErrorCode.INVALID_REQUEST, "缺少有效的幂等键。", status_code=400)
        session = self.database.session()
        result: dict[str, Any] | None = None
        try:
            album = session.get(Album, album_id)
            if album is None or album.deleted_at is not None:
                raise ApiError(ErrorCode.ALBUM_NOT_FOUND, "相册不存在。", status_code=404)
            existing = find_by_idempotency_key(session, idempotency_key)
            if existing is not None:
                if existing.album_id != album_id or existing.type != OP_TYPE_CLEANUP:
                    raise ApiError(
                        ErrorCode.INVALID_REQUEST,
                        "该幂等键已被其他操作使用，请重新发起。",
                        status_code=409,
                    )
                return self._replay(session, existing)

            token_row = load_preflight(session, raw_token=token, kind=PREFLIGHT_CLEANUP, album_id=album_id)
            payload = json.loads(token_row.payload_json)
            if payload.get("blockers"):
                raise ApiError(
                    ErrorCode.PREFLIGHT_BLOCKED,
                    "预检存在阻止项，整批清理已禁止。请处理异常后重新预检。",
                    status_code=409,
                    details={"blockers": payload["blockers"]},
                )
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
                        if existing.album_id != album_id or existing.type != OP_TYPE_CLEANUP:
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
                    if existing.album_id != album_id or existing.type != OP_TYPE_CLEANUP:
                        raise ApiError(
                            ErrorCode.INVALID_REQUEST,
                            "该幂等键已被其他操作使用，请重新发起。",
                            status_code=409,
                        ) from None
                    return self._replay(session, existing)
                raise ApiError(ErrorCode.PREFLIGHT_CONSUMED, "该预检已被执行，请重新预检。", status_code=409) from None

            operation = session.get(Operation, operation_id)
            if operation is None:
                raise ApiError(ErrorCode.OPERATION_NOT_FOUND, "操作记录不存在。", status_code=404)
            lock = self.scan_service.album_lock(album_id)
            with lock:
                try:
                    verification = self._verify_snapshot(session, album, payload)
                    if verification:
                        self._fail_verification(session, operation)
                        raise ApiError(
                            ErrorCode.SOURCE_CHANGED,
                            "预检后文件或配对状态发生变化，整批清理未执行。请重新预检。",
                            status_code=409,
                            details={"operationId": operation.id, "reasons": verification},
                        )
                    result = self._execute_groups(session, album, operation, payload)
                except ApiError:
                    raise
                except Exception as exc:  # noqa: BLE001 - 未预期错误必须落库
                    session.rollback()
                    operation = session.get(Operation, operation_id)
                    if operation is not None and operation.status == OP_STATUS_EXECUTING:
                        finish_operation(
                            session,
                            operation,
                            status=OP_STATUS_FAILED,
                            failed=operation.requested_file_count,
                            error_summary=f"清理执行异常：{exc}"[:2000],
                        )
                    raise ApiError(
                        ErrorCode.TRASH_OPERATION_FAILED,
                        "清理执行过程中发生异常，已停止。请查看操作记录。",
                        status_code=500,
                        details={"reason": str(exc)[:500]},
                    ) from exc
        finally:
            session.close()
        if result is not None:
            self._publish(album_id, "cleanup_finished", {"operationId": result["operation"]["id"]})
            return result
        raise ApiError(ErrorCode.INTERNAL_ERROR, "清理未完成。", status_code=500)

    def _execute_groups(
        self, session: Session, album: Album, operation: Operation, payload: dict[str, Any]
    ) -> dict[str, Any]:
        items = operation_items(session, operation.id)
        item_by_asset = {item.asset_id: item for item in items if item.asset_id}
        groups = payload["groups"]
        total_files = sum(len(group["assets"]) for group in groups)
        processed = 0
        success_files = 0
        failed_files = 0
        succeeded_groups = 0
        failed_groups = 0
        rollback_failed_any = False

        for group_snapshot in groups:
            group = session.get(PhotoGroup, group_snapshot["groupId"])
            if group is None:
                continue
            moved: list[tuple[OperationItem, Asset, str]] = []
            group_failed = False
            group_error_code: str | None = None
            group_error_message: str | None = None
            attempted_assets: set[str] = set()

            for asset_snapshot in group_snapshot["assets"]:
                if group_failed:
                    break
                item = item_by_asset.get(asset_snapshot["assetId"])
                asset = session.get(Asset, asset_snapshot["assetId"])
                if item is None or asset is None:
                    continue
                attempted_assets.add(asset_snapshot["assetId"])
                outcome: TrashResult
                try:
                    path = self.guard.asset_path(album.relative_path, asset.relative_path, must_exist=True)
                    outcome = self.trash.trash(path)
                except ApiError as exc:
                    outcome = TrashResult(False, error_code=exc.code, error_message=exc.message)
                processed += 1
                if outcome.ok:
                    item.result = ITEM_SUCCESS
                    item.destination_path_snapshot = str(outcome.trashed_path)
                    item.error_code = None
                    item.error_message = None
                    asset.presence_status = PRESENCE_MISSING
                    moved.append((item, asset, str(outcome.trashed_path)))
                else:
                    group_failed = True
                    group_error_code = outcome.error_code or ErrorCode.TRASH_OPERATION_FAILED
                    group_error_message = outcome.error_message or "移入废纸篓失败。"
                    item.result = ITEM_FAILED
                    item.error_code = group_error_code
                    item.error_message = f"{group_error_code}：{group_error_message}"
                session.commit()

            if group_failed:
                failed_groups += 1
                failed_files += len(group_snapshot["assets"])
                # 回滚本组已移动文件，绝不留下静默的半组。
                rollback_failed = False
                for item, asset, trashed_path in reversed(moved):
                    original_path = self.guard.asset_path(album.relative_path, asset.relative_path, must_exist=False)
                    restore_result: RestoreResult = self.trash.restore(Path(trashed_path), original_path)
                    if restore_result.ok:
                        item.result = ITEM_RESTORED
                        item.error_code = group_error_code
                        item.error_message = "同组文件移动失败，该文件已回滚到原路径。"
                        item.destination_path_snapshot = None
                        asset.presence_status = PRESENCE_PRESENT
                    else:
                        rollback_failed = True
                        rollback_failed_any = True
                        item.result = ITEM_FAILED
                        item.error_code = ErrorCode.ROLLBACK_FAILED
                        item.error_message = f"回滚失败：{restore_result.error_message}；文件实际位置：{trashed_path}"
                        item.destination_path_snapshot = trashed_path
                    session.commit()

                # 未尝试的同组文件标记失败，避免留下 pending 造成误解。
                for asset_snapshot in group_snapshot["assets"]:
                    if asset_snapshot["assetId"] in attempted_assets:
                        continue
                    item = item_by_asset.get(asset_snapshot["assetId"])
                    if item is None:
                        continue
                    item.result = ITEM_FAILED
                    item.error_code = group_error_code or ErrorCode.TRASH_OPERATION_FAILED
                    item.error_message = "同组其他文件移动失败，该文件未执行移动。"
                session.commit()

                if rollback_failed:
                    group.pairing_status = PAIRING_CONFLICT
                    group.conflict_reasons_json = json.dumps(["cleanup_incomplete"], ensure_ascii=False)
                    self._record_incomplete_issue(session, album, group, operation)
                else:
                    group.pairing_status = PAIRING_NORMAL
                group.updated_at = utcnow_iso()
                operation.error_summary = f"{group.display_name}：{group_error_message or '移动失败'}。" + (
                    "存在无法回滚的文件，请立即核对。" if rollback_failed else "已回滚本组已移动文件。"
                )
                session.commit()
            else:
                succeeded_groups += 1
                success_files += len(group_snapshot["assets"])
                group.pairing_status = PAIRING_TRASHED
                group.conflict_reasons_json = None
                group.updated_at = utcnow_iso()
                session.commit()

            set_progress(
                session,
                operation,
                processed_files=processed,
                total_files=total_files,
                success=success_files,
                skipped=0,
                failed=failed_files,
            )

        self._refresh_cover(session, album)
        status = derive_status(total=len(groups), success=succeeded_groups, failed=failed_groups, conflicts=0)
        error_summary = None
        if failed_groups:
            error_summary = f"{failed_groups} 组清理失败，{succeeded_groups} 组成功。" + (
                "存在回滚失败，请立即核对操作明细。" if rollback_failed_any else "失败组已回滚。"
            )
        finish_operation(
            session,
            operation,
            status=status,
            success=success_files,
            skipped=0,
            failed=failed_files,
            conflicts=0,
            error_summary=error_summary,
        )
        session.refresh(operation)
        final_items = operation_items(session, operation.id)
        serialized = operation_to_dict(
            operation,
            album_name=album.name,
            items=final_items,
            can_restore=can_restore_cleanup(operation, final_items),
        )
        return {
            "operation": serialized,
            "groupSummary": _group_summary(final_items),
            "seriousErrors": _serious_errors(final_items),
            "undoAvailableUntil": iso_after(UNDO_WINDOW_SECONDS),
            "idempotentReplay": False,
        }

    def _verify_snapshot(self, session: Session, album: Album, payload: dict[str, Any]) -> list[dict[str, Any]]:
        reasons: list[dict[str, Any]] = []
        for group_snapshot in payload.get("groups", []):
            group = session.get(PhotoGroup, group_snapshot["groupId"])
            if group is None:
                reasons.append(
                    {
                        "code": ErrorCode.SOURCE_CHANGED,
                        "message": "逻辑照片记录已不存在。",
                        "groupId": group_snapshot["groupId"],
                    }
                )
                continue
            if group.selection_status != SELECTION_PENDING_DELETE:
                reasons.append(
                    {
                        "code": ErrorCode.SOURCE_CHANGED,
                        "message": "筛选状态已改变。",
                        "groupId": group.id,
                        "displayName": group.display_name,
                    }
                )
                continue
            if group.pairing_status == PAIRING_TRASHED:
                reasons.append(
                    {
                        "code": ErrorCode.PAIRING_CONFLICT,
                        "message": "该逻辑照片已被清理。",
                        "groupId": group.id,
                        "displayName": group.display_name,
                    }
                )
                continue
            if group.pairing_status != PAIRING_NORMAL:
                reasons.append(
                    {
                        "code": ErrorCode.PAIRING_CONFLICT,
                        "message": "配对状态已变为冲突或缺失。",
                        "groupId": group.id,
                        "displayName": group.display_name,
                    }
                )
                continue
            current_assets = {
                asset.relative_path: asset for asset in group.assets if asset.presence_status == PRESENCE_PRESENT
            }
            snapshot_assets = {a["relativePath"]: a for a in group_snapshot["assets"]}
            if set(current_assets) != set(snapshot_assets):
                reasons.append(
                    {
                        "code": ErrorCode.SOURCE_CHANGED,
                        "message": "配对文件清单已变化。",
                        "groupId": group.id,
                        "displayName": group.display_name,
                    }
                )
                continue
            for relative_path, snapshot in snapshot_assets.items():
                asset = current_assets[relative_path]
                if asset.extension.lower() not in SUPPORTED_EXTENSIONS or asset.extension != snapshot.get("extension"):
                    reasons.append(
                        {
                            "code": ErrorCode.UNSUPPORTED_FILE_TYPE,
                            "message": "文件扩展名或类型在预检后发生变化。",
                            "groupId": group.id,
                            "displayName": group.display_name,
                            "relativePath": relative_path,
                        }
                    )
                    continue
                if asset.size_bytes != snapshot["sizeBytes"] or asset.mtime_ns != snapshot["mtimeNs"]:
                    reasons.append(
                        {
                            "code": ErrorCode.SOURCE_CHANGED,
                            "message": "文件大小或修改时间已变化。",
                            "groupId": group.id,
                            "displayName": group.display_name,
                            "relativePath": relative_path,
                        }
                    )
                    continue
                try:
                    path = self.guard.asset_path(album.relative_path, relative_path, must_exist=True)
                    stat = path.stat()
                except (ApiError, OSError) as exc:
                    reasons.append(
                        {
                            "code": ErrorCode.ASSET_MISSING,
                            "message": f"文件已不可访问：{exc}",
                            "groupId": group.id,
                            "displayName": group.display_name,
                            "relativePath": relative_path,
                        }
                    )
                    continue
                if stat.st_size != snapshot["sizeBytes"] or stat.st_mtime_ns != snapshot["mtimeNs"]:
                    reasons.append(
                        {
                            "code": ErrorCode.SOURCE_CHANGED,
                            "message": "磁盘上的文件已变化。",
                            "groupId": group.id,
                            "displayName": group.display_name,
                            "relativePath": relative_path,
                        }
                    )
        return reasons

    def _fail_verification(self, session: Session, operation: Operation) -> None:
        for item in operation_items(session, operation.id):
            item.result = ITEM_FAILED
            item.error_code = ErrorCode.SOURCE_CHANGED
            item.error_message = "预检后源文件发生变化，整批未执行。"
        finish_operation(
            session,
            operation,
            status=OP_STATUS_FAILED,
            failed=operation.requested_file_count,
            error_summary="预检后源文件或配对状态发生变化，整批清理未执行。请重新预检。",
        )

    def _record_incomplete_issue(self, session: Session, album: Album, group: PhotoGroup, operation: Operation) -> None:
        from .issues import record_issue

        record_issue(
            session,
            album_id=album.id,
            kind=ISSUE_CLEANUP_INCOMPLETE,
            fingerprint=f"cleanup_incomplete:{group.id}",
            message="清理过程中存在无法回滚的文件，请核对实际位置后再操作。",
            payload={"groupId": group.id, "displayName": group.display_name, "operationId": operation.id},
            severity="critical",
            operation_id=operation.id,
        )

    def _refresh_cover(self, session: Session, album: Album) -> None:
        cover = session.scalars(
            select(PhotoGroup)
            .where(
                PhotoGroup.album_id == album.id,
                PhotoGroup.pairing_status == PAIRING_NORMAL,
                PhotoGroup.deleted_at.is_(None),
                PhotoGroup.assets.any(Asset.presence_status == PRESENCE_PRESENT),
            )
            .order_by(PhotoGroup.sort_key.asc(), PhotoGroup.id.asc())
            .limit(1)
        ).first()
        album.cover_photo_id = cover.id if cover else None
        album.updated_at = utcnow_iso()
        session.commit()

    # ------------------------------------------------------------------
    # 撤销 / 恢复
    # ------------------------------------------------------------------
    def restore(self, operation_id: str) -> dict[str, Any]:
        session = self.database.session()
        result: dict[str, Any] | None = None
        album: Album | None = None
        try:
            cleanup = session.get(Operation, operation_id)
            if cleanup is None or cleanup.type != OP_TYPE_CLEANUP:
                raise ApiError(ErrorCode.OPERATION_NOT_FOUND, "清理操作不存在。", status_code=404)
            album = session.get(Album, cleanup.album_id) if cleanup.album_id else None
            if album is None:
                raise ApiError(ErrorCode.ALBUM_NOT_FOUND, "所属相册已不存在，无法恢复。", status_code=404)
            if cleanup.restored_at is not None:
                return self._already_restored(session, cleanup)
            if cleanup.restore_operation_id:
                previous = session.get(Operation, cleanup.restore_operation_id)
                if previous is not None and previous.status == OP_STATUS_EXECUTING:
                    raise ApiError(ErrorCode.PREFLIGHT_CONSUMED, "恢复操作正在进行中。", status_code=409)

            cleanup_items = operation_items(session, cleanup.id)
            successful_items = [item for item in cleanup_items if item.result == ITEM_SUCCESS]
            restorable = [item for item in successful_items if item.destination_path_snapshot]
            if not restorable:
                raise ApiError(
                    ErrorCode.RESTORE_FAILED,
                    "该清理操作没有可恢复的文件（可能已全部恢复或废纸篓已被清空）。",
                    status_code=400,
                )

            lock = self.scan_service.album_lock(album.id)
            with lock:
                session.refresh(cleanup)
                if cleanup.restored_at is not None:
                    return self._already_restored(session, cleanup)
                if cleanup.restore_operation_id:
                    running = session.get(Operation, cleanup.restore_operation_id)
                    if running is not None and running.status == OP_STATUS_EXECUTING:
                        raise ApiError(ErrorCode.PREFLIGHT_CONSUMED, "恢复操作正在进行中。", status_code=409)
                restore_operation = create_operation(
                    session,
                    album_id=album.id,
                    type=OP_TYPE_RESTORE,
                    status=OP_STATUS_EXECUTING,
                    parent_operation_id=cleanup.id,
                    requested_photo_count=cleanup.requested_photo_count,
                    requested_file_count=len(restorable),
                    request_snapshot={"cleanupOperationId": cleanup.id},
                )
                restore_operation.started_at = utcnow_iso()
                cleanup.restore_operation_id = restore_operation.id
                session.commit()

                success = 0
                conflicts = 0
                failed = 0
                group_ids: set[str] = set()
                for cleanup_item in restorable:
                    if cleanup_item.photo_group_id:
                        group_ids.add(cleanup_item.photo_group_id)
                    restore_item = OperationItem(
                        operation_id=restore_operation.id,
                        photo_group_id=cleanup_item.photo_group_id,
                        asset_id=cleanup_item.asset_id,
                        display_name=cleanup_item.display_name,
                        source_relative_path=cleanup_item.source_relative_path,
                        destination_path_snapshot=cleanup_item.destination_path_snapshot,
                        source_size_bytes=cleanup_item.source_size_bytes,
                        source_mtime_ns=cleanup_item.source_mtime_ns,
                        content_sha256=cleanup_item.content_sha256,
                        group_index=cleanup_item.group_index,
                    )
                    session.add(restore_item)
                    session.flush()
                    trashed_path = cleanup_item.destination_path_snapshot or ""
                    try:
                        original_path = self.guard.asset_path(
                            album.relative_path, cleanup_item.source_relative_path, must_exist=False
                        )
                    except ApiError as exc:
                        restore_item.result = ITEM_FAILED
                        restore_item.error_code = exc.code
                        restore_item.error_message = exc.message
                        failed += 1
                        session.commit()
                        continue
                    if original_path.exists():
                        restore_item.result = ITEM_CONFLICT
                        restore_item.error_code = ErrorCode.DESTINATION_CONFLICT
                        restore_item.error_message = "原路径已有新文件，未覆盖。"
                        conflicts += 1
                        session.commit()
                        continue
                    if not original_path.parent.is_dir():
                        restore_item.result = ITEM_FAILED
                        restore_item.error_code = ErrorCode.RESTORE_FAILED
                        restore_item.error_message = "原相册目录已不存在，请在 Finder 废纸篓中手动恢复。"
                        failed += 1
                        session.commit()
                        continue
                    outcome = self.trash.restore(Path(trashed_path), original_path)
                    if outcome.ok:
                        restore_item.result = ITEM_RESTORED
                        cleanup_item.result = ITEM_RESTORED
                        asset = session.get(Asset, cleanup_item.asset_id) if cleanup_item.asset_id else None
                        if asset is not None:
                            asset.presence_status = PRESENCE_PRESENT
                            asset.preview_status = PREVIEW_PENDING
                            asset.preview_error = None
                            asset.content_sha256 = None
                        success += 1
                    else:
                        restore_item.result = ITEM_FAILED
                        restore_item.error_code = outcome.error_code or ErrorCode.RESTORE_FAILED
                        restore_item.error_message = outcome.error_message or "恢复失败。"
                        failed += 1
                    session.commit()

                for group_id in group_ids:
                    group = session.get(PhotoGroup, group_id)
                    if group is None:
                        continue
                    assets = list(group.assets)
                    if assets and all(asset.presence_status == PRESENCE_PRESENT for asset in assets):
                        group.pairing_status = PAIRING_NORMAL
                        group.conflict_reasons_json = None
                    else:
                        group.pairing_status = PAIRING_MISSING
                    group.updated_at = utcnow_iso()
                session.commit()

                restore_status = derive_status(
                    total=len(restorable), success=success, failed=failed, conflicts=conflicts
                )
                finish_operation(
                    session,
                    restore_operation,
                    status=restore_status,
                    success=success,
                    skipped=0,
                    failed=failed,
                    conflicts=conflicts,
                    error_summary=(
                        f"已恢复 {success} 个文件，{conflicts} 个冲突未覆盖，{failed} 个失败。"
                        if (conflicts or failed)
                        else None
                    ),
                )
                session.refresh(restore_operation)
                session.refresh(cleanup)
                if restore_status == OP_STATUS_SUCCESS and success == len(restorable):
                    cleanup.status = OP_STATUS_RESTORED
                    cleanup.restored_at = utcnow_iso()
                    cleanup.error_summary = "已撤销清理，文件已恢复到原路径。"
                    session.commit()
                self._refresh_cover(session, album)
                cleanup_items = operation_items(session, cleanup.id)
                restore_items = operation_items(session, restore_operation.id)
                result = {
                    "operation": operation_to_dict(
                        restore_operation,
                        album_name=album.name,
                        items=restore_items,
                        can_restore=False,
                    ),
                    "originalOperation": operation_to_dict(
                        cleanup,
                        album_name=album.name,
                        items=cleanup_items,
                        can_restore=can_restore_cleanup(cleanup, cleanup_items),
                    ),
                    "alreadyRestored": False,
                }
        finally:
            session.close()
        if result is not None:
            self._publish(album.id, "restore_finished", {"operationId": result["operation"]["id"]})
            return result
        raise ApiError(ErrorCode.INTERNAL_ERROR, "恢复未完成。", status_code=500)

    def _already_restored(self, session: Session, cleanup: Operation) -> dict[str, Any]:
        album = session.get(Album, cleanup.album_id) if cleanup.album_id else None
        restore_operation = (
            session.get(Operation, cleanup.restore_operation_id) if cleanup.restore_operation_id else None
        )
        cleanup_items = operation_items(session, cleanup.id)
        restore_items = operation_items(session, restore_operation.id) if restore_operation else []
        return {
            "operation": operation_to_dict(
                restore_operation,
                album_name=album.name if album else None,
                items=restore_items,
                can_restore=False,
            )
            if restore_operation
            else None,
            "originalOperation": operation_to_dict(
                cleanup,
                album_name=album.name if album else None,
                items=cleanup_items,
                can_restore=False,
            ),
            "alreadyRestored": True,
        }

    def _replay(self, session: Session, operation: Operation) -> dict[str, Any]:
        album = session.get(Album, operation.album_id) if operation.album_id else None
        items = operation_items(session, operation.id)
        return {
            "operation": operation_to_dict(
                operation,
                album_name=album.name if album else None,
                items=items,
                can_restore=can_restore_cleanup(operation, items),
            ),
            "groupSummary": _group_summary(items),
            "seriousErrors": _serious_errors(items),
            "undoAvailableUntil": iso_after(UNDO_WINDOW_SECONDS),
            "idempotentReplay": True,
        }

    def _publish(self, album_id: str, event_type: str, payload: dict[str, Any]) -> None:
        if self.events is not None:
            self.events.publish(album_id, event_type, payload)
