"""本地访问安全中间件。

- 只接受允许的 Host（防 DNS rebinding）；
- 拒绝跨来源请求（不启用 CORS，写接口额外要求本地会话令牌）；
- 所有写 API 必须携带 X-CSRF-Token，值与本地会话令牌一致；
- 统一安全响应头。
"""

from __future__ import annotations

import hmac
import json

from starlette.datastructures import Headers
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send

MUTATING_METHODS = {"POST", "PUT", "PATCH", "DELETE"}

SECURITY_HEADERS = {
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
    "cross-origin-resource-policy": "same-origin",
}


def _hostname(host_header: str) -> str:
    value = host_header.strip()
    if not value:
        return ""
    if value.startswith("["):
        return value[1:].split("]", 1)[0].lower()
    if value.count(":") == 1:
        return value.rsplit(":", 1)[0].lower()
    return value.lower()


def _error_response(status_code: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(
        {"error": {"code": code, "message": message, "details": {}}},
        status_code=status_code,
        headers={"cache-control": "no-store"},
    )


class LocalSecurityMiddleware:
    def __init__(self, app: ASGIApp, settings) -> None:  # noqa: ANN001
        self.app = app
        self.settings = settings
        self.allowed_hosts = {host.lower() for host in settings.allowed_hosts}
        self.allowed_origins = set(settings.allowed_origins)
        self.session_token = settings.session_token

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        headers = Headers(scope=scope)
        host = _hostname(headers.get("host", ""))
        if host not in self.allowed_hosts:
            response = _error_response(403, "FORBIDDEN_HOST", "仅允许通过本机回环地址访问。")
            await response(scope, receive, send)
            return

        origin = headers.get("origin")
        if origin:
            normalized = origin.rstrip("/")
            if normalized not in self.allowed_origins:
                response = _error_response(403, "FORBIDDEN_ORIGIN", "拒绝跨来源请求。")
                await response(scope, receive, send)
                return

        method = scope.get("method", "GET").upper()
        path = scope.get("path", "")
        if method in MUTATING_METHODS and path.startswith("/api"):
            token = headers.get("x-csrf-token", "")
            if not token or not hmac.compare_digest(token, self.session_token):
                response = _error_response(401, "UNAUTHORIZED", "缺少或无效的本地会话令牌。")
                await response(scope, receive, send)
                return

        async def send_with_headers(message: Message) -> None:
            if message["type"] == "http.response.start":
                raw_headers = list(message.get("headers", []))
                existing = {key.lower() for key, _ in raw_headers}
                for key, value in SECURITY_HEADERS.items():
                    if key.encode() not in existing:
                        raw_headers.append((key.encode(), value.encode()))
                message = {**message, "headers": raw_headers}
            await send(message)

        await self.app(scope, receive, send_with_headers)


def error_payload(code: str, message: str, details: dict | None = None) -> bytes:
    return json.dumps(
        {"error": {"code": code, "message": message, "details": details or {}}},
        ensure_ascii=False,
    ).encode()
