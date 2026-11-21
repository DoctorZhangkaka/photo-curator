"""统一错误结构。

响应体：{"error": {"code": "...", "message": "中文可读摘要", "details": {...}}}
message 面向用户，details 供排查；两者都不得包含会话令牌。
"""

from __future__ import annotations

from typing import Any


class ErrorCode:
    ALBUM_NOT_FOUND = "ALBUM_NOT_FOUND"
    PHOTO_NOT_FOUND = "PHOTO_NOT_FOUND"
    ASSET_NOT_FOUND = "ASSET_NOT_FOUND"
    OPERATION_NOT_FOUND = "OPERATION_NOT_FOUND"
    JOB_NOT_FOUND = "JOB_NOT_FOUND"
    STALE_VERSION = "STALE_VERSION"
    PREFLIGHT_EXPIRED = "PREFLIGHT_EXPIRED"
    PREFLIGHT_INVALID = "PREFLIGHT_INVALID"
    PREFLIGHT_BLOCKED = "PREFLIGHT_BLOCKED"
    PREFLIGHT_CONSUMED = "PREFLIGHT_CONSUMED"
    SOURCE_CHANGED = "SOURCE_CHANGED"
    PAIRING_CONFLICT = "PAIRING_CONFLICT"
    ASSET_MISSING = "ASSET_MISSING"
    DESTINATION_CONFLICT = "DESTINATION_CONFLICT"
    PATH_OUTSIDE_ROOT = "PATH_OUTSIDE_ROOT"
    UNSUPPORTED_FILE_TYPE = "UNSUPPORTED_FILE_TYPE"
    TRASH_OPERATION_FAILED = "TRASH_OPERATION_FAILED"
    ROLLBACK_FAILED = "ROLLBACK_FAILED"
    RESTORE_FAILED = "RESTORE_FAILED"
    RAW_PREVIEW_UNAVAILABLE = "RAW_PREVIEW_UNAVAILABLE"
    PREVIEW_FAILED = "PREVIEW_FAILED"
    DEPENDENCY_UNAVAILABLE = "DEPENDENCY_UNAVAILABLE"
    INVALID_REQUEST = "INVALID_REQUEST"
    UNAUTHORIZED = "UNAUTHORIZED"
    FORBIDDEN_ORIGIN = "FORBIDDEN_ORIGIN"
    FORBIDDEN_HOST = "FORBIDDEN_HOST"
    SCAN_IN_PROGRESS = "SCAN_IN_PROGRESS"
    INTERNAL_ERROR = "INTERNAL_ERROR"
    NOT_FOUND = "NOT_FOUND"


class ApiError(Exception):
    def __init__(
        self,
        code: str,
        message: str,
        *,
        status_code: int = 400,
        details: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code
        self.details = details or {}
        self.headers = headers or {}
