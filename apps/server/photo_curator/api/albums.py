"""相册库、相册详情、重新扫描与 SSE 事件。"""

from __future__ import annotations

import asyncio
import json
from typing import Any

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..constants import SCAN_FAILED
from ..context import AppContext
from ..errors import ApiError, ErrorCode
from ..models import Album
from ..natural import utcnow_iso
from ..scanning import stats_for_albums
from ..serializers import album_to_dict
from .deps import get_context, get_session, require_album

router = APIRouter(prefix="/api/albums", tags=["albums"])


def _list_album_dicts(session: Session, context: AppContext, *, sort: str = "name") -> list[dict[str, Any]]:
    albums = list(session.scalars(select(Album).where(Album.deleted_at.is_(None)).order_by(Album.name.asc())))
    stats = stats_for_albums(session, [album.id for album in albums])
    payload = [
        album_to_dict(
            album,
            stats.get(
                album.id,
                {
                    "total": 0,
                    "viewed": 0,
                    "unseen": 0,
                    "selected": 0,
                    "pendingDelete": 0,
                    "missing": 0,
                    "conflicts": 0,
                },
            ),
        )
        for album in albums
    ]
    if sort == "recent":
        payload.sort(
            key=lambda item: (item.get("lastOpenedAt") or item.get("lastScannedAt") or "", item["name"]),
            reverse=True,
        )
    elif sort == "name":
        payload.sort(key=lambda item: item["name"])
    else:
        raise ApiError(ErrorCode.INVALID_REQUEST, "排序方式无效，仅支持 name 或 recent。", status_code=400)
    return payload


@router.get("")
def list_albums(
    sort: str = Query("name"),
    context: AppContext = Depends(get_context),
    session: Session = Depends(get_session),
) -> dict:
    # 每次进入相册库都做一次轻量目录发现，Finder 中新建的一级目录无需重启即可出现。
    discovery = context.scan.discover(session)
    return {
        "albums": _list_album_dicts(session, context, sort=sort),
        "photoRoot": str(context.settings.photo_root),
        "exportDirName": context.settings.export_dir_name,
        "discovery": discovery,
    }


@router.post("/rescan")
def rescan_all(context: AppContext = Depends(get_context)) -> dict:
    outcomes = context.scan.scan_all(trigger="manual")
    context.events.publish("library", "library_rescanned", {"albums": len(outcomes)})
    session = context.database.session()
    try:
        albums = _list_album_dicts(session, context, sort="name")
    finally:
        session.close()
    return {
        "outcomes": [outcome.to_dict() for outcome in outcomes],
        "albums": albums,
        "failed": sum(1 for outcome in outcomes if outcome.error),
    }


@router.get("/{album_id}")
def album_detail(
    album_id: str,
    context: AppContext = Depends(get_context),
    session: Session = Depends(get_session),
) -> dict:
    album = require_album(session, album_id)
    album.last_opened_at = utcnow_iso()
    session.commit()
    stats = stats_for_albums(session, [album.id]).get(album.id, {})
    try:
        album_dir = context.guard.album_dir(album.relative_path, must_exist=True)
        context.watcher.watch_album(album.id, album_dir)
    except ApiError:
        pass
    return {
        "album": album_to_dict(album, stats),
        "photoRoot": str(context.settings.photo_root),
        "exportDirName": context.settings.export_dir_name,
    }


@router.post("/{album_id}/rescan")
def rescan_album(
    album_id: str,
    context: AppContext = Depends(get_context),
    session: Session = Depends(get_session),
) -> dict:
    album = require_album(session, album_id)
    outcome = context.scan.scan_album(album.id, trigger="manual")
    if outcome is None:
        raise ApiError(ErrorCode.ALBUM_NOT_FOUND, "相册不存在。", status_code=404)
    session.expire_all()
    album = require_album(session, album_id)
    stats = stats_for_albums(session, [album.id]).get(album.id, {})
    if outcome.error:
        album.scan_status = SCAN_FAILED
    return {
        "album": album_to_dict(album, stats),
        "report": outcome.report,
        "counts": outcome.counts,
        "error": outcome.error,
    }


@router.get("/{album_id}/events")
async def album_events(
    album_id: str,
    request: Request,
    context: AppContext = Depends(get_context),
) -> StreamingResponse:
    session = context.database.session()
    try:
        require_album(session, album_id)
    finally:
        session.close()
    queue = context.events.subscribe(album_id)

    async def generator():
        yield "retry: 2000\n\n"
        try:
            while True:
                if await request.is_disconnected():
                    break
                try:
                    message = await asyncio.wait_for(queue.get(), timeout=15)
                except TimeoutError:
                    yield ": keep-alive\n\n"
                    continue
                yield f"data: {message}\n\n"
        finally:
            context.events.unsubscribe(album_id, queue)

    return StreamingResponse(
        generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-store",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.get("/{album_id}/scan-report")
def scan_report(
    album_id: str,
    context: AppContext = Depends(get_context),
    session: Session = Depends(get_session),
) -> dict:
    album = require_album(session, album_id)
    report = json.loads(album.scan_report_json) if album.scan_report_json else None
    return {"albumId": album.id, "scanStatus": album.scan_status, "scanError": album.scan_error, "report": report}
