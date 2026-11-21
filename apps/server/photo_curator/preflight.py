"""短期预检令牌：服务端哈希存储，防伪造、防过期、防重复使用。"""

from __future__ import annotations

import hashlib
import json
import secrets

from sqlalchemy import update
from sqlalchemy.orm import Session

from .constants import PREFLIGHT_CLEANUP, PREFLIGHT_EXPORT
from .errors import ApiError, ErrorCode
from .models import PreflightToken
from .natural import is_expired, iso_after, utcnow_iso


def _hash_token(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()


def issue_preflight(
    session: Session,
    *,
    album_id: str,
    kind: str,
    operation_id: str,
    payload: dict,
    ttl_seconds: int,
) -> tuple[str, str]:
    if kind not in {PREFLIGHT_CLEANUP, PREFLIGHT_EXPORT}:
        raise ValueError(f"unknown preflight kind: {kind}")
    raw = secrets.token_urlsafe(32)
    expires_at = iso_after(ttl_seconds)
    token = PreflightToken(
        token_hash=_hash_token(raw),
        album_id=album_id,
        kind=kind,
        operation_id=operation_id,
        payload_json=json.dumps(payload, ensure_ascii=False, sort_keys=True),
        expires_at=expires_at,
    )
    session.add(token)
    session.commit()
    return raw, expires_at


def load_preflight(session: Session, *, raw_token: str, kind: str, album_id: str) -> PreflightToken:
    if not raw_token:
        raise ApiError(ErrorCode.PREFLIGHT_INVALID, "缺少预检令牌，请重新预检。", status_code=400)
    token = session.query(PreflightToken).filter_by(token_hash=_hash_token(raw_token)).first()
    if token is None:
        raise ApiError(ErrorCode.PREFLIGHT_INVALID, "预检令牌无效，请重新预检。", status_code=400)
    if token.kind != kind or token.album_id != album_id:
        raise ApiError(ErrorCode.PREFLIGHT_INVALID, "预检令牌与当前操作不匹配。", status_code=400)
    if token.used_at is not None:
        raise ApiError(ErrorCode.PREFLIGHT_CONSUMED, "该预检已执行过，请重新预检。", status_code=409)
    if is_expired(token.expires_at):
        raise ApiError(ErrorCode.PREFLIGHT_EXPIRED, "预检已过期，请重新预检。", status_code=410)
    return token


def consume_preflight(session: Session, token: PreflightToken) -> None:
    result = session.execute(
        update(PreflightToken)
        .where(PreflightToken.id == token.id, PreflightToken.used_at.is_(None))
        .values(used_at=utcnow_iso())
    )
    if result.rowcount != 1:
        raise ApiError(ErrorCode.PREFLIGHT_CONSUMED, "该预检已被其他窗口执行，请重新预检。", status_code=409)
