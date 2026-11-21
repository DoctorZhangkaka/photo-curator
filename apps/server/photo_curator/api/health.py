"""健康检查、配置与会话令牌端点。"""

from __future__ import annotations

import os
import shutil
import sys

from fastapi import APIRouter, Depends, Response
from sqlalchemy import text
from sqlalchemy.orm import Session

from .. import __version__
from ..config import Settings
from ..context import AppContext
from ..metadata import exiftool_available, exiftool_version
from ..models import Setting
from .deps import get_context, get_session

router = APIRouter(prefix="/api", tags=["system"])


def _rawpy_capability() -> dict:
    try:
        import rawpy

        return {
            "available": True,
            "backend": "rawpy/LibRaw",
            "version": getattr(rawpy, "__version__", "unknown"),
            "librawVersion": ".".join(str(part) for part in getattr(rawpy, "libraw_version", ())) or None,
        }
    except Exception as exc:  # noqa: BLE001
        return {"available": False, "backend": "rawpy/LibRaw", "reason": str(exc)[:300]}


@router.get("/health")
def health(
    context: AppContext = Depends(get_context),
    session: Session = Depends(get_session),
) -> dict:
    settings: Settings = context.settings
    database_ok = True
    database_error = None
    try:
        session.execute(text("SELECT 1"))
    except Exception as exc:  # noqa: BLE001
        database_ok = False
        database_error = str(exc)[:300]

    root = settings.photo_root
    root_exists = root.is_dir()
    root_readable = root_exists and os.access(root, os.R_OK)
    root_writable = root_exists and os.access(root, os.W_OK)
    export_root = settings.export_root
    export_creatable = False
    export_reason = None
    if export_root.exists():
        export_creatable = export_root.is_dir() and os.access(export_root, os.W_OK) and not export_root.is_symlink()
        if not export_creatable:
            export_reason = "精选目录存在但不可写或不是普通目录。"
    elif root_writable:
        export_creatable = True
    else:
        export_reason = "照片根目录不可写，无法创建精选目录。"

    exiftool = {
        "available": exiftool_available(settings.exiftool_path),
        "path": settings.exiftool_path,
        "version": exiftool_version(settings.exiftool_path),
    }
    trash = context.trash.capabilities()
    rawpy = _rawpy_capability()
    disk = None
    try:
        usage = shutil.disk_usage(root if root_exists else settings.data_dir)
        disk = {
            "totalBytes": usage.total,
            "freeBytes": usage.free,
        }
    except OSError:
        disk = None

    status = "ok"
    if not database_ok or not root_exists or not root_readable or not rawpy["available"] or not trash["available"]:
        status = "degraded"
    if not database_ok:
        status = "error"

    return {
        "status": status,
        "version": __version__,
        "platform": sys.platform,
        "python": sys.version.split()[0],
        "database": {
            "ok": database_ok,
            "error": database_error,
            "path": str(settings.db_path),
        },
        "photoRoot": {
            "path": str(root),
            "exists": root_exists,
            "readable": root_readable,
            "writable": root_writable,
        },
        "exportDirectory": {
            "path": str(export_root),
            "creatable": export_creatable,
            "reason": export_reason,
        },
        "dependencies": {
            "exiftool": exiftool,
            "rawpy": rawpy,
            "trash": trash,
            "watchdog": {"available": True},
        },
        "disk": disk,
    }


@router.get("/config")
def config(context: AppContext = Depends(get_context), session: Session = Depends(get_session)) -> dict:
    settings = context.settings
    stored = {row.key: row.value for row in session.query(Setting).all()}
    return {
        "appVersion": __version__,
        "photoRoot": str(settings.photo_root),
        "exportDirName": settings.export_dir_name,
        "exportRoot": str(settings.export_root),
        "dataDir": str(settings.data_dir),
        "apiBase": "/api",
        "supportedFormats": {
            "jpg": [".jpg", ".jpeg"],
            "raw": [".raf", ".arw", ".dng"],
        },
        "features": {
            "trash": context.trash.available,
            "rawPreview": _rawpy_capability()["available"],
            "exiftool": exiftool_available(settings.exiftool_path),
            "watch": True,
            "sse": True,
        },
        "defaults": {
            "sort": stored.get("default_sort", "capture"),
            "autoplayInterval": int(stored.get("autoplay_interval", "3") or 3),
            "cleanupNoticeSeen": stored.get("cleanup_notice_seen", "0") == "1",
        },
        "thumbnailEdge": settings.thumbnail_edge,
        "previewEdge": settings.preview_edge,
    }


@router.get("/session")
def session_token(response: Response, context: AppContext = Depends(get_context)) -> dict:
    response.headers["Cache-Control"] = "no-store"
    # 令牌仅在本地同源请求中返回；写接口必须回传 X-CSRF-Token。
    return {"token": context.settings.session_token}
