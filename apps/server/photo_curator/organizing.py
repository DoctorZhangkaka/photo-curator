"""原地整理相册：把 JPG / RAW 分别移动到相册内的 JPG/、RAW/ 子目录。

安全原则：
- 只处理相册内、已扫描且配对正常的常规文件；
- 预检先重新扫描，列出完整移动计划；任何冲突都会阻止整批执行；
- 文件移动使用 link + unlink，目标已存在时绝不覆盖；
- 整批移动失败时回滚已移动文件；回滚失败会明确写入操作记录；
- 不移动逻辑照片状态，只更新 Asset.relative_path，配对关系不变；
- 每次移动都有 OperationItem 记录，支持后续显式回滚。
"""

from __future__ import annotations

import errno
import json
import os
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
    ITEM_RESTORED,
    ITEM_SKIPPED,
    ITEM_SUCCESS,
    OP_STATUS_EXECUTING,
    OP_STATUS_FAILED,
    OP_STATUS_INTERRUPTED,
    OP_STATUS_PARTIAL_FAILURE,
    OP_STATUS_PREFLIGHT,
    OP_STATUS_RESTORED,
    OP_STATUS_SUCCESS,
    OP_TYPE_ORGANIZE,
    OP_TYPE_ORGANIZE_ROLLBACK,
    PAIRING_CONFLICT,
    PAIRING_NORMAL,
    PAIRING_TRASHED,
    PREFLIGHT_ORGANIZE,
    PRESENCE_PRESENT,
    PREVIEW_PENDING,
    SUPPORTED_EXTENSIONS,
)
from .db import Database
from .errors import ApiError, ErrorCode
from .models import Album, Asset, Operation, OperationItem, PhotoGroup
from .natural import utcnow_iso
from .operations import (
    create_operation,
    find_by_idempotency_key,
    finish_operation,
    operation_items,
)
from .paths import PathGuard
from .preflight import consume_preflight, issue_preflight, load_preflight
from .scanning import ScanService, scan_album_with_session
from .serializers import operation_to_dict

ORGANIZE_DIRS = {"jpg": "JPG", "raw": "RAW"}


def can_restore_organize(operation: Operation, items: list[OperationItem]) -> bool:
    if operation.type != OP_TYPE_ORGANIZE:
        return False
    if operation.restored_at is not None:
        return False
    if operation.status not in {OP_STATUS_SUCCESS, OP_STATUS_PARTIAL_FAILURE, OP_STATUS_INTERRUPTED}:
        return False
    return any(item.result == ITEM_SUCCESS and item.destination_path_snapshot for item in items)


def _relative_path(path: Path, base: Path) -> str:
    try:
        return path.relative_to(base).as_posix()
    except ValueError:
        return path.as_posix()


def _signature(path: Path) -> tuple[int, int]:
    stat = path.stat()
    return stat.st_size, stat.st_mtime_ns


def _move_no_overwrite(source: Path, destination: Path) -> None:
    """把 source 移动到 destination，绝不覆盖已有目标。

    优先使用 hard link + unlink：link 在目标存在时会原子失败。少数不支持
    hard link 的外接盘回退到 rename，但 rename 前仍做一次存在性检查。
    """

    if destination.exists() or destination.is_symlink():
        raise FileExistsError(f"目标已存在：{destination}")
    try:
        os.link(source, destination, follow_symlinks=False)
    except OSError as exc:
        if exc.errno not in {errno.EXDEV, errno.EPERM, errno.ENOTSUP, errno.EOPNOTSUPP}:
            raise
        if destination.exists() or destination.is_symlink():
            raise FileExistsError(f"目标已存在：{destination}") from exc
        os.rename(source, destination)
        return
    try:
        os.unlink(source)
    except BaseException:
        try:
            os.unlink(destination)
        except OSError:
            pass
        raise


def _group_index_map(groups: list[PhotoGroup]) -> dict[str, int]:
    return {group.id: index for index, group in enumerate(groups)}


def _normalized_target_key(relative_path: str) -> str:
    # macOS 默认不区分大小写；用 casefold 防止只差大小写的两个目标互相覆盖。
    return relative_path.casefold()


