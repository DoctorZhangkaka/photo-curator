"""路由共享依赖。"""

from __future__ import annotations

from collections.abc import Iterator

from fastapi import Request
from sqlalchemy.orm import Session

from ..context import AppContext
from ..errors import ApiError, ErrorCode
from ..models import Album, PhotoGroup


def get_context(request: Request) -> AppContext:
    return request.app.state.context


def get_session(request: Request) -> Iterator[Session]:
    context: AppContext = request.app.state.context
    session = context.database.session()
    try:
        yield session
    finally:
        session.close()


def require_album(session: Session, album_id: str) -> Album:
    album = session.get(Album, album_id)
    if album is None or album.deleted_at is not None:
        raise ApiError(ErrorCode.ALBUM_NOT_FOUND, "相册不存在。", status_code=404)
    return album


def require_photo(session: Session, photo_id: str) -> PhotoGroup:
    from ..constants import PAIRING_TRASHED

    group = session.get(PhotoGroup, photo_id)
    if group is None or group.deleted_at is not None or group.pairing_status == PAIRING_TRASHED:
        raise ApiError(ErrorCode.PHOTO_NOT_FOUND, "逻辑照片不存在或已清理。", status_code=404)
    return group
