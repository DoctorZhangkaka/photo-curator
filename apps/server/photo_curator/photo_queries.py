"""照片列表查询：组合过滤、稳定排序、游标分页。"""

from __future__ import annotations

import base64
import json
from typing import Any

from sqlalchemy import and_, false, func, or_, select
from sqlalchemy.orm import Session, selectinload

from .constants import (
    PAIRING_CONFLICT,
    PAIRING_MISSING,
    PAIRING_TRASHED,
    PRESENCE_MISSING,
    PRESENCE_PRESENT,
)
from .errors import ApiError, ErrorCode
from .models import Asset, ExportConflict, PhotoGroup
from .serializers import photo_to_dict

VIEWED_FILTERS = {"all", "unseen", "viewed"}
SELECTION_FILTERS = {"all", "unmarked", "selected", "pending_delete"}
FORM_FILTERS = {"all", "jpg_raw", "jpg_only", "raw_only"}
ISSUE_FILTERS = {"all", "pairing_conflict", "missing", "export_conflict"}
SORT_MODES = {"capture", "filename"}
MAX_LIMIT = 500
DEFAULT_LIMIT = 200


def encode_cursor(value: dict[str, Any]) -> str:
    raw = json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def decode_cursor(cursor: str) -> dict[str, Any]:
    try:
        padded = cursor + "=" * (-len(cursor) % 4)
        data = json.loads(base64.urlsafe_b64decode(padded.encode()).decode())
        if not isinstance(data, dict) or "k" not in data or "id" not in data:
            raise ValueError
        return data
    except Exception as exc:  # noqa: BLE001
        raise ApiError(ErrorCode.INVALID_REQUEST, "分页游标无效。", status_code=400) from exc


def export_conflict_paths(session: Session, album_id: str) -> set[str]:
    return set(session.scalars(select(ExportConflict.source_relative_path).where(ExportConflict.album_id == album_id)))


def list_photos(
    session: Session,
    *,
    album_id: str,
    album_name: str,
    viewed: str = "all",
    selection: str = "all",
    form: str = "all",
    issue: str = "all",
    sort: str = "capture",
    cursor: str | None = None,
    limit: int = DEFAULT_LIMIT,
) -> dict[str, Any]:
    if viewed not in VIEWED_FILTERS:
        raise ApiError(ErrorCode.INVALID_REQUEST, "浏览状态过滤值无效。", status_code=400)
    if selection not in SELECTION_FILTERS:
        raise ApiError(ErrorCode.INVALID_REQUEST, "筛选状态过滤值无效。", status_code=400)
    if form not in FORM_FILTERS:
        raise ApiError(ErrorCode.INVALID_REQUEST, "文件形态过滤值无效。", status_code=400)
    if issue not in ISSUE_FILTERS:
        raise ApiError(ErrorCode.INVALID_REQUEST, "异常过滤值无效。", status_code=400)
    if sort not in SORT_MODES:
        raise ApiError(ErrorCode.INVALID_REQUEST, "排序方式无效。", status_code=400)
    limit = max(1, min(int(limit), MAX_LIMIT))

    filters = [
        PhotoGroup.album_id == album_id,
        PhotoGroup.deleted_at.is_(None),
        PhotoGroup.pairing_status != PAIRING_TRASHED,
    ]
    if viewed != "all":
        filters.append(PhotoGroup.viewed_status == viewed)
    if selection != "all":
        filters.append(PhotoGroup.selection_status == selection)

    present_jpg = PhotoGroup.assets.any(and_(Asset.kind == "jpg", Asset.presence_status == PRESENCE_PRESENT))
    present_raw = PhotoGroup.assets.any(and_(Asset.kind == "raw", Asset.presence_status == PRESENCE_PRESENT))
    if form == "jpg_raw":
        filters.append(present_jpg)
        filters.append(present_raw)
    elif form == "jpg_only":
        filters.append(present_jpg)
        filters.append(~present_raw)
    elif form == "raw_only":
        filters.append(~present_jpg)
        filters.append(present_raw)

    if issue == "pairing_conflict":
        filters.append(PhotoGroup.pairing_status == PAIRING_CONFLICT)
    elif issue == "missing":
        filters.append(
            or_(
                PhotoGroup.pairing_status == PAIRING_MISSING,
                PhotoGroup.assets.any(Asset.presence_status == PRESENCE_MISSING),
            )
        )
    elif issue == "export_conflict":
        paths = export_conflict_paths(session, album_id)
        filters.append(PhotoGroup.assets.any(Asset.relative_path.in_(paths)) if paths else false())

    total = int(session.scalar(select(func.count()).select_from(PhotoGroup).where(*filters)) or 0)

    key_column = PhotoGroup.sort_key if sort == "capture" else PhotoGroup.natural_key
    query_conditions = list(filters)
    cursor_data = decode_cursor(cursor) if cursor else None
    if cursor_data is not None:
        if cursor_data.get("sort") and cursor_data["sort"] != sort:
            raise ApiError(ErrorCode.INVALID_REQUEST, "分页游标与排序方式不匹配。", status_code=400)
        cursor_key = str(cursor_data["k"])
        cursor_id = str(cursor_data["id"])
        query_conditions.append(
            or_(
                key_column > cursor_key,
                and_(key_column == cursor_key, PhotoGroup.id > cursor_id),
            )
        )

    query = (
        select(PhotoGroup)
        .options(selectinload(PhotoGroup.assets))
        .where(*query_conditions)
        .order_by(key_column.asc(), PhotoGroup.id.asc())
        .limit(limit + 1)
    )
    groups = list(session.scalars(query))
    has_more = len(groups) > limit
    groups = groups[:limit]
    conflict_paths = export_conflict_paths(session, album_id)
    items = [photo_to_dict(group, export_conflict_paths=conflict_paths, album_name=album_name) for group in groups]
    next_cursor = None
    if has_more and groups:
        last = groups[-1]
        next_cursor = encode_cursor(
            {
                "k": last.sort_key if sort == "capture" else last.natural_key,
                "id": last.id,
                "sort": sort,
            }
        )
    return {
        "items": items,
        "nextCursor": next_cursor,
        "total": total,
        "sort": sort,
        "limit": limit,
    }
