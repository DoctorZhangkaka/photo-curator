"""逻辑照片：列表、详情、状态更新。"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy import update
from sqlalchemy.orm import Session, selectinload

from ..constants import PAIRING_TRASHED, SELECTION_STATUSES, VIEWED_STATUSES
from ..errors import ApiError, ErrorCode
from ..models import PhotoGroup
from ..natural import utcnow_iso
from ..photo_queries import export_conflict_paths, list_photos
from ..schemas import PhotoStatePatch
from ..serializers import photo_to_dict
from .deps import get_session, require_album

router = APIRouter(prefix="/api", tags=["photos"])


@router.get("/albums/{album_id}/photos")
def photos_list(
    album_id: str,
    viewed: str = Query("all"),
    selection: str = Query("all"),
    form: str = Query("all"),
    issue: str = Query("all"),
    sort: str = Query("capture"),
    cursor: str | None = Query(None),
    limit: int = Query(200, ge=1, le=500),
    session: Session = Depends(get_session),
) -> dict:
    album = require_album(session, album_id)
    return list_photos(
        session,
        album_id=album.id,
        album_name=album.name,
        viewed=viewed,
        selection=selection,
        form=form,
        issue=issue,
        sort=sort,
        cursor=cursor,
        limit=limit,
    )


@router.get("/photos/{photo_id}")
def photo_detail(photo_id: str, session: Session = Depends(get_session)) -> dict:
    group = session.scalars(select_photo_with_assets(photo_id)).first()
    if group is None or group.deleted_at is not None or group.pairing_status == PAIRING_TRASHED:
        raise ApiError(ErrorCode.PHOTO_NOT_FOUND, "逻辑照片不存在或已清理。", status_code=404)
    from ..models import Album

    album = session.get(Album, group.album_id)
    conflict_paths = export_conflict_paths(session, group.album_id)
    return {
        "photo": photo_to_dict(
            group,
            export_conflict_paths=conflict_paths,
            include_exif=True,
            album_name=album.name if album else None,
        )
    }


def select_photo_with_assets(photo_id: str):
    from sqlalchemy import select

    return select(PhotoGroup).options(selectinload(PhotoGroup.assets)).where(PhotoGroup.id == photo_id)


@router.patch("/photos/{photo_id}/state")
def update_photo_state(
    photo_id: str,
    payload: PhotoStatePatch,
    session: Session = Depends(get_session),
) -> dict:
    if payload.viewedStatus is None and payload.selectionStatus is None:
        raise ApiError(ErrorCode.INVALID_REQUEST, "至少需要提供一个状态字段。", status_code=400)
    if payload.viewedStatus is not None and payload.viewedStatus not in VIEWED_STATUSES:
        raise ApiError(ErrorCode.INVALID_REQUEST, "浏览状态无效。", status_code=400)
    if payload.selectionStatus is not None and payload.selectionStatus not in SELECTION_STATUSES:
        raise ApiError(ErrorCode.INVALID_REQUEST, "筛选状态无效。", status_code=400)

    group = session.get(PhotoGroup, photo_id)
    if group is None or group.deleted_at is not None or group.pairing_status == PAIRING_TRASHED:
        raise ApiError(ErrorCode.PHOTO_NOT_FOUND, "逻辑照片不存在或已清理。", status_code=404)

    changes: dict = {"version": payload.version + 1, "updated_at": utcnow_iso()}
    if payload.viewedStatus is not None:
        changes["viewed_status"] = payload.viewedStatus
    if payload.selectionStatus is not None:
        changes["selection_status"] = payload.selectionStatus

    result = session.execute(
        update(PhotoGroup).where(PhotoGroup.id == photo_id, PhotoGroup.version == payload.version).values(**changes)
    )
    if result.rowcount != 1:
        session.rollback()
        latest = session.get(PhotoGroup, photo_id)
        if latest is None:
            raise ApiError(ErrorCode.PHOTO_NOT_FOUND, "逻辑照片不存在。", status_code=404)
        raise ApiError(
            ErrorCode.STALE_VERSION,
            "照片状态已在其他窗口更新，请刷新后重试。",
            status_code=409,
            details={"currentVersion": latest.version},
        )
    session.commit()

    group = session.scalars(select_photo_with_assets(photo_id)).first()
    assert group is not None
    from ..models import Album

    album = session.get(Album, group.album_id)
    conflict_paths = export_conflict_paths(session, group.album_id)
    return {
        "photo": photo_to_dict(
            group,
            export_conflict_paths=conflict_paths,
            include_exif=True,
            album_name=album.name if album else None,
        )
    }
