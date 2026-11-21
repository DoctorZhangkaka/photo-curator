"""清理、导出、操作记录、异常中心、设置与任务路由。"""

from __future__ import annotations

import subprocess
import sys
from datetime import datetime

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..constants import OP_STATUSES, OP_TYPES
from ..context import AppContext
from ..errors import ApiError, ErrorCode
from ..issues import list_issues
from ..models import Album, Asset, Operation, PhotoGroup, Setting
from ..natural import utcnow_iso
from ..operations import operation_items
from ..schemas import PreflightExecuteRequest, SettingsPatch
from ..serializers import operation_to_dict
from .deps import get_context, get_session, require_album

router = APIRouter(prefix="/api", tags=["operations"])


# ---------------------------------------------------------------------------
# 清理
# ---------------------------------------------------------------------------
@router.post("/albums/{album_id}/cleanup/preflight")
def cleanup_preflight(
    album_id: str,
    context: AppContext = Depends(get_context),
    session: Session = Depends(get_session),
) -> dict:
    require_album(session, album_id)
    return context.cleanup.preflight(album_id)


@router.post("/albums/{album_id}/cleanup/execute")
def cleanup_execute(
    album_id: str,
    payload: PreflightExecuteRequest,
    context: AppContext = Depends(get_context),
    session: Session = Depends(get_session),
) -> dict:
    require_album(session, album_id)
    return context.cleanup.execute(album_id, token=payload.preflightToken, idempotency_key=payload.idempotencyKey)


# ---------------------------------------------------------------------------
# 导出
# ---------------------------------------------------------------------------
@router.post("/albums/{album_id}/exports/preflight")
def export_preflight(
    album_id: str,
    context: AppContext = Depends(get_context),
    session: Session = Depends(get_session),
) -> dict:
    require_album(session, album_id)
    return context.exports.preflight(album_id)


@router.post("/albums/{album_id}/exports", status_code=202)
def export_execute(
    album_id: str,
    payload: PreflightExecuteRequest,
    context: AppContext = Depends(get_context),
    session: Session = Depends(get_session),
) -> dict:
    require_album(session, album_id)
    return context.exports.execute(album_id, token=payload.preflightToken, idempotency_key=payload.idempotencyKey)


@router.get("/jobs/{job_id}")
def get_job(job_id: str, context: AppContext = Depends(get_context)) -> dict:
    job = context.jobs.get(job_id)
    if job is None:
        raise ApiError(ErrorCode.JOB_NOT_FOUND, "任务不存在或已结束。", status_code=404)
    return {"job": job.to_dict()}


# ---------------------------------------------------------------------------
# 操作记录
# ---------------------------------------------------------------------------
def _parse_time(value: str | None, field: str) -> str | None:
    if not value:
        return None
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ApiError(ErrorCode.INVALID_REQUEST, f"{field} 时间格式无效。", status_code=400) from exc
    return value


def _operation_album_names(session: Session, operations: list[Operation]) -> dict[str, str]:
    album_ids = {operation.album_id for operation in operations if operation.album_id}
    if not album_ids:
        return {}
    rows = session.execute(select(Album.id, Album.name).where(Album.id.in_(album_ids))).all()
    return {row[0]: row[1] for row in rows}


@router.get("/operations")
def list_operations(
    albumId: str | None = Query(None),
    type: str | None = Query(None),
    status: str | None = Query(None),
    from_: str | None = Query(None, alias="from"),
    to: str | None = Query(None),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0, le=100000),
    session: Session = Depends(get_session),
) -> dict:
    query = select(Operation)
    if albumId:
        query = query.where(Operation.album_id == albumId)
    if type:
        types = [part.strip() for part in type.split(",") if part.strip()]
        invalid = [part for part in types if part not in OP_TYPES]
        if invalid:
            raise ApiError(ErrorCode.INVALID_REQUEST, "操作类型过滤值无效。", status_code=400)
        query = query.where(Operation.type.in_(types))
    if status:
        statuses = [part.strip() for part in status.split(",") if part.strip()]
        invalid = [part for part in statuses if part not in OP_STATUSES]
        if invalid:
            raise ApiError(ErrorCode.INVALID_REQUEST, "操作状态过滤值无效。", status_code=400)
        query = query.where(Operation.status.in_(statuses))
    from_value = _parse_time(from_, "from")
    to_value = _parse_time(to, "to")
    if from_value:
        query = query.where(Operation.requested_at >= from_value)
    if to_value:
        query = query.where(Operation.requested_at <= to_value)

    total = session.scalar(select(func.count()).select_from(query.subquery()))
    query = query.order_by(Operation.requested_at.desc(), Operation.id.desc()).offset(offset).limit(limit)
    operations = list(session.scalars(query))
    names = _operation_album_names(session, operations)
    return {
        "items": [
            operation_to_dict(operation, album_name=names.get(operation.album_id or ""), include_items=False)
            for operation in operations
        ],
        "total": int(total or 0),
        "limit": limit,
        "offset": offset,
    }


