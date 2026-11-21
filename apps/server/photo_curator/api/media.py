"""媒体端点：缩略图、预览、原图预览。"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from ..context import AppContext
from ..errors import ApiError, ErrorCode
from ..issues import record_issue, resolve_issue_prefix
from ..models import Album, Asset, PhotoGroup
from .deps import get_context, get_session, require_photo

router = APIRouter(prefix="/api/photos", tags=["media"])

CACHE_HEADERS = {"Cache-Control": "private, max-age=31536000, immutable"}


def _album(session: Session, group: PhotoGroup) -> Album:
    album = session.get(Album, group.album_id)
    if album is None or album.deleted_at is not None:
        raise ApiError(ErrorCode.ALBUM_NOT_FOUND, "相册不存在。", status_code=404)
    return album


def _select_asset(group: PhotoGroup, asset_id: str | None) -> Asset:
    assets = list(group.assets)
    if asset_id:
        for asset in assets:
            if asset.id == asset_id:
                if asset.presence_status == "missing":
                    raise ApiError(ErrorCode.ASSET_MISSING, "该文件已不存在。", status_code=404)
                return asset
        raise ApiError(ErrorCode.ASSET_NOT_FOUND, "文件不属于该逻辑照片。", status_code=404)
    present = [asset for asset in assets if asset.presence_status != "missing"]
    if not present:
        raise ApiError(ErrorCode.ASSET_MISSING, "该逻辑照片的文件均已缺失。", status_code=404)
    present.sort(key=lambda a: (0 if a.kind == "jpg" else 1, a.relative_path))
    return present[0]


def _fingerprint(asset: Asset, spec: str) -> str:
    return f"{spec}:{asset.id}:{asset.size_bytes}:{asset.mtime_ns}"


def _preview_response(
    context: AppContext,
    session: Session,
    album: Album,
    asset: Asset,
    spec: str,
) -> FileResponse:
    try:
        path, digest, _hit = context.previews.get_or_create(album, asset, spec)
    except ApiError as exc:
        asset.preview_status = "failed"
        asset.preview_error = exc.message
        record_issue(
            session,
            album_id=album.id,
            kind="preview_failure",
            fingerprint=_fingerprint(asset, spec),
            message=exc.message,
            payload={
                "assetId": asset.id,
                "relativePath": asset.relative_path,
                "code": exc.code,
                "detail": exc.details,
            },
            severity="warning",
        )
        session.commit()
        raise
    context.previews.mark_result(asset, ok=True)
    resolve_issue_prefix(session, f"preview:{asset.id}:")
    session.commit()
    headers = {**CACHE_HEADERS, "ETag": f'"{digest}"'}
    return FileResponse(path, media_type="image/jpeg", headers=headers)


@router.get("/{photo_id}/thumbnail")
def thumbnail(
    photo_id: str,
    assetId: str | None = Query(None),
    context: AppContext = Depends(get_context),
    session: Session = Depends(get_session),
) -> FileResponse:
    group = require_photo(session, photo_id)
    album = _album(session, group)
    asset = _select_asset(group, assetId)
    return _preview_response(context, session, album, asset, "thumb")


@router.get("/{photo_id}/preview")
def preview(
    photo_id: str,
    assetId: str | None = Query(None),
    context: AppContext = Depends(get_context),
    session: Session = Depends(get_session),
) -> FileResponse:
    group = require_photo(session, photo_id)
    album = _album(session, group)
    asset = _select_asset(group, assetId)
    return _preview_response(context, session, album, asset, "preview")


@router.get("/{photo_id}/original-preview")
def original_preview(
    photo_id: str,
    assetId: str | None = Query(None),
    context: AppContext = Depends(get_context),
    session: Session = Depends(get_session),
) -> FileResponse:
    group = require_photo(session, photo_id)
    album = _album(session, group)
    asset = _select_asset(group, assetId)
    if asset.kind == "jpg":
        path = context.guard.asset_path(album.relative_path, asset.relative_path, must_exist=True)
        digest = f"original:{asset.id}:{asset.size_bytes}:{asset.mtime_ns}"
        headers = {**CACHE_HEADERS, "ETag": f'"{digest}"'}
        return FileResponse(path, media_type="image/jpeg", headers=headers)
    # RAW-only：以高质量缓存预览作为 100% 查看回退，避免每次重新解码。
    return _preview_response(context, session, album, asset, "preview")