class OrganizeService:
    def __init__(
        self,
        settings: Settings,
        database: Database,
        guard: PathGuard,
        scan_service: ScanService,
        events=None,  # noqa: ANN001
    ) -> None:
        self.settings = settings
        self.database = database
        self.guard = guard
        self.scan_service = scan_service
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
            with self.scan_service.album_lock(album_id):
                outcome = scan_album_with_session(
                    session,
                    album,
                    settings=self.settings,
                    guard=self.guard,
                    trigger="organize_preflight",
                    record_operation=True,
                    exiftool_path=self.settings.exiftool_path,
                )
                if outcome.error:
                    raise ApiError(
                        ErrorCode.SOURCE_CHANGED,
                        "整理前重新扫描相册失败，请检查目录权限后重试。",
                        status_code=409,
                        details={"reason": outcome.error[:500]},
                    )
                return self._build_preflight(session, album)
        finally:
            session.close()

    def _build_preflight(self, session: Session, album: Album) -> dict[str, Any]:
        album_dir = self.guard.album_dir(album.relative_path, must_exist=True)
        existing_dirs = {
            "JPG": (album_dir / "JPG").is_dir() and not (album_dir / "JPG").is_symlink(),
            "RAW": (album_dir / "RAW").is_dir() and not (album_dir / "RAW").is_symlink(),
        }
        groups = list(
            session.scalars(
                select(PhotoGroup)
                .where(PhotoGroup.album_id == album.id, PhotoGroup.deleted_at.is_(None))
                .order_by(PhotoGroup.sort_key.asc(), PhotoGroup.id.asc())
            )
        )
        all_assets = list(session.scalars(select(Asset).where(Asset.photo_group_id.in_([g.id for g in groups]))))
        db_paths = {asset.relative_path.casefold(): asset for asset in all_assets}
        blockers: list[dict[str, Any]] = []
        entries: list[dict[str, Any]] = []
        target_keys: dict[str, str] = {}
        groups_with_items: set[str] = set()
        group_indexes = _group_index_map(groups)

        for group in groups:
            present_assets = [asset for asset in group.assets if asset.presence_status == PRESENCE_PRESENT]
            if not present_assets:
                continue
            if group.pairing_status == PAIRING_TRASHED:
                continue
            if group.pairing_status == PAIRING_CONFLICT:
                blockers.append(
                    {
                        "code": ErrorCode.PAIRING_CONFLICT,
                        "message": "存在配对冲突，整批整理已禁止。请先在异常中心整理同名文件。",
                        "groupId": group.id,
                        "displayName": group.display_name,
                    }
                )
                continue
            if group.pairing_status != PAIRING_NORMAL:
                blockers.append(
                    {
                        "code": ErrorCode.ASSET_MISSING,
                        "message": "逻辑照片存在缺失文件，整批整理已禁止。",
                        "groupId": group.id,
                        "displayName": group.display_name,
                    }
                )
                continue

            for asset in sorted(present_assets, key=lambda a: (0 if a.kind == "jpg" else 1, a.relative_path)):
                kind_dir = ORGANIZE_DIRS.get(asset.kind)
                filename = asset.original_filename
                if kind_dir is None or asset.extension.lower() not in SUPPORTED_EXTENSIONS:
                    blockers.append(
                        {
                            "code": ErrorCode.UNSUPPORTED_FILE_TYPE,
                            "message": "文件类型不受支持，整批整理已禁止。",
                            "groupId": group.id,
                            "displayName": group.display_name,
                            "relativePath": asset.relative_path,
                        }
                    )
                    continue
                try:
                    if not filename or "/" in filename or "\\" in filename or filename in {".", ".."}:
                        raise ApiError(ErrorCode.PATH_OUTSIDE_ROOT, "文件名非法。", status_code=400)
                    source = self.guard.asset_path(album.relative_path, asset.relative_path, must_exist=True)
                    target = self.guard.organize_file_path(
                        album.relative_path, kind_dir, filename, must_exist=False
                    )
                    size, mtime = _signature(source)
                except ApiError as exc:
                    blockers.append(
                        {
                            "code": exc.code,
                            "message": exc.message,
                            "groupId": group.id,
                            "displayName": group.display_name,
                            "relativePath": asset.relative_path,
                        }
                    )
                    continue
                except OSError as exc:
                    blockers.append(
                        {
                            "code": ErrorCode.ASSET_MISSING,
                            "message": f"文件状态读取失败：{exc}",
                            "groupId": group.id,
                            "displayName": group.display_name,
                            "relativePath": asset.relative_path,
                        }
                    )
                    continue
                if size != asset.size_bytes or mtime != asset.mtime_ns:
                    blockers.append(
                        {
                            "code": ErrorCode.SOURCE_CHANGED,
                            "message": "文件大小或修改时间与数据库不一致，请重新扫描后再整理。",
                            "groupId": group.id,
                            "displayName": group.display_name,
                            "relativePath": asset.relative_path,
                        }
                    )
                    continue

                target_rel = f"{kind_dir}/{filename}"
                is_already_there = asset.relative_path == target_rel
                if not is_already_there and (target.exists() or target.is_symlink()):
                    try:
                        is_already_there = target.is_file() and os.path.samefile(source, target)
                    except OSError:
                        is_already_there = False
                    if not is_already_there:
                        blockers.append(
                            {
                                "code": ErrorCode.DESTINATION_CONFLICT,
                                "message": f"目标文件已存在：{target_rel}。不会覆盖，请先处理。",
                                "groupId": group.id,
                                "displayName": group.display_name,
                                "relativePath": asset.relative_path,
                                "destinationRelativePath": target_rel,
                            }
                        )
                        continue
                if target.is_symlink() or (target.exists() and not target.is_file()):
                    blockers.append(
                        {
                            "code": ErrorCode.DESTINATION_CONFLICT,
                            "message": "目标位置不是普通文件，整批整理已禁止。",
                            "groupId": group.id,
                            "displayName": group.display_name,
                            "relativePath": asset.relative_path,
                        }
                    )
                    continue

                other = db_paths.get(target_rel.casefold())
                if other is not None and other.id != asset.id:
                    blockers.append(
                        {
                            "code": ErrorCode.DESTINATION_CONFLICT,
                            "message": f"数据库中已有目标路径：{target_rel}，整批整理已禁止。",
                            "groupId": group.id,
                            "displayName": group.display_name,
                            "relativePath": asset.relative_path,
                            "destinationRelativePath": target_rel,
                        }
                    )
                    continue
                previous = target_keys.get(_normalized_target_key(target_rel))
                if previous is not None and previous != asset.id:
                    blockers.append(
                        {
                            "code": ErrorCode.DESTINATION_CONFLICT,
                            "message": f"多个文件会落到同一目标：{target_rel}，整批整理已禁止。",
                            "groupId": group.id,
                            "displayName": group.display_name,
                            "relativePath": asset.relative_path,
                            "destinationRelativePath": target_rel,
                        }
                    )
                    continue
                target_keys[_normalized_target_key(target_rel)] = asset.id
                action = "skip" if is_already_there else "move"
                entries.append(
                    {
                        "assetId": asset.id,
                        "groupId": group.id,
                        "displayName": group.display_name,
                        "kind": asset.kind,
                        "extension": asset.extension,
                        "originalFilename": filename,
                        "sourceRelativePath": asset.relative_path,
                        "destinationRelativePath": target_rel,
                        "destinationAbsolutePath": str(target),
                        "sourceSizeBytes": size,
                        "sourceMtimeNs": mtime,
                        "action": action,
                        "groupIndex": group_indexes.get(group.id, 0),
                    }
                )
                groups_with_items.add(group.id)

        moves = [entry for entry in entries if entry["action"] == "move"]
        skips = [entry for entry in entries if entry["action"] == "skip"]
        summary = {
            "photoCount": len(groups_with_items),
            "fileCount": len(entries),
            "moveCount": len(moves),
            "skipCount": len(skips),
            "jpgCount": sum(1 for entry in moves if entry["kind"] == "jpg"),
            "rawCount": sum(1 for entry in moves if entry["kind"] == "raw"),
            "totalBytes": sum(entry["sourceSizeBytes"] for entry in moves),
        }
        if blockers:
            return {
                "albumId": album.id,
                "albumName": album.name,
                "token": None,
                "expiresAt": None,
                "operationId": None,
                "summary": summary,
                "blocked": True,
                "blockers": blockers,
                "entries": entries,
                "message": "存在阻止项，整批整理未执行。请先处理冲突或缺失文件，然后重新预检。",
            }
        if not moves:
            return {
                "albumId": album.id,
                "albumName": album.name,
                "token": None,
                "expiresAt": None,
                "operationId": None,
                "summary": summary,
                "blocked": False,
                "blockers": [],
                "entries": entries,
                "message": "相册已经按 JPG/RAW 整理好，无需移动文件。",
            }

        operation = create_operation(
            session,
            album_id=album.id,
            type=OP_TYPE_ORGANIZE,
            status=OP_STATUS_PREFLIGHT,
            requested_photo_count=summary["photoCount"],
            requested_file_count=summary["fileCount"],
            request_snapshot={
                "entries": entries,
                "blockers": blockers,
                "summary": summary,
                "existingDirs": existing_dirs,
            },
        )
        for entry in entries:
            session.add(
                OperationItem(
                    operation_id=operation.id,
                    photo_group_id=entry["groupId"],
                    asset_id=entry["assetId"],
                    display_name=entry["displayName"],
                    source_relative_path=entry["sourceRelativePath"],
                    destination_path_snapshot=entry["destinationAbsolutePath"],
                    source_size_bytes=entry["sourceSizeBytes"],
                    source_mtime_ns=entry["sourceMtimeNs"],
                    result=ITEM_PENDING,
                    group_index=entry["groupIndex"],
                )
            )
        session.commit()
        raw_token, expires_at = issue_preflight(
            session,
            album_id=album.id,
            kind=PREFLIGHT_ORGANIZE,
            operation_id=operation.id,
            payload={"entries": entries, "blockers": blockers, "summary": summary},
            ttl_seconds=self.settings.preflight_ttl_seconds,
        )
        return {
            "albumId": album.id,
            "albumName": album.name,
            "token": raw_token,
            "expiresAt": expires_at,
            "operationId": operation.id,
            "summary": summary,
            "blocked": False,
            "blockers": [],
            "entries": entries,
            "message": (
                f"将把 {len(moves)} 个文件原地移动到相册内的 JPG/RAW 子目录；"
                f"其中 {len(skips)} 个已经在正确位置。原文件不会被删除。"
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
        album: Album | None = None
        try:
            album = session.get(Album, album_id)
            if album is None or album.deleted_at is not None:
                raise ApiError(ErrorCode.ALBUM_NOT_FOUND, "相册不存在。", status_code=404)
            existing = find_by_idempotency_key(session, idempotency_key)
            if existing is not None:
                if existing.album_id != album_id or existing.type != OP_TYPE_ORGANIZE:
                    raise ApiError(ErrorCode.INVALID_REQUEST, "该幂等键已被其他操作使用，请重新发起。", status_code=409)
                return self._replay(session, existing)

            token_row = load_preflight(session, raw_token=token, kind=PREFLIGHT_ORGANIZE, album_id=album_id)
            payload = json.loads(token_row.payload_json)
            if payload.get("blockers"):
                raise ApiError(
                    ErrorCode.PREFLIGHT_BLOCKED,
                    "预检存在阻止项，整批整理已禁止。请处理异常后重新预检。",
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
                    .values(status=OP_STATUS_EXECUTING, idempotency_key=idempotency_key, started_at=utcnow_iso())
                )
                if claimed.rowcount != 1:
                    session.rollback()
                    existing = find_by_idempotency_key(session, idempotency_key)
                    if existing is not None:
                        if existing.album_id != album_id or existing.type != OP_TYPE_ORGANIZE:
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
                    if existing.album_id != album_id or existing.type != OP_TYPE_ORGANIZE:
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
            with self.scan_service.album_lock(album_id):
                verification = self._verify_plan(session, album, payload)
                if verification:
                    self._fail_verification(session, operation, verification)
                    raise ApiError(
                        ErrorCode.SOURCE_CHANGED,
                        "预检后文件或目录状态发生变化，整批整理未执行。请重新预检。",
                        status_code=409,
                        details={"operationId": operation.id, "reasons": verification},
                    )
                result = self._execute_plan(session, album, operation, payload)
        finally:
            session.close()
        if result is not None:
            self._publish(album_id, "organize_finished", {"operationId": result["operation"]["id"]})
            return result
        raise ApiError(ErrorCode.INTERNAL_ERROR, "整理未完成。", status_code=500)

    def _verify_plan(self, session: Session, album: Album, payload: dict[str, Any]) -> list[dict[str, Any]]:
        reasons: list[dict[str, Any]] = []
        entries = payload.get("entries", [])
        for entry in entries:
            asset = session.get(Asset, entry["assetId"])
            group = session.get(PhotoGroup, entry["groupId"])
            if asset is None or group is None or asset.photo_group_id != group.id:
                reasons.append({"code": ErrorCode.SOURCE_CHANGED, "message": "文件或逻辑照片记录已不存在。"})
                continue
            if group.pairing_status not in {PAIRING_NORMAL, PAIRING_TRASHED}:
                reasons.append(
                    {
                        "code": ErrorCode.PAIRING_CONFLICT,
                        "message": "配对状态已变化，整批整理已取消。",
                        "groupId": group.id,
                        "displayName": group.display_name,
                    }
                )
                continue
            if asset.relative_path != entry["sourceRelativePath"]:
                reasons.append(
                    {
                        "code": ErrorCode.SOURCE_CHANGED,
                        "message": "文件路径已在预检后变化，整批整理已取消。",
                        "relativePath": asset.relative_path,
                    }
                )
                continue
            try:
                source = self.guard.asset_path(album.relative_path, entry["sourceRelativePath"], must_exist=True)
                size, mtime = _signature(source)
            except (ApiError, OSError) as exc:
                reasons.append({"code": ErrorCode.ASSET_MISSING, "message": f"源文件不可访问：{exc}"})
                continue
            if size != entry["sourceSizeBytes"] or mtime != entry["sourceMtimeNs"]:
                reasons.append({"code": ErrorCode.SOURCE_CHANGED, "message": "源文件大小或修改时间已变化。"})
                continue
            try:
                target = self.guard.organize_file_path(
                    album.relative_path, ORGANIZE_DIRS[entry["kind"]], entry["originalFilename"], must_exist=False
                )
            except ApiError as exc:
                reasons.append({"code": exc.code, "message": exc.message})
                continue
            if entry["action"] == "move":
                if target.exists() or target.is_symlink():
                    reasons.append(
                        {
                            "code": ErrorCode.DESTINATION_CONFLICT,
                            "message": f"目标文件已出现：{entry['destinationRelativePath']}，未覆盖。",
                        }
                    )
            elif not target.exists() or not source.samefile(target):
                reasons.append(
                    {"code": ErrorCode.SOURCE_CHANGED, "message": "已整理文件的位置发生变化。"}
                )
        return reasons

    def _execute_plan(
        self, session: Session, album: Album, operation: Operation, payload: dict[str, Any]
    ) -> dict[str, Any]:
        entries = payload["entries"]
        items = operation_items(session, operation.id)
        item_by_asset = {item.asset_id: item for item in items}
        moves = [entry for entry in entries if entry["action"] == "move"]
        skips = [entry for entry in entries if entry["action"] == "skip"]
        total_moves = len(moves)
        created_dirs: list[Path] = []
        moved: list[tuple[OperationItem, Asset, Path, Path]] = []
        success = 0

        try:
            album_dir = self.guard.album_dir(album.relative_path, must_exist=True)
            for kind_dir in ("JPG", "RAW"):
                directory = album_dir / kind_dir
                if directory.exists():
                    if directory.is_symlink() or not directory.is_dir():
                        raise ApiError(
                            ErrorCode.DESTINATION_CONFLICT,
                            f"{kind_dir} 已存在但不是普通文件夹。",
                            status_code=409,
                        )
                else:
                    directory.mkdir()
                    created_dirs.append(directory)
                self.guard.ensure_still_inside(directory, base=album_dir)

            for entry in skips:
                item = item_by_asset.get(entry["assetId"])
                if item is not None:
                    item.result = ITEM_SKIPPED
                    item.destination_path_snapshot = entry["destinationAbsolutePath"]
                    session.commit()
        except (ApiError, OSError) as exc:
            self._cleanup_empty_dirs(created_dirs)
            self._fail_all(session, operation, exc_message=f"无法准备 JPG/RAW 目录：{exc}")
            return self._result(session, album, operation, error_summary=f"无法准备 JPG/RAW 目录：{exc}")

        for index, entry in enumerate(moves):
            item = item_by_asset.get(entry["assetId"])
            asset = session.get(Asset, entry["assetId"])
            if item is None or asset is None:
                continue
            source_path = self.guard.asset_path(album.relative_path, entry["sourceRelativePath"], must_exist=True)
            target_path = self.guard.organize_file_path(
                album.relative_path, ORGANIZE_DIRS[entry["kind"]], entry["originalFilename"], must_exist=False
            )
            try:
                _move_no_overwrite(source_path, target_path)
                asset.relative_path = entry["destinationRelativePath"]
                asset.preview_status = PREVIEW_PENDING
                asset.preview_error = None
                item.result = ITEM_SUCCESS
                item.destination_path_snapshot = str(target_path)
                item.error_code = None
                item.error_message = None
                session.commit()
                moved.append((item, asset, source_path, target_path))
                success += 1
            except (OSError, ApiError) as exc:
                session.rollback()
                code = ErrorCode.DESTINATION_CONFLICT if isinstance(exc, FileExistsError) else ErrorCode.SOURCE_CHANGED
                message = str(exc) or "文件移动失败。"
                item = item_by_asset.get(entry["assetId"])
                if item is not None:
                    item.result = ITEM_FAILED
                    item.error_code = code
                    item.error_message = message[:2000]
                    session.commit()
                rollback_failed = False
                for moved_item, moved_asset, moved_source, moved_target in reversed(moved):
                    try:
                        _move_no_overwrite(moved_target, moved_source)
                        moved_asset.relative_path = _relative_path(moved_source, album_dir)
                        moved_asset.preview_status = PREVIEW_PENDING
                        moved_item.result = ITEM_RESTORED
                        moved_item.destination_path_snapshot = None
                        moved_item.error_code = ErrorCode.SOURCE_CHANGED
                        moved_item.error_message = "同批文件移动失败，该文件已回滚。"
                        session.commit()
                    except (OSError, ApiError) as rollback_exc:
                        rollback_failed = True
                        moved_item.result = ITEM_FAILED
                        moved_item.error_code = ErrorCode.ROLLBACK_FAILED
                        moved_item.error_message = f"回滚失败：{rollback_exc}；文件实际位置：{moved_target}"[:2000]
                        session.commit()
                for remaining in moves[index + 1 :]:
                    remaining_item = item_by_asset.get(remaining["assetId"])
                    if remaining_item is not None:
                        remaining_item.result = ITEM_FAILED
                        remaining_item.error_code = code
                        remaining_item.error_message = "同批文件移动失败，该文件未执行。"
                session.commit()
                self._cleanup_empty_dirs(created_dirs)
                finish_operation(
                    session,
                    operation,
                    status=OP_STATUS_PARTIAL_FAILURE if rollback_failed else OP_STATUS_FAILED,
                    success=0,
                    skipped=len(skips),
                    failed=total_moves,
                    error_summary=(
                        f"整理失败，已回滚已移动文件。{message}"
                        if not rollback_failed
                        else f"整理失败，且存在无法回滚的文件，请立即核对操作记录。{message}"
                    )[:2000],
                )
                return self._result(session, album, operation, error_summary=operation.error_summary)
        finish_operation(
            session,
            operation,
            status=OP_STATUS_SUCCESS,
            success=success,
            skipped=len(skips),
            failed=0,
            error_summary=None,
        )
        session.refresh(operation)
        return self._result(session, album, operation)

    def _fail_all(self, session: Session, operation: Operation, *, exc_message: str) -> None:
        for item in operation_items(session, operation.id):
            item.result = ITEM_FAILED
            item.error_code = ErrorCode.DESTINATION_CONFLICT
            item.error_message = exc_message[:2000]
        finish_operation(
            session,
            operation,
            status=OP_STATUS_FAILED,
            failed=operation.requested_file_count,
            error_summary=exc_message[:2000],
        )

    def _fail_verification(
        self, session: Session, operation: Operation, reasons: list[dict[str, Any]]
    ) -> None:
        for item in operation_items(session, operation.id):
            item.result = ITEM_FAILED
            item.error_code = ErrorCode.SOURCE_CHANGED
            item.error_message = "预检后文件或目录状态发生变化，整批未执行。"
        finish_operation(
            session,
            operation,
            status=OP_STATUS_FAILED,
            failed=operation.requested_file_count,
            error_summary="预检后文件或目录状态发生变化，整批整理未执行。请重新预检。",
        )

    @staticmethod
    def _cleanup_empty_dirs(dirs: list[Path]) -> None:
        for directory in reversed(dirs):
            try:
                directory.rmdir()
            except OSError:
                pass

    def _result(
        self,
        session: Session,
        album: Album,
        operation: Operation,
        *,
        error_summary: str | None = None,
    ) -> dict[str, Any]:
        session.refresh(operation)
        items = operation_items(session, operation.id)
        return {
            "operation": operation_to_dict(
                operation,
                album_name=album.name,
                items=items,
                can_restore=can_restore_organize(operation, items),
            ),
            "summary": json.loads(operation.request_snapshot_json or "{}").get("summary"),
            "blockers": [],
            "idempotentReplay": False,
        }

    # ------------------------------------------------------------------
    # 回滚
    # ------------------------------------------------------------------
    def rollback(self, operation_id: str) -> dict[str, Any]:
        session = self.database.session()
        result: dict[str, Any] | None = None
        album: Album | None = None
        try:
            original = session.get(Operation, operation_id)
            if original is None or original.type != OP_TYPE_ORGANIZE:
                raise ApiError(ErrorCode.OPERATION_NOT_FOUND, "整理操作不存在。", status_code=404)
            album = session.get(Album, original.album_id) if original.album_id else None
            if album is None:
                raise ApiError(ErrorCode.ALBUM_NOT_FOUND, "所属相册已不存在，无法回滚。", status_code=404)
            if original.restored_at is not None:
                return self._already_restored(session, original)
            original_items = operation_items(session, original.id)
            restorable = [
                item
                for item in original_items
                if item.result == ITEM_SUCCESS and item.destination_path_snapshot and item.asset_id
            ]
            if not restorable:
                raise ApiError(ErrorCode.RESTORE_FAILED, "该整理操作没有可回滚的文件。", status_code=400)
            if original.restore_operation_id:
                running = session.get(Operation, original.restore_operation_id)
                if running is not None and running.status == OP_STATUS_EXECUTING:
                    raise ApiError(ErrorCode.PREFLIGHT_CONSUMED, "回滚正在进行中。", status_code=409)

            with self.scan_service.album_lock(album.id):
                session.refresh(original)
                if original.restored_at is not None:
                    return self._already_restored(session, original)
                rollback_operation = create_operation(
                    session,
                    album_id=album.id,
                    type=OP_TYPE_ORGANIZE_ROLLBACK,
                    status=OP_STATUS_EXECUTING,
                    parent_operation_id=original.id,
                    requested_photo_count=original.requested_photo_count,
                    requested_file_count=len(restorable),
                    request_snapshot={"organizeOperationId": original.id},
                )
                rollback_operation.started_at = utcnow_iso()
                original.restore_operation_id = rollback_operation.id
                session.commit()

                prepared: list[tuple[OperationItem, OperationItem, Asset, Path, Path]] = []
                conflicts: list[dict[str, Any]] = []
                album_dir = self.guard.album_dir(album.relative_path, must_exist=True)
                for original_item in restorable:
                    asset = session.get(Asset, original_item.asset_id) if original_item.asset_id else None
                    destination = Path(original_item.destination_path_snapshot or "")
                    source = self.guard.asset_path(
                        album.relative_path, original_item.source_relative_path, must_exist=False
                    )
                    try:
                        self.guard.ensure_still_inside(destination, base=album_dir)
                    except ApiError:
                        destination = Path("/__invalid_organize_destination__")
                    rollback_item = OperationItem(
                        operation_id=rollback_operation.id,
                        photo_group_id=original_item.photo_group_id,
                        asset_id=original_item.asset_id,
                        display_name=original_item.display_name,
                        source_relative_path=original_item.source_relative_path,
                        destination_path_snapshot=str(destination),
                        source_size_bytes=original_item.source_size_bytes,
                        source_mtime_ns=original_item.source_mtime_ns,
                        group_index=original_item.group_index,
                    )
                    session.add(rollback_item)
                    session.flush()
                    reason: str | None = None
                    if asset is None:
                        reason = "文件记录已不存在。"
                    elif not destination.is_file() or destination.is_symlink():
                        reason = "整理后的文件已不在目标位置。"
                    elif asset.relative_path not in {
                        _relative_path(destination, album_dir),
                        original_item.source_relative_path,
                    }:
                        reason = "数据库中的文件路径与操作记录不一致。"
                    elif source.exists() or source.is_symlink():
                        reason = "整理前的原路径已有新文件，未覆盖。"
                    else:
                        try:
                            size, mtime = _signature(destination)
                            if (
                                original_item.source_size_bytes is not None
                                and size != original_item.source_size_bytes
                            ) or (
                                original_item.source_mtime_ns is not None
                                and mtime != original_item.source_mtime_ns
                            ):
                                reason = "文件大小或修改时间在整理后发生变化。"
                        except OSError as exc:
                            reason = f"无法读取文件：{exc}"
                    if reason:
                        rollback_item.result = ITEM_CONFLICT
                        rollback_item.error_code = ErrorCode.DESTINATION_CONFLICT
                        rollback_item.error_message = reason
                        conflicts.append(
                            {
                                "assetId": original_item.asset_id,
                                "message": reason,
                                "sourceRelativePath": original_item.source_relative_path,
                            }
                        )
                    else:
                        prepared.append((rollback_item, original_item, asset, destination, source))
                session.commit()

                success = 0
                failed = 0
                conflict_count = len(conflicts)
                for rollback_item, original_item, asset, destination, source in prepared:
                    try:
                        _move_no_overwrite(destination, source)
                        asset.relative_path = original_item.source_relative_path
                        asset.preview_status = PREVIEW_PENDING
                        asset.preview_error = None
                        rollback_item.result = ITEM_RESTORED
                        original_item.result = ITEM_RESTORED
                        session.commit()
                        success += 1
                    except (OSError, ApiError) as exc:
                        rollback_item.result = ITEM_FAILED
                        rollback_item.error_code = ErrorCode.RESTORE_FAILED
                        rollback_item.error_message = str(exc)[:2000]
                        failed += 1
                        session.commit()

                total = len(restorable)
                if success == total:
                    # 如果 JPG/RAW 是本次整理新建的，撤销后删除空目录，尽量恢复原结构。
                    snapshot = json.loads(original.request_snapshot_json or "{}")
                    existing_dirs = snapshot.get("existingDirs", {}) if isinstance(snapshot, dict) else {}
                    for kind_dir in ("JPG", "RAW"):
                        if existing_dirs.get(kind_dir):
                            continue
                        directory = album_dir / kind_dir
                        try:
                            directory.rmdir()
                        except OSError:
                            pass
                    original.status = OP_STATUS_RESTORED
                    original.restored_at = utcnow_iso()
                    original.error_summary = "已撤销整理，文件已移回整理前位置。"
                    rollback_status = OP_STATUS_SUCCESS
                else:
                    rollback_status = OP_STATUS_PARTIAL_FAILURE if success else OP_STATUS_FAILED
                    original.error_summary = (
                        f"撤销整理未全部完成：成功 {success}，失败 {failed}，冲突 {conflict_count}。"
                    )
                session.commit()
                finish_operation(
                    session,
                    rollback_operation,
                    status=rollback_status,
                    success=success,
                    failed=failed,
                    conflicts=conflict_count,
                    error_summary=original.error_summary,
                )
                session.refresh(original)
                session.refresh(rollback_operation)
                result = {
                    "operation": operation_to_dict(
                        rollback_operation,
                        album_name=album.name,
                        items=operation_items(session, rollback_operation.id),
                        can_restore=False,
                    ),
                    "originalOperation": operation_to_dict(
                        original,
                        album_name=album.name,
                        items=operation_items(session, original.id),
                        can_restore=can_restore_organize(original, operation_items(session, original.id)),
                    ),
                    "alreadyRestored": False,
                }
        finally:
            session.close()
        if result is not None:
            self._publish(album.id, "organize_rollback_finished", {"operationId": operation_id})
            return result
        raise ApiError(ErrorCode.INTERNAL_ERROR, "撤销整理未完成。", status_code=500)

    def _already_restored(self, session: Session, original: Operation) -> dict[str, Any]:
        album = session.get(Album, original.album_id) if original.album_id else None
        rollback_operation = (
            session.get(Operation, original.restore_operation_id) if original.restore_operation_id else None
        )
        return {
            "operation": operation_to_dict(
                rollback_operation,
                album_name=album.name if album else None,
                items=operation_items(session, rollback_operation.id) if rollback_operation else [],
                can_restore=False,
            )
            if rollback_operation
            else None,
            "originalOperation": operation_to_dict(
                original,
                album_name=album.name if album else None,
                items=operation_items(session, original.id),
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
                can_restore=can_restore_organize(operation, items),
            ),
            "summary": json.loads(operation.request_snapshot_json or "{}").get("summary"),
            "blockers": [],
            "idempotentReplay": True,
        }

    def _publish(self, album_id: str, event_type: str, payload: dict[str, Any]) -> None:
        if self.events is not None:
            self.events.publish(album_id, event_type, payload)