@router.get("/operations/{operation_id}")
def operation_detail(operation_id: str, session: Session = Depends(get_session)) -> dict:
    operation = session.get(Operation, operation_id)
    if operation is None:
        raise ApiError(ErrorCode.OPERATION_NOT_FOUND, "操作记录不存在。", status_code=404)
    album = session.get(Album, operation.album_id) if operation.album_id else None
    items = operation_items(session, operation.id)
    from ..cleanup import can_restore_cleanup

    return {
        "operation": operation_to_dict(
            operation,
            album_name=album.name if album else None,
            items=items,
            can_restore=can_restore_cleanup(operation, items),
        )
    }


@router.post("/operations/{operation_id}/restore")
def restore_operation(
    operation_id: str,
    context: AppContext = Depends(get_context),
) -> dict:
    return context.cleanup.restore(operation_id)


# ---------------------------------------------------------------------------
# 异常中心
# ---------------------------------------------------------------------------
@router.get("/albums/{album_id}/issues")
def album_issues(
    album_id: str,
    session: Session = Depends(get_session),
) -> dict:
    album = require_album(session, album_id)
    return list_issues(session, album)


@router.post("/albums/{album_id}/issues/rescan")
def rescan_issues(
    album_id: str,
    context: AppContext = Depends(get_context),
    session: Session = Depends(get_session),
) -> dict:
    album = require_album(session, album_id)
    outcome = context.scan.scan_album(album.id, trigger="issues_rescan")
    if outcome is None:
        raise ApiError(ErrorCode.ALBUM_NOT_FOUND, "相册不存在。", status_code=404)
    session.expire_all()
    album = require_album(session, album_id)
    result = list_issues(session, album)
    result["report"] = outcome.report
    return result


@router.post("/assets/{asset_id}/reveal-in-finder")
def reveal_in_finder(
    asset_id: str,
    context: AppContext = Depends(get_context),
    session: Session = Depends(get_session),
) -> dict:
    asset = session.get(Asset, asset_id)
    if asset is None:
        raise ApiError(ErrorCode.ASSET_NOT_FOUND, "文件记录不存在。", status_code=404)
    group = session.get(PhotoGroup, asset.photo_group_id)
    if group is None:
        raise ApiError(ErrorCode.PHOTO_NOT_FOUND, "逻辑照片不存在。", status_code=404)
    album = session.get(Album, group.album_id)
    if album is None:
        raise ApiError(ErrorCode.ALBUM_NOT_FOUND, "相册不存在。", status_code=404)
    path = context.guard.asset_path(album.relative_path, asset.relative_path, must_exist=True)
    if sys.platform != "darwin":
        raise ApiError(ErrorCode.DEPENDENCY_UNAVAILABLE, "仅 macOS 支持在 Finder 中显示。", status_code=501)
    try:
        completed = subprocess.run(  # noqa: S603 - 参数数组，无 shell
            ["open", "-R", str(path)],
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise ApiError(ErrorCode.DEPENDENCY_UNAVAILABLE, f"无法调用 Finder：{exc}", status_code=500) from exc
    if completed.returncode != 0:
        raise ApiError(
            ErrorCode.DEPENDENCY_UNAVAILABLE,
            "Finder 未能打开该文件位置。",
            status_code=500,
            details={"stderr": completed.stderr[:500]},
        )
    return {"revealed": True, "relativePath": asset.relative_path}


# ---------------------------------------------------------------------------
# 设置
# ---------------------------------------------------------------------------
def _public_settings(session: Session) -> dict:
    values = {row.key: row.value for row in session.query(Setting).all()}
    return {
        "defaultSort": values.get("default_sort", "capture"),
        "autoplayInterval": int(values.get("autoplay_interval", "3") or 3),
        "cleanupNoticeSeen": values.get("cleanup_notice_seen", "0") == "1",
    }


@router.get("/settings")
def get_settings(session: Session = Depends(get_session)) -> dict:
    return {"settings": _public_settings(session)}


@router.patch("/settings")
def update_settings(payload: SettingsPatch, session: Session = Depends(get_session)) -> dict:
    updates: dict[str, str] = {}
    if payload.defaultSort is not None:
        updates["default_sort"] = payload.defaultSort
    if payload.autoplayInterval is not None:
        updates["autoplay_interval"] = str(payload.autoplayInterval)
    if payload.cleanupNoticeSeen is not None:
        updates["cleanup_notice_seen"] = "1" if payload.cleanupNoticeSeen else "0"
    for key, value in updates.items():
        row = session.get(Setting, key)
        if row is None:
            session.add(Setting(key=key, value=value, updated_at=utcnow_iso()))
        else:
            row.value = value
            row.updated_at = utcnow_iso()
    session.commit()
    return {"settings": _public_settings(session)}
